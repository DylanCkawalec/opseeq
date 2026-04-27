// workflow/state.ts — Pure state machine for the orchestration workflow.
import type { RunStatus, Verdict } from "../obs/schema.ts";

export type Trigger =
  | { kind: "plan_emitted" }
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "execution_complete"; ok: boolean }
  | { kind: "observer_pause"; reason: string }
  | { kind: "observer_resume" }
  | { kind: "observer_redirect"; new_prompt: string }
  | { kind: "fail"; reason: string };

export interface Transition {
  from: RunStatus;
  to: RunStatus;
  trigger: Trigger["kind"];
}

export const ALLOWED: Transition[] = [
  { from: "PLANNING", to: "VERIFYING", trigger: "plan_emitted" },
  { from: "VERIFYING", to: "EXECUTING", trigger: "verdict" }, // when APPROVED
  { from: "VERIFYING", to: "PLANNING", trigger: "verdict" },  // when REJECTED / NEEDS_REVISION
  { from: "EXECUTING", to: "DONE", trigger: "execution_complete" },
  { from: "EXECUTING", to: "FAILED", trigger: "execution_complete" },
  { from: "EXECUTING", to: "PAUSED", trigger: "observer_pause" },
  { from: "PAUSED", to: "EXECUTING", trigger: "observer_resume" },
  { from: "EXECUTING", to: "PLANNING", trigger: "observer_redirect" },
  { from: "PLANNING", to: "FAILED", trigger: "fail" },
  { from: "VERIFYING", to: "FAILED", trigger: "fail" },
  { from: "EXECUTING", to: "FAILED", trigger: "fail" },
];

export function next(current: RunStatus, t: Trigger): RunStatus {
  switch (t.kind) {
    case "plan_emitted":
      return current === "PLANNING" ? "VERIFYING" : current;
    case "verdict":
      if (current !== "VERIFYING") return current;
      return t.verdict === "APPROVED" ? "EXECUTING" : "PLANNING";
    case "execution_complete":
      if (current !== "EXECUTING") return current;
      return t.ok ? "DONE" : "FAILED";
    case "observer_pause":
      return current === "EXECUTING" ? "PAUSED" : current;
    case "observer_resume":
      return current === "PAUSED" ? "EXECUTING" : current;
    case "observer_redirect":
      return current === "EXECUTING" || current === "PAUSED" ? "PLANNING" : current;
    case "fail":
      return "FAILED";
  }
}
