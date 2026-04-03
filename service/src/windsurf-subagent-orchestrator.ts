// @service/src/windsurf-subagent-orchestrator.ts
/**
 * @module windsurf-subagent-orchestrator
 *
 * ## Role
 * In-process registry and policy surface for **Windsurf-style subagent** work items under
 * Opseeq Precision Orchestration. This module does not execute remote agents; it holds task
 * records, derives capability hints from natural-language mandates, and applies a minimal
 * verification gate before a task may be marked complete.
 *
 * ## Alignment (Opseeq-wide)
 * - **Precision Orchestration**: Every task is keyed by `delegatorId`, `parentTaskId`, and `taskId`
 *   for correlation with upstream planners and the Living Architecture Graph.
 * - **Living Architecture Graph**: `graphNodeId` is the attachment point for provenance when an
 *   external indexer persists a completed contribution; this module only reserves the field.
 * - **General-Clawd absorption**: Subagent records are orthogonal to session/bootstrap flows;
 *   they may reference the same `taskId` family but do not mutate execution-runtime state.
 * - **Mermate pipeline**: Cross-repo optimization defaults are read-only and non-destructive;
 *   diagram/TLA/TS work stays in the Mermate service boundary—this orchestrator only scopes paths.
 *
 * -------------------------------------------------------------------------------------------------
 * ### Formal vocabulary (behavioral, falsifiable)
 *
 * **Axiom A14 — Supervision**
 * Subagent work is always modeled *as if* supervised: every `SubagentTask` names a `delegatorId`
 * and a `parentTaskId`, even when the delegator is a synthetic label (e.g. `"windsurf"`).
 *
 * **Axiom A15 — Ephemeral workers**
 * This process holds no authoritative long-term subagent memory beyond the in-memory `Map`; durable
 * state is expected in the Living Architecture Graph or downstream stores.
 *
 * **Postulate P13 — Scoped mandate**
 * A mandate is valid only when it specifies `timeout` (ms) ≥ 0, `targetRepos` is a finite list, and
 * `permissions` is a complete `SubagentPermissions` object. Callers are responsible for semantic
 * validity; this module does not reject empty descriptions.
 *
 * **Postulate P14 — Provenance placeholder**
 * `graphNodeId` starts `null` and is set only by integration code outside this file after graph commit.
 *
 * **Corollary C12 — Destructive work**
 * If `mandate.permissions.destructiveOpsAllowed` is false, delegators must not attach results that
 * imply destructive edits; this module does not inspect file operations—policy is enforced upstream.
 *
 * **Corollary C13 — Repository boundaries**
 * `targetRepos` and `fileScope` are declarative; they do not open filesystem or network handles here.
 *
 * **Lemma L5 — Orchestration chain**
 * Intended lifecycle: `pending|delegated` → `executing` → `verifying` → `completed|failed|rejected`.
 * Status transitions are not enforced by this module except via `verifyResult` (success path to
 * `completed` when criteria require output checks).
 *
 * @packageDocumentation
 */

import crypto from 'node:crypto';

// ── Capability taxonomy ───────────────────────────────────────────────────────────────────────

/** Finite set of capability tags used for mandate labeling and dashboard aggregation. */
export type SubagentCapability =
  | 'code_analysis'
  | 'architecture_review'
  | 'cross_repo_search'
  | 'tla_plus_reasoning'
  | 'type_inference'
  | 'rust_optimization'
  | 'test_generation'
  | 'documentation_synthesis'
  | 'security_audit'
  | 'performance_profiling'
  | 'dependency_analysis'
  | 'merge_conflict_resolution';

