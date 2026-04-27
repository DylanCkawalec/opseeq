// agents/executor.ts — Expert Executor: runs an approved plan in topological order.
// Delegates `code_edit`/`shell_command` to the Coder, runs `qgot_pipeline` via MCP,
// and writes per-task output back through the RunWriter.
import { ulid } from "ulid";
import { CoderAgent } from "./coder.ts";
import { registry } from "../models/registry.ts";
import type { Plan, PlannedTask, TaskRun } from "../obs/schema.ts";
import type { RunWriter } from "../obs/writer.ts";

export type QGoTBridge = {
  pipeline(input: { prompt: string; config?: string }): Promise<{ output: string; raw?: unknown }>;
  qalSimulate(input: Record<string, unknown>): Promise<{ output: string; raw?: unknown }>;
};

export class ExecutorAgent {
  constructor(private readonly coder = new CoderAgent(), private readonly bridge?: QGoTBridge) {}

  async execute(plan: Plan, writer: RunWriter): Promise<TaskRun[]> {
    const reg = registry();
    const exBinding = reg.get("executor");
    const ordered = topoSort(plan.tasks);
    const outputs = new Map<string, string>();
    const runs: TaskRun[] = [];

    for (const task of ordered) {
      const t0 = Date.now();
      const tr: TaskRun = {
        id: ulid(),
        plan_id: plan.id,
        task_id: task.id,
        status: "RUNNING",
        model: exBinding.model,
        provider: exBinding.provider,
        started_at: new Date().toISOString(),
      };
      writer.writeTask(tr);

      try {
        const ctx = collectContext(task, outputs);
        let out: string;
        switch (task.kind) {
          case "qgot_pipeline":
            out = (await this.bridge?.pipeline({ prompt: task.description })) ?.output ?? "(qgot bridge unavailable)";
            break;
          case "qal_simulate":
            out = (await this.bridge?.qalSimulate(task.inputs ?? {}))?.output ?? "(qal bridge unavailable)";
            break;
          case "code_edit":
          case "shell_command":
          case "http_call":
          case "note": {
            const c = await this.coder.run({ prompt: plan.prompt, task, context: ctx });
            writer.writeCoder({ task_id: task.id, diff: c.diff, output: c.output, model: c.model });
            out = c.output;
            break;
          }
        }
        outputs.set(task.id, out);
        const done: TaskRun = {
          ...tr,
          status: "DONE",
          output: truncate(out, 4096),
          finished_at: new Date().toISOString(),
        };
        runs.push(done);
        writer.writeTask(done);
        writer.log(`[executor] task=${task.id} kind=${task.kind} dt=${Date.now() - t0}ms DONE`);
      } catch (err) {
        const failed: TaskRun = {
          ...tr,
          status: "FAILED",
          error: (err as Error).message,
          finished_at: new Date().toISOString(),
        };
        runs.push(failed);
        writer.writeTask(failed);
        writer.log(`[executor] task=${task.id} FAILED: ${(err as Error).message}`);
        break;
      }
    }
    return runs;
  }
}

function topoSort(tasks: PlannedTask[]): PlannedTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const out: PlannedTask[] = [];
  function visit(t: PlannedTask) {
    if (visited.has(t.id)) return;
    visited.add(t.id);
    for (const dep of t.depends_on ?? []) {
      const next = byId.get(dep);
      if (next) visit(next);
    }
    out.push(t);
  }
  for (const t of tasks) visit(t);
  return out;
}

function collectContext(task: PlannedTask, outputs: Map<string, string>): string {
  const deps = task.depends_on ?? [];
  return deps.map((d) => `## ${d}\n${outputs.get(d) ?? ""}`).join("\n\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;
}
