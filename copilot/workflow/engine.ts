// workflow/engine.ts — Drives Plan → Verify → Execute with Observer monitoring + loopback.
import { ulid } from "ulid";
import { ObserverAgent } from "../agents/observer.ts";
import { PlannerAgent } from "../agents/planner.ts";
import { VerifierAgent } from "../agents/verifier.ts";
import { ExecutorAgent, type QGoTBridge } from "../agents/executor.ts";
import { RunWriter } from "../obs/writer.ts";
import { next as nextState } from "./state.ts";
import type { RunEnvelope } from "../obs/schema.ts";

export interface EngineOptions {
  /** Maximum number of plan ↔ verify rejection loops (default 2). */
  maxRejections?: number;
  /** Optional bridge to QGoT MCP for qgot_pipeline / qal_simulate tasks. */
  qgotBridge?: QGoTBridge;
  /** Override base directory for run artifacts. */
  runsDir?: string;
}

export class WorkflowEngine {
  private readonly planner = new PlannerAgent();
  private readonly verifier = new VerifierAgent();
  private readonly observer = new ObserverAgent();
  private readonly executor: ExecutorAgent;
  private readonly maxRejections: number;
  private readonly active = new Map<string, { writer: RunWriter; observer: ObserverAgent }>();

  constructor(opts: EngineOptions = {}) {
    this.executor = new ExecutorAgent(undefined, opts.qgotBridge);
    this.maxRejections = opts.maxRejections ?? 2;
  }

  async submit(prompt: string, runsDir?: string): Promise<RunEnvelope> {
    const run_id = ulid();
    const writer = new RunWriter(run_id, prompt, runsDir);
    const observer = new ObserverAgent();
    observer.attach(writer, prompt);
    this.active.set(run_id, { writer, observer });

    let status = "PLANNING" as ReturnType<typeof nextState>;
    writer.status(status);
    let iteration = 0;
    let feedback: string | undefined;
    let approvedPlan = null as Awaited<ReturnType<typeof this.planner.plan>> | null;

    // Plan/Verify loop
    while (iteration <= this.maxRejections) {
      const plan = await this.planner.plan({ run_id, prompt, iteration, feedback });
      writer.writePlan(plan);
      status = nextState(status, { kind: "plan_emitted" });
      writer.status(status); // VERIFYING

      const verification = await this.verifier.verify({ prompt, plan });
      writer.writeVerification(verification);
      status = nextState(status, { kind: "verdict", verdict: verification.verdict });
      writer.status(status);

      if (verification.verdict === "APPROVED") {
        approvedPlan = plan;
        break;
      }
      feedback = verification.reason || "(verifier did not provide reason)";
      iteration += 1;
    }

    if (!approvedPlan) {
      writer.log(`[engine] exceeded maxRejections=${this.maxRejections}; failing run`);
      const env = writer.finish("FAILED");
      this.active.delete(run_id);
      return env;
    }

    // Execute
    const tasks = await this.executor.execute(approvedPlan, writer);
    const allOk = tasks.every((t) => t.status === "DONE");
    status = nextState(status, { kind: "execution_complete", ok: allOk });
    const final = writer.finish(allOk ? "DONE" : "FAILED");
    this.active.delete(run_id);
    return final;
  }

  // ── Observer control plane ────────────────────────────
  pause(run_id: string, reason: string): boolean {
    const slot = this.active.get(run_id);
    if (!slot) return false;
    slot.observer.pause(slot.writer, reason);
    return true;
  }

  resume(run_id: string): boolean {
    const slot = this.active.get(run_id);
    if (!slot) return false;
    slot.observer.resume(slot.writer);
    return true;
  }

  /** Force a re-plan with a new prompt (workflow returns to PLANNING). */
  redirect(run_id: string, new_prompt: string): boolean {
    const slot = this.active.get(run_id);
    if (!slot) return false;
    slot.writer.emit({ type: "RedirectedByObserver", run_id, new_prompt, ts: new Date().toISOString() });
    slot.writer.writeObserver({ kind: "REDIRECT", data: { new_prompt } });
    // The current submit() loop is linear; redirect is recorded for the API to use
    // to trigger a follow-up submit() call in v0.1.
    return true;
  }
}
