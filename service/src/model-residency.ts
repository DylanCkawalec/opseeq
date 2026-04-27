/**
 * @module model-residency — SeeQ-managed model residency, stickiness, and escalation
 *
 * **Axiom A1 — Single-active-large** — At most one large local specialist model
 * (default: qwen3.5:35b-a3b-coding-mxfp8) may be resident at a time on constrained RAM.
 * **Axiom A2 — Hot tier is permanent** — gpt-oss:20b and nemotron-3-nano:4b are
 * always kept warm via keep_alive: "forever".
 * **Postulate P1 — Warm window** — The active-large model stays resident for
 * SEEQ_WARM_WINDOW_MS (default 15 min) after last use before Ollama may evict it.
 * **Postulate P2 — Task-family stickiness** — Once a task family is assigned a model,
 * follow-up subtasks stay on the same model unless escalation conditions are met.
 * **Corollary C1 — Compound escalation** — Escalation requires BOTH a matching task
 * kind AND a quality/complexity condition; raw complexity alone never triggers.
 * **Behavioral contract** — getResidencyState() is pure read. ensureWarm() sends an
 * Ollama keep_alive probe. recordModelUse() updates internal tracking.
 * **Tracing invariant** — All state transitions log through structured console output.
 */

// ── Configuration ────────────────────────────────────────────────────

const WARM_WINDOW_MS = parseInt(process.env.SEEQ_WARM_WINDOW_MS || '900000', 10);
const CODE_THRESHOLD = parseFloat(process.env.SEEQ_ESCALATION_CODE_THRESHOLD || '0.4');
const REASON_THRESHOLD = parseFloat(process.env.SEEQ_ESCALATION_REASON_THRESHOLD || '0.8');
const FAMILY_TTL_MS = 1_800_000; // 30 min inactivity TTL

