// obs/schema.ts — Strongly typed event union for observability.
// Every writer in agents/ and workflow/ goes through obs/writer.ts and emits one of these.
import type { Role } from "../models/types.ts";

export type RunStatus =
  | "PLANNING"
  | "VERIFYING"
  | "EXECUTING"
  | "PAUSED"
  | "DONE"
  | "FAILED";

export type Verdict = "APPROVED" | "REJECTED" | "NEEDS_REVISION";

export type TaskKind =
  | "code_edit"
  | "shell_command"
  | "http_call"
  | "qgot_pipeline"
  | "qal_simulate"
  | "note";

export type TaskStatus = "PENDING" | "RUNNING" | "DONE" | "SKIPPED" | "FAILED";

export interface PlannedTask {
  id: string;
  kind: TaskKind;
  description: string;
  inputs?: Record<string, unknown>;
  depends_on?: string[];
}

export interface Plan {
  id: string;
  prompt: string;
  summary: string;
  tasks: PlannedTask[];
  model: string;
  provider: string;
  iteration: number; // 0 = first plan, 1+ = re-plans after rejection
  created_at: string;
}

export interface Verification {
  id: string;
  plan_id: string;
  verdict: Verdict;
  reason: string;
  model: string;
  provider: string;
  created_at: string;
}

export interface TaskRun {
  id: string;
  plan_id: string;
  task_id: string;
  status: TaskStatus;
  output?: unknown;
  error?: string;
  model: string;
  provider: string;
  started_at: string;
  finished_at?: string;
}

export type RunEvent =
  | { type: "RunStarted"; run_id: string; prompt: string; ts: string }
  | { type: "RoleStarted"; run_id: string; role: Role; model: string; ts: string }
  | { type: "RoleEmitted"; run_id: string; role: Role; bytes: number; latency_ms: number; ts: string }
  | { type: "PlanProposed"; run_id: string; plan: Plan; ts: string }
  | { type: "VerifierVerdict"; run_id: string; verification: Verification; ts: string }
  | { type: "TaskStarted"; run_id: string; task: TaskRun; ts: string }
  | { type: "TaskExecuted"; run_id: string; task: TaskRun; ts: string }
  | { type: "DriftDetected"; run_id: string; score: number; threshold: number; ts: string }
  | { type: "PausedByObserver"; run_id: string; reason: string; ts: string }
  | { type: "ResumedByObserver"; run_id: string; ts: string }
  | { type: "RedirectedByObserver"; run_id: string; new_prompt: string; ts: string }
  | { type: "RunFinished"; run_id: string; status: RunStatus; ts: string };

export interface RunEnvelope {
  id: string;
  prompt: string;
  status: RunStatus;
  plans: Plan[];
  verifications: Verification[];
  tasks: TaskRun[];
  drift_max: number;
  started_at: string;
  finished_at?: string;
}
