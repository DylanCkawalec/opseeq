// obs/writer.ts — Writes per-run artifacts under runs/<run_id>/ and broadcasts events.
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { env } from "../models/env.ts";
import type {
  Plan,
  RunEnvelope,
  RunEvent,
  RunStatus,
  TaskRun,
  Verification,
} from "./schema.ts";

export class RunWriter {
  readonly run_id: string;
  readonly dir: string;
  readonly bus: EventEmitter = new EventEmitter();
  private envelope: RunEnvelope;

  constructor(run_id: string, prompt: string, baseDir?: string) {
    this.run_id = run_id;
    const root = baseDir ?? env("QGOT_RUN_DIR", "./runs");
    this.dir = path.resolve(root, run_id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.envelope = {
      id: run_id,
      prompt,
      status: "PLANNING",
      plans: [],
      verifications: [],
      tasks: [],
      drift_max: 0,
      started_at: new Date().toISOString(),
    };
    fs.writeFileSync(this.path("prompt.txt"), prompt);
    this.emit({ type: "RunStarted", run_id, prompt, ts: now() });
  }

  /** runs/<id>/<file> */
  path(name: string): string {
    return path.join(this.dir, name);
  }

  status(s: RunStatus): void {
    this.envelope.status = s;
    if (s === "DONE" || s === "FAILED") this.envelope.finished_at = new Date().toISOString();
    this.persistEnvelope();
  }

  writePlan(plan: Plan): void {
    this.envelope.plans.push(plan);
    fs.writeFileSync(this.path("plan.json"), JSON.stringify(plan, null, 2));
    this.appendNDJSON("plans.ndjson", plan);
    this.emit({ type: "PlanProposed", run_id: this.run_id, plan, ts: now() });
  }

  writeVerification(v: Verification): void {
    this.envelope.verifications.push(v);
    fs.writeFileSync(this.path("verify.json"), JSON.stringify(v, null, 2));
    this.appendNDJSON("verify.ndjson", v);
    this.emit({ type: "VerifierVerdict", run_id: this.run_id, verification: v, ts: now() });
  }

  writeTask(t: TaskRun): void {
    this.envelope.tasks.push(t);
    this.appendNDJSON("exec.jsonl", t);
    if (t.status === "RUNNING") {
      this.emit({ type: "TaskStarted", run_id: this.run_id, task: t, ts: now() });
    } else {
      this.emit({ type: "TaskExecuted", run_id: this.run_id, task: t, ts: now() });
    }
  }

  writeCoder(entry: { task_id: string; diff?: string; output?: string; model: string }): void {
    this.appendNDJSON("coder.jsonl", entry);
  }

  writeObserver(entry: { kind: string; data: unknown; ts?: string }): void {
    this.appendNDJSON("observer.jsonl", { ts: entry.ts ?? now(), ...entry });
  }

  writeDrift(score: number, threshold: number): void {
    if (score > this.envelope.drift_max) this.envelope.drift_max = score;
    this.appendNDJSON("observer.jsonl", { ts: now(), kind: "DRIFT", score, threshold });
    this.emit({ type: "DriftDetected", run_id: this.run_id, score, threshold, ts: now() });
  }

  log(line: string): void {
    fs.appendFileSync(this.path("log.txt"), `[${now()}] ${line}\n`);
  }

  emit(ev: RunEvent): void {
    this.appendNDJSON("trace.ndjson", ev);
    this.bus.emit("event", ev);
  }

  finish(status: RunStatus): RunEnvelope {
    this.status(status);
    this.emit({ type: "RunFinished", run_id: this.run_id, status, ts: now() });
    this.persistEnvelope();
    return this.envelope;
  }

  envelopeSnapshot(): RunEnvelope {
    return JSON.parse(JSON.stringify(this.envelope)) as RunEnvelope;
  }

  // ── private ────────────────────────────────────────────
  private appendNDJSON(file: string, obj: unknown): void {
    fs.appendFileSync(this.path(file), JSON.stringify(obj) + "\n");
  }

  private persistEnvelope(): void {
    fs.writeFileSync(this.path("state.json"), JSON.stringify(this.envelope, null, 2));
  }
}

function now(): string {
  return new Date().toISOString();
}
