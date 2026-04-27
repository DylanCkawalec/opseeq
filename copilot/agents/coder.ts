// agents/coder.ts — Expert Coder: implements a single PlannedTask.
// Produces implementation notes, diffs, and completion logs (writeCoder).
import { registry } from "../models/registry.ts";
import type { PlannedTask } from "../obs/schema.ts";

export interface CoderInput {
  prompt: string;
  task: PlannedTask;
  context?: string; // earlier task outputs concatenated
}

export interface CoderOutput {
  task_id: string;
  diff?: string;
  output: string;
  model: string;
  provider: string;
  latency_ms: number;
}

export class CoderAgent {
  async run(input: CoderInput): Promise<CoderOutput> {
    const reg = registry();
    const binding = reg.get("coder");

    const sys = [
      "You are the Expert Coder.",
      "Implement exactly one task. Do not invent extra steps.",
      "If the task is `code_edit`, output a unified diff inside ```diff fences.",
      "If the task is `shell_command`, output one shell line per call inside ```bash fences.",
      "Else output a concise plain-text result.",
      "Always conclude with a single line: DONE or BLOCKED: <reason>.",
    ].join("\n");

    const user = [
      `Original prompt: ${input.prompt}`,
      `Task ${input.task.id} (${input.task.kind}): ${input.task.description}`,
      input.context ? `\nContext from earlier tasks:\n${input.context}` : "",
    ].join("\n");

    const res = await reg.invoke("coder", {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    });

    return {
      task_id: input.task.id,
      output: res.content,
      diff: extractDiff(res.content),
      model: binding.model,
      provider: binding.provider,
      latency_ms: res.latency_ms,
    };
  }
}

function extractDiff(text: string): string | undefined {
  const m = text.match(/```diff\n([\s\S]*?)```/);
  return m?.[1];
}
