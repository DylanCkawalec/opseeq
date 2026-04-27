// agents/observer.ts — Expert Observer: monitors workflow, computes drift, can pause/resume/redirect.
import { CosineDriftScorer } from "../obs/drift.ts";
import { env } from "../models/env.ts";
import { registry } from "../models/registry.ts";
import type { RunWriter } from "../obs/writer.ts";
import type { RunEvent, Verification } from "../obs/schema.ts";

export type ObserverAction =
  | { kind: "noop" }
  | { kind: "pause"; reason: string }
  | { kind: "ask_verifier"; question: string }
  | { kind: "redirect"; new_prompt: string };

export class ObserverAgent {
  private readonly drift = new CosineDriftScorer();
  private readonly threshold: number;
  private paused = false;

  constructor() {
    this.threshold = Number(env("DRIFT_THRESHOLD", "0.42"));
  }

  /** Subscribe to a writer's event bus and react to events. */
  attach(writer: RunWriter, prompt: string): void {
    writer.bus.on("event", (ev: RunEvent) => {
      this.handle(writer, prompt, ev).catch((e) =>
        writer.writeObserver({ kind: "ERROR", data: { message: (e as Error).message } }),
      );
    });
  }

  pause(writer: RunWriter, reason: string): void {
    this.paused = true;
    writer.writeObserver({ kind: "PAUSE", data: { reason } });
    writer.emit({ type: "PausedByObserver", run_id: writer.run_id, reason, ts: new Date().toISOString() });
  }

  resume(writer: RunWriter): void {
    this.paused = false;
    writer.writeObserver({ kind: "RESUME", data: {} });
    writer.emit({ type: "ResumedByObserver", run_id: writer.run_id, ts: new Date().toISOString() });
  }

  isPaused(): boolean { return this.paused; }

  /** Ask the Verifier whether the run is still aligned with the prompt. */
  async askVerifier(prompt: string, currentNote: string): Promise<Verification | null> {
    try {
      const reg = registry();
      const sys = "You are the Verifier acting as a drift-alignment checker. Reply STRICT JSON {\"verdict\":\"APPROVED|REJECTED|NEEDS_REVISION\",\"reason\":string}.";
      const user = `Prompt: ${prompt}\n\nCurrent state: ${currentNote}`;
      const res = await reg.invoke("verifier", {
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        temperature: 0,
      });
      return parseVerification(res.content) as Verification | null;
    } catch {
      return null;
    }
  }

  // ── private ────────────────────────────────────────────
  private async handle(writer: RunWriter, prompt: string, ev: RunEvent): Promise<void> {
    switch (ev.type) {
      case "RoleEmitted":
        writer.writeObserver({ kind: "HEARTBEAT", data: { role: ev.role, bytes: ev.bytes, latency_ms: ev.latency_ms } });
        break;
      case "TaskExecuted": {
        const candidate = typeof ev.task.output === "string" ? ev.task.output : JSON.stringify(ev.task.output ?? "");
        const score = await this.drift.score(prompt, candidate);
        writer.writeObserver({ kind: "DRIFT_PROBE", data: { task_id: ev.task.task_id, score, threshold: this.threshold } });
        if (score > this.threshold) writer.writeDrift(score, this.threshold);
        break;
      }
      case "PlanProposed":
        writer.writeObserver({ kind: "PLAN_SEEN", data: { plan_id: ev.plan.id, iteration: ev.plan.iteration, tasks: ev.plan.tasks.length } });
        break;
      case "VerifierVerdict":
        writer.writeObserver({ kind: "VERDICT_SEEN", data: { plan_id: ev.verification.plan_id, verdict: ev.verification.verdict } });
        break;
      default:
        break;
    }
  }
}

function parseVerification(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