/** Human-readable capability definitions for consoles and agent prompts. */
export const CAPABILITY_DESCRIPTIONS: { readonly [K in SubagentCapability]: string } = {
  code_analysis: 'Static analysis, pattern detection, and code quality assessment.',
  architecture_review: 'Evaluate system architecture, coupling, cohesion, and design patterns.',
  cross_repo_search: 'Search across Opseeq, Mermate, Lucidity, and Synth repositories.',
  tla_plus_reasoning: 'Formal verification reasoning using TLA+ and Specula semantics.',
  type_inference: 'TypeScript/Rust type system analysis and inference.',
  rust_optimization: 'Rust performance optimization, lifetime analysis, and unsafe review.',
  test_generation: 'Generate test cases from specifications and behavioral contracts.',
  documentation_synthesis: 'Produce scientific documentation (axioms, postulates, corollaries, lemmas).',
  security_audit: 'OWASP-style security review and credential exposure analysis.',
  performance_profiling: 'Runtime performance analysis and bottleneck identification.',
  dependency_analysis: 'Dependency tree analysis, version compatibility, and update planning.',
  merge_conflict_resolution: 'Automated merge conflict detection and resolution proposals.',
};

// ── Task model ─────────────────────────────────────────────────────────────────────────────────

/** Lifecycle label for a subagent task. */
export type SubagentTaskStatus =
  | 'pending'
  | 'delegated'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'rejected';

/** Outcome of `verifyResult` when it runs the non-trivial acceptance branch. */
export type SubagentVerificationOutcome = 'pending' | 'passed' | 'failed';

/** Record of delegated work. Callers and `verifyResult` may update fields in place. */
export interface SubagentTask {
  taskId: string;
  parentTaskId: string;
  delegatorId: string;
  createdAt: string;
  status: SubagentTaskStatus;
  mandate: SubagentMandate;
  result: SubagentResult | null;
  verificationStatus: SubagentVerificationOutcome | null;
  graphNodeId: string | null;
}

/** Declarative bounds of what a subagent may do. */
export interface SubagentMandate {
  description: string;
  requiredCapabilities: SubagentCapability[];
  targetRepos: string[];
  fileScope: string[];
  permissions: SubagentPermissions;
  /** Wall-clock budget in milliseconds (interpretation of enforcement is upstream). */
  timeout: number;
  acceptanceCriteria: string[];
}

/** Sandboxed permission flags; all must be explicit—no implicit defaults in this interface. */
export interface SubagentPermissions {
  canRead: boolean;
  canWrite: boolean;
  canExecute: boolean;
  canAccessNetwork: boolean;
  destructiveOpsAllowed: boolean;
  requiresHumanApproval: boolean;
}

/** Payload produced when a subagent finishes (or mocks completion). */
export interface SubagentResult {
  completedAt: string;
  output: string;
  artifacts: SubagentArtifact[];
  metrics: SubagentMetrics;
  recommendations: string[];
}

export interface SubagentArtifact {
  kind: string;
  path: string;
  hash: string;
  description: string;
}

export interface SubagentMetrics {
  durationMs: number;
  filesAnalyzed: number;
  issuesFound: number;
  suggestionsGenerated: number;
  tokensUsed: number;
}

// ── Internal invariants ─────────────────────────────────────────────────────────────────────────

/** Status values that exclude a task from “active” counts and listings. */
const TERMINAL_TASK_STATUSES: ReadonlySet<SubagentTaskStatus> = new Set(['completed', 'failed', 'rejected']);

const DEFAULT_CAPABILITY_FALLBACK: SubagentCapability = 'code_analysis';

/**
 * Keyword → capability mapping for `assessCapabilities`.
 * Matching is **substring** (case-insensitive) against the full description.
 */