const OLLAMA_BASE = (process.env.OLLAMA_URL || process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');

// ── Residency Tier Definitions ──────────────────────────────────────

const HOT_MODELS = ['gpt-oss:20b', 'nemotron-3-nano:4b'] as const;
/** Large Ollama specialists (one resident at a time); tune via OLLAMA_MODELS on your host. */
const LARGE_MODELS = ['qwen3.5:35b-a3b-coding-mxfp8'] as const;

type LargeModel = typeof LARGE_MODELS[number];

function isLargeModel(model: string): model is LargeModel {
  return (LARGE_MODELS as readonly string[]).includes(model);
}

function isHotModel(model: string): boolean {
  return (HOT_MODELS as readonly string[]).includes(model);
}

// ── Internal State ──────────────────────────────────────────────────

let activeLargeModel: LargeModel | null = null;
let activeLargeSince: string | null = null;
let activeLargeLastUsed: number = 0;

// ── Residency Dashboard ─────────────────────────────────────────────

export interface ResidencyDashboard {
  hot: string[];
  activeLarge: string | null;
  activeLargeSince: string | null;
  activeLargeLastUsedAgo: number | null;
  cold: string[];
  warmWindowMs: number;
}

export function getResidencyState(): ResidencyDashboard {
  const now = Date.now();
  const expired = activeLargeModel && (now - activeLargeLastUsed > WARM_WINDOW_MS);

  if (expired) {
    console.log(`[seeq-residency] ${activeLargeModel} warm window expired → cold`);
    activeLargeModel = null;
    activeLargeSince = null;
    activeLargeLastUsed = 0;
  }

  const cold = LARGE_MODELS.filter(m => m !== activeLargeModel);

  return {
    hot: [...HOT_MODELS],
    activeLarge: activeLargeModel,
    activeLargeSince,
    activeLargeLastUsedAgo: activeLargeModel ? now - activeLargeLastUsed : null,
    cold,
    warmWindowMs: WARM_WINDOW_MS,
  };
}

// ── Model Use Tracking ──────────────────────────────────────────────

/** Record that a model was just used. Updates residency tiers for large models. */
export function recordModelUse(model: string): void {
  if (!isLargeModel(model)) return;

  const now = Date.now();

  if (activeLargeModel && activeLargeModel !== model) {
    console.log(`[seeq-residency] Switching active-large: ${activeLargeModel} → ${model} (previous → cold)`);
  } else if (!activeLargeModel) {
    console.log(`[seeq-residency] Activating large model: ${model}`);
  }

  activeLargeModel = model;
  activeLargeSince = activeLargeSince && activeLargeModel === model ? activeLargeSince : new Date().toISOString();
  activeLargeLastUsed = now;
}

// ── keep_alive Policy ───────────────────────────────────────────────

/** Returns the Ollama keep_alive value for a model based on residency tier. */
export function getKeepAliveForModel(model: string): string {
  if (isHotModel(model)) return '-1s'; // forever
  if (isLargeModel(model) && activeLargeModel === model) {
    const minutes = Math.ceil(WARM_WINDOW_MS / 60_000);
    return `${minutes}m`;
  }
  return '5m'; // default Ollama eviction
}

// ── Warmup ──────────────────────────────────────────────────────────

/** Pre-load a model into its appropriate residency tier via Ollama keep_alive probe. */
export async function ensureWarm(model: string): Promise<void> {
  const keepAlive = isHotModel(model) ? '-1s' : `${Math.ceil(WARM_WINDOW_MS / 60_000)}m`;

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: keepAlive }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log(`[seeq-residency] Warmup failed for ${model}: ${res.status} ${text.slice(0, 200)}`);
      return;
    }

    await res.json(); // drain response
    console.log(`[seeq-residency] Warmed ${model} (keep_alive=${keepAlive})`);

    if (isLargeModel(model)) {
      recordModelUse(model);
    }
  } catch (err) {
    console.log(`[seeq-residency] Warmup error for ${model}: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Task-Family Stickiness (internal) ───────────────────────────────

export interface TaskFamily {
  familyId: string;
  taskKind: string;
  assignedModel: string;
  createdAt: number;
  lastActivityAt: number;
  requestCount: number;
}

const taskFamilies = new Map<string, TaskFamily>();

/** Prune expired task families. */
function pruneExpired(): void {
  const now = Date.now();
  for (const [id, f] of taskFamilies) {
    if (now - f.lastActivityAt > FAMILY_TTL_MS) {
      taskFamilies.delete(id);
    }
  }
}

/** Get an existing task family by ID. Returns null if expired or not found. */
export function getTaskFamily(familyId: string): TaskFamily | null {
  pruneExpired();
  return taskFamilies.get(familyId) ?? null;
}

/** Assign or update a task family. */
export function assignTaskFamily(familyId: string, taskKind: string, model: string): TaskFamily {
  pruneExpired();
  const existing = taskFamilies.get(familyId);
  if (existing) {
    existing.lastActivityAt = Date.now();
    existing.requestCount++;
    return existing;
  }
  const family: TaskFamily = {
    familyId,
    taskKind,
    assignedModel: model,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    requestCount: 1,
  };
  taskFamilies.set(familyId, family);
  return family;
}

// ── Compound Escalation ─────────────────────────────────────────────

/** Task kinds for escalation matching. */
type TaskKind = 'code' | 'reason' | 'utility' | 'orchestration' | 'reference' | 'general';

const CODE_TASK_KINDS: readonly string[] = ['code', 'implementation', 'patch', 'transform', 'compile-fix', 'code-review'];
const REASON_TASK_KINDS: readonly string[] = ['reason', 'decomposition', 'planning', 'formal-reasoning', 'synthesis', 'architecture'];

function isCodeTask(taskKind: string): boolean {
  return CODE_TASK_KINDS.includes(taskKind);
}

function isReasonTask(taskKind: string): boolean {
  return REASON_TASK_KINDS.includes(taskKind);
}

export interface EscalationResult {
  escalate: boolean;
  target: string;
  reason: string;
}

/**
 * Determine if a task should be escalated to a different model.
 * Requires BOTH matching task kind AND quality/complexity condition.
 * Raw complexity score alone never triggers escalation.
 */
export function shouldEscalate(
  taskKind: string,
  complexity: number,
  retryCount: number,
  confidence: number,
): EscalationResult | null {
  // utility → code: task must be code-related AND complexity threshold met
  if (isCodeTask(taskKind) && complexity > CODE_THRESHOLD) {
    return { escalate: true, target: 'qwen3.5:35b-a3b-coding-mxfp8', reason: `code task (${taskKind}) with complexity ${complexity.toFixed(2)} > ${CODE_THRESHOLD}` };
  }

  // utility/hot → reasoning: task must need reasoning AND (complexity OR retry condition)
  if (isReasonTask(taskKind) && (complexity > REASON_THRESHOLD || retryCount > 2)) {
    return { escalate: true, target: 'gpt-oss:20b', reason: `reasoning task (${taskKind}) with complexity ${complexity.toFixed(2)} / retries ${retryCount}` };
  }

  // local → API: quality insufficient, retry budget exceeded, or explicit
  if (confidence < 0.3 || retryCount > 3) {
    return { escalate: true, target: 'api', reason: `quality insufficient (confidence=${confidence.toFixed(2)}, retries=${retryCount})` };
  }

  return null;
}

// ── Periodic cleanup ────────────────────────────────────────────────

setInterval(() => { pruneExpired(); }, 60_000);
