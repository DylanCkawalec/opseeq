// @service/src/ooda-primitives.ts
/**
 * @module ooda-primitives
 *
 * ## Role
 * Pure construction of an **OODA-shaped** planning artifact (Observe → Orient → Decide → Act) for
 * Opseeq Precision Orchestration: ranked candidate actions, risk copy, and a permission envelope.
 * No I/O, no mutation of external state; `buildOodaCycle` is referentially transparent aside from
 * default `taskId` generation when omitted (time-based).
 *
 * ## Alignment (Opseeq-wide)
 * - **Precision Orchestration**: Outputs feed `mermate-lucidity-ooda` and console dashboards; stages
 *   remain declarative until an external executor runs them.
 * - **Living Architecture Graph**: Referenced in plan copy; this module does not write graph nodes.
 * - **Mermate pipeline**: Plan steps name Mermate/Lucidity/TLA/TS/Rust ordering; service calls happen
 *   elsewhere.
 * - **General-Clawd / Windsurf**: `processScope` lists typical local automation surfaces; subagent
 *   delegation is not invoked here.
 *
 * -------------------------------------------------------------------------------------------------
 * ### Formal vocabulary (operational)
 *
 * **Axiom A7 — OODA as control template**
 * The artifact is structured as a decision loop: unknowns (Observe), plan strings (Orient), ranked
 * actions (Decide), `PermissionEnvelope` (Act gate).
 *
 * **Postulate P6 — Linear scalar score**
 * Each `RankedAction` carries independent dimension ratings in `[0, 5]`; a single `score` orders
 * candidates using fixed weights (see `computeRankedActionScore`).
 *
 * **Corollary C5 — Single-envelope recommendation**
 * The top-ranked action after sorting drives `permission.commands`, `fileScope`, and `networkScope`;
 * `processScope` and `destructive` are policy fields not derived from the winner’s dimensions.
 *
 * **Lemma L2 — Hash stability**
 * `planHash` is `sha256:` + hex of `JSON.stringify` of a plain object; key order follows insertion.
 * Changing any nested string or number changes the hash.
 *
 * @packageDocumentation
 */

import crypto from 'node:crypto';

// ── Scoring contract (explicit weights; do not change without updating consumers/tests) ────────

/** Inclusive bounds for dimension inputs before weighting. */
export const RANK_DIMENSION_MIN = 0;
export const RANK_DIMENSION_MAX = 5;

/**
 * Weighted linear model over clamped dimensions:
 * `score = wS·security + wV·velocity + wC·creativity - wR·risk`, then rounded to 2 decimal places.
 *
 * Coefficients sum to 1.0 for the additive terms; risk is subtractive with separate magnitude.
 */
export const SCORE_WEIGHTS = {
  security: 0.4,
  velocity: 0.35,
  creativity: 0.25,
  riskPenalty: 0.5,
} as const;

// ── Domain types ──────────────────────────────────────────────────────────────────────────────

export interface KeyUnknown {
  question: string;
  assumption: string;
  /** When true, the plan should not proceed to effectful execution without resolving this unknown. */
  blocking: boolean;
}

export interface RankedAction {
  id: string;
  label: string;
  category: 'velocity' | 'security' | 'creativity';
  description: string;
  /** All in `[RANK_DIMENSION_MIN, RANK_DIMENSION_MAX]` before scoring; enforced at construction time in this module. */
  velocity: number;
  security: number;
  creativity: number;
  /** Higher values penalize the final score. */
  risk: number;
  /** Derived; see `computeRankedActionScore`. */
  score: number;
  commands: string[];
  fileScope: string[];
  networkScope: string[];
}

export interface PermissionEnvelope {
  requiresApproval: boolean;
  summary: string;
  commands: string[];
  fileScope: string[];
  networkScope: string[];
  processScope: string[];
  destructive: boolean;
}

export interface OodaCycle {
  taskId: string;
  keyUnknowns: KeyUnknown[];
  detailedPlan: string[];
  rankedActions: RankedAction[];
  riskAssessment: Record<string, string>;
  permission: PermissionEnvelope;
  /** Content-addressed fingerprint of the plan payload (not a Merkle tree). */
  planHash: string;
}