const CAPABILITY_KEYWORDS: { readonly [K in SubagentCapability]: readonly string[] } = {
  code_analysis: ['analyze', 'lint', 'quality', 'static analysis', 'code review'],
  architecture_review: ['architecture', 'design', 'coupling', 'cohesion', 'structure'],
  cross_repo_search: ['cross-repo', 'search', 'lucidity', 'mermate', 'mermaid', 'synth'],
  tla_plus_reasoning: ['tla+', 'tla', 'formal', 'verification', 'specula', 'model check'],
  type_inference: ['type', 'typescript', 'interface', 'generic', 'inference'],
  rust_optimization: ['rust', 'cargo', 'lifetime', 'borrow', 'unsafe', 'optimization'],
  test_generation: ['test', 'spec', 'coverage', 'assertion', 'vitest', 'jest'],
  documentation_synthesis: ['document', 'axiom', 'postulate', 'corollary', 'lemma', 'scientific'],
  security_audit: ['security', 'credential', 'owasp', 'vulnerability', 'exposure', 'leak'],
  performance_profiling: ['performance', 'profile', 'bottleneck', 'latency', 'throughput'],
  dependency_analysis: ['dependency', 'package', 'version', 'npm', 'cargo', 'update'],
  merge_conflict_resolution: ['merge', 'conflict', 'rebase', 'resolution'],
} as const;

/** Single source of truth for task storage in this Node process. */
const activeTasks = new Map<string, SubagentTask>();

// ── Delegation ────────────────────────────────────────────────────────────────────────────────

/**
 * Registers a new subagent task with status `delegated`.
 *
 * @param parentTaskId - Correlates with the parent orchestration unit (OODA / precision run).
 * @param delegatorId - Actor or role id (e.g. API default `"precision"` or `"windsurf"`).
 * @param mandate - Full mandate; not validated beyond structural use.
 *
 * @returns A new `SubagentTask` reference also stored in `activeTasks`.
 *
 * **Postcondition:** `getTask(task.taskId) === task` until removed (tasks are never deleted here).
 */
export function delegateTask(
  parentTaskId: string,
  delegatorId: string,
  mandate: SubagentMandate,
): SubagentTask {
  const task: SubagentTask = {
    taskId: crypto.randomUUID(),
    parentTaskId,
    delegatorId,
    createdAt: new Date().toISOString(),
    status: 'delegated',
    mandate,
    result: null,
    verificationStatus: null,
    graphNodeId: null,
  };
  activeTasks.set(task.taskId, task);
  return task;
}

/**
 * Heuristic capability inference from free text.
 *
 * @param description - Natural-language task description; empty string yields the fallback.
 * @returns Distinct capabilities whose **any** keyword appears as a substring (case-insensitive),
 *   or `['code_analysis']` when none match.
 *
 * **Determinism:** For fixed `description`, output order follows `CAPABILITY_KEYWORDS` key order.
 */
export function assessCapabilities(description: string): SubagentCapability[] {
  const lower = description.toLowerCase();
  const matched: SubagentCapability[] = [];
  (Object.entries(CAPABILITY_KEYWORDS) as [SubagentCapability, readonly string[]][]).forEach(([capability, kws]) => {
    if (kws.some((kw) => lower.includes(kw))) {
      matched.push(capability);
    }
  });
  return matched.length > 0 ? matched : [DEFAULT_CAPABILITY_FALLBACK];
}

/**
 * Minimal acceptance check for a completed task.
 *
 * **Precondition:** Typically invoked when `task.result` has been set by execution integration.
 *
 * **Postconditions:**
 * - If `task.result` is nullish → `false`, no mutation.
 * - If `acceptanceCriteria` is empty → `true`, **no mutation** (legacy behavior preserved).
 * - If criteria non-empty and `output` is empty/whitespace → `false`, no mutation.
 * - Otherwise → sets `verificationStatus` to `'passed'`, `status` to `'completed'`, returns `true`.
 *
 * **Failure modes:** Does not set `verificationStatus: 'failed'`; failures are indicated only by
 * `false` return and unchanged fields.
 */
export function verifyResult(task: SubagentTask): boolean {
  if (!task.result) {
    return false;
  }
  const criteria = task.mandate.acceptanceCriteria;
  if (criteria.length === 0) {
    return true;
  }
  if (!task.result.output || task.result.output.trim().length === 0) {
    return false;
  }
  task.verificationStatus = 'passed';
  task.status = 'completed';
  return true;
}

// ── Queries ───────────────────────────────────────────────────────────────────────────────────