export interface BuildOodaCycleInput {
  taskId?: string;
  /** Carried for API compatibility; may inform future plan text but is not required for current outputs. */
  intent: string;
  repoPath?: string | null;
  appId?: string | null;
  primaryModel: string;
  allowRemoteAugmentation: boolean;
}

// ── Hashing ───────────────────────────────────────────────────────────────────────────────────

/**
 * Stable SHA-256 digest over `JSON.stringify(value)`.
 *
 * **Precondition:** `value` must be JSON-serializable (no BigInt, Symbol, or circular refs).
 * **Postcondition:** Return value always matches `/^sha256:[a-f0-9]{64}$/`.
 */
function hashPlan(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

// ── Scoring ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Clamps a numeric dimension to `[RANK_DIMENSION_MIN, RANK_DIMENSION_MAX]`.
 */
function clampScore(value: number): number {
  return Math.max(RANK_DIMENSION_MIN, Math.min(RANK_DIMENSION_MAX, value));
}

/**
 * Weighted score for one action (same formula as historical implementation).
 *
 * **Invariant:** Result equals `Math.round(raw * 100) / 100` where `raw` applies `SCORE_WEIGHTS` to
 * the numeric fields as supplied. Default candidates from `buildOodaCycle` clamp dimensions first;
 * arbitrary inputs to `rankActions` are not clamped here.
 */
export function computeRankedActionScore(action: Omit<RankedAction, 'score'>): number {
  const raw =
    SCORE_WEIGHTS.security * action.security +
    SCORE_WEIGHTS.velocity * action.velocity +
    SCORE_WEIGHTS.creativity * action.creativity -
    SCORE_WEIGHTS.riskPenalty * action.risk;
  return Math.round(raw * 100) / 100;
}

/**
 * Attaches `score` to each action and sorts **descending** by `score` (ties preserve array-stable order
 * only as guaranteed by the engine’s sort; for stable tie-breaking, callers should not rely on order
 * when scores are equal).
 *
 * **Postcondition:** Output length equals input length; every `score` is computed via `computeRankedActionScore`.
 */
export function rankActions(actions: Array<Omit<RankedAction, 'score'>>): RankedAction[] {
  return actions
    .map((action) => ({ ...action, score: computeRankedActionScore(action) }))
    .sort((left, right) => right.score - left.score);
}

// ── Default cycle content (static templates; deterministic aside from interpolated inputs) ─────

const DEFAULT_PROCESS_SCOPE = ['tmux', 'iTerm2', 'general-clawd'] as const;

function buildKeyUnknowns(): KeyUnknown[] {
  return [
    {
      question: 'Is the runnable Mermate service online and able to execute MAX-mode render and downstream TLA+/TS/Rust stages?',
      assumption: 'If unavailable, Opseeq will still produce a full plan and execution envelope without live render output.',
      blocking: false,
    },
    {
      question: 'Does Lucidity have the exact artifacts needed for semantic/image cleanup, or must Opseeq stage them first?',
      assumption: 'Lucidity review artifacts will be staged by Opseeq when not already present.',
      blocking: false,
    },
    {
      question: 'Has the human approved the full compile chain through Rust binary and macOS app packaging?',
      assumption: 'Execution stays at planning and artifact generation until the approval gate is explicitly satisfied.',
      blocking: true,
    },
  ];
}

function buildDetailedPlan(input: BuildOodaCycleInput): string[] {
  return [
    `Observe the repo scope${input.repoPath ? ` at ${input.repoPath}` : ''}, selected app${input.appId ? ` (${input.appId})` : ''}, and current local model posture (${input.primaryModel}).`,
    'Orient with a local gpt-oss:20b-first assessment and map the intent into the repeatable Mermate -> Lucidity -> Approval -> TLA+ -> TypeScript -> Rust -> .app pipeline.',
    'Generate ranked action paths and a scoped permission envelope before any effectful operation.',
    'If approved, run the stage chain under full temporal causality and immutable artifact logging.',
    'Conclude with self-reflective meta-critique, graph versioning, and rollback artifacts.',
  ];
}

function buildCandidateActions(input: BuildOodaCycleInput): Array<Omit<RankedAction, 'score'>> {
  const repoFiles = input.repoPath ? [input.repoPath] : [];
  const creativityRisk = input.allowRemoteAugmentation ? clampScore(2.4) : clampScore(1.8);

  return [
    {
      id: 'velocity-local-assessment',
      label: 'Velocity-first local assessment',
      category: 'velocity',
      description: 'Use gpt-oss:20b locally to assess the idea, produce the Living Graph, and defer compile stages until approval.',
      velocity: clampScore(4.8),
      security: clampScore(4.4),
      creativity: clampScore(3.8),
      risk: clampScore(1.2),
      commands: [],
      fileScope: repoFiles,
      networkScope: [],
    },
    {
      id: 'security-review-first',
      label: 'Security-first gated architecture review',
      category: 'security',
      description: 'Keep the flow read-only through Mermate/Lucidity planning, request approval, then compile only after explicit confirmation.',
      velocity: clampScore(3.4),
      security: clampScore(5),
      creativity: clampScore(4.1),
      risk: clampScore(0.8),
      commands: [],
      fileScope: repoFiles,
      networkScope: [],
    },
    {
      id: 'creativity-full-precision',
      label: 'Creativity-first full Precision Orchestration chain',
      category: 'creativity',
      description: 'Drive MAX-mode Mermate architecture generation, Lucidity cleanup, and the full TLA+/TS/Rust path in one orchestrated cycle.',
      velocity: clampScore(3.9),
      security: clampScore(3.6),
      creativity: clampScore(5),
      risk: creativityRisk,
      commands: ['mermate render', 'mermate tla', 'mermate ts', 'mermate rust'],
      fileScope: repoFiles,
      networkScope: input.allowRemoteAugmentation ? ['https://api.anthropic.com/*'] : [],
    },
  ];
}

function buildRiskAssessment(input: BuildOodaCycleInput): Record<string, string> {
  return {
    malware: 'Deny-and-ask stays active. Persistence vectors and unauthorized egress remain blocked.',
    dataDeletion: 'No destructive operations are included in the recommended path. Rollback artifacts are mandatory before writes.',
    privacy: input.allowRemoteAugmentation
      ? 'Remote augmentation is possible but out-of-trust and must be explicitly approved.'
      : 'All planning and critique remain local by default.',
    credentialExposure: 'Secrets are redacted in logs and never surfaced as plain-text approval context.',
    runtimeInstability: 'The MAX render and full compile chain can fail if Mermate is offline; the flow degrades to planning artifacts.',
    rollback: 'Every effectful stage requires an immutable artifact and rollback manifest.',
  };
}

/**
 * Builds a complete OODA cycle record for Precision Orchestration.
 *
 * **Preconditions:** `primaryModel` and `allowRemoteAugmentation` must be supplied; `intent` is accepted
 * for forward compatibility.
 *
 * **Postconditions:**
 * - `taskId` is `input.taskId` or a `task-` + base36 timestamp id.
 * - `rankedActions` is sorted by descending `score`; `permission` inherits commands and scopes from
 *   the highest-scoring action only.
 * - `planHash` covers `keyUnknowns`, `detailedPlan`, `rankedActions`, `riskAssessment`, and `permission`.
 *
 * **Side effects:** None (pure). **Non-determinism:** default `taskId` when omitted uses `Date.now()`.
 *
 * **Failure modes:** Throws if `JSON.stringify` fails on the hash payload (pathological inputs only).
 */
export function buildOodaCycle(input: BuildOodaCycleInput): OodaCycle {
  const taskId = input.taskId || `task-${Date.now().toString(36)}`;
  const keyUnknowns = buildKeyUnknowns();
  const detailedPlan = buildDetailedPlan(input);
  const rankedActions = rankActions(buildCandidateActions(input));
  const recommended = rankedActions[0];

  const permission: PermissionEnvelope = {
    requiresApproval: true,
    summary: 'Approval required before render, code generation, or packaging stages begin.',
    commands: recommended.commands,
    fileScope: recommended.fileScope,
    networkScope: recommended.networkScope,
    processScope: [...DEFAULT_PROCESS_SCOPE],
    destructive: false,
  };

  const riskAssessment = buildRiskAssessment(input);

  return {
    taskId,
    keyUnknowns,
    detailedPlan,
    rankedActions,
    riskAssessment,
    permission,
    planHash: hashPlan({ keyUnknowns, detailedPlan, rankedActions, riskAssessment, permission }),
  };
}