/** @returns The task reference or `undefined` if unknown. */
export function getTask(taskId: string): SubagentTask | undefined {
  return activeTasks.get(taskId);
}

/**
 * Tasks whose `status` is not terminal (`completed`, `failed`, `rejected`).
 * Order is not specified.
 */
export function getActiveTasks(): SubagentTask[] {
  return Array.from(activeTasks.values()).filter((t) => !TERMINAL_TASK_STATUSES.has(t.status));
}

/** Snapshot of every registered task. Order is not specified. */
export function getAllTasks(): SubagentTask[] {
  return Array.from(activeTasks.values());
}

/** All tasks whose `parentTaskId` equals the argument. */
export function getTasksByParent(parentTaskId: string): SubagentTask[] {
  return Array.from(activeTasks.values()).filter((t) => t.parentTaskId === parentTaskId);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────────────────────

export interface OrchestratorDashboard {
  totalTasks: number;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
  capabilities: { capability: SubagentCapability; description: string; taskCount: number }[];
  recentTasks: { taskId: string; description: string; status: SubagentTaskStatus; createdAt: string }[];
}

/**
 * Aggregates registry statistics for HTTP `/api/subagents/dashboard`.
 *
 * **Counts:** `activeTasks` excludes terminal statuses (`completed`, `failed`, `rejected`). `completedTasks`
 * and `failedTasks` count only those labels. Tasks with status `rejected` contribute to `totalTasks` but
 * not to the three bucket fields (same decomposition as the pre-refactor implementation).
 */
export function getOrchestratorDashboard(): OrchestratorDashboard {
  const all = getAllTasks();
  const active = all.filter((t) => !TERMINAL_TASK_STATUSES.has(t.status));
  const completed = all.filter((t) => t.status === 'completed');
  const failed = all.filter((t) => t.status === 'failed');

  const capabilityCounts = new Map<SubagentCapability, number>();
  for (const task of all) {
    for (const cap of task.mandate.requiredCapabilities) {
      capabilityCounts.set(cap, (capabilityCounts.get(cap) || 0) + 1);
    }
  }

  const capabilities = (Object.keys(CAPABILITY_DESCRIPTIONS) as SubagentCapability[]).map((cap) => ({
    capability: cap,
    description: CAPABILITY_DESCRIPTIONS[cap],
    taskCount: capabilityCounts.get(cap) || 0,
  }));

  const recentTasks = all
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10)
    .map((t) => ({
      taskId: t.taskId,
      description: t.mandate.description,
      status: t.status,
      createdAt: t.createdAt,
    }));

  return {
    totalTasks: all.length,
    activeTasks: active.length,
    completedTasks: completed.length,
    failedTasks: failed.length,
    capabilities,
    recentTasks,
  };
}

// ── Cross-repo optimization preset ───────────────────────────────────────────────────────────

/**
 * Builds a **read-only, human-approval-gated** cross-repo optimization mandate and delegates it.
 *
 * **Contract:** Mirrors prior defaults: broad glob scope, no write/exec/network, destructive ops
 * disallowed, `requiresHumanApproval` true, 120s timeout, and three acceptance criteria strings.
 */
export function buildCrossRepoOptimizationTask(
  parentTaskId: string,
  delegatorId: string,
  targetRepos: string[],
  description: string,
): SubagentTask {
  const capabilities = assessCapabilities(description);
  return delegateTask(parentTaskId, delegatorId, {
    description,
    requiredCapabilities: capabilities,
    targetRepos,
    fileScope: ['**/*.ts', '**/*.rs', '**/*.py', '**/*.md'],
    permissions: {
      canRead: true,
      canWrite: false,
      canExecute: false,
      canAccessNetwork: false,
      destructiveOpsAllowed: false,
      requiresHumanApproval: true,
    },
    timeout: 120_000,
    acceptanceCriteria: [
      'Output must include specific file paths and line numbers.',
      'Recommendations must be actionable and scoped to target repos.',
      'No destructive operations may be proposed without explicit approval flag.',
    ],
  });
}
