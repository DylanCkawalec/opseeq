// agents/planner.ts — Expert Planner: prompt → ordered task list.
// Uses rule-based memory (planner_memory.json) to improve planning consistency.
import * as fs from "node:fs";
import * as path from "node:path";
import { ulid } from "ulid";
import { registry } from "../models/registry.ts";
import type { Plan, PlannedTask } from "../obs/schema.ts";

const MEMORY_FILE = path.resolve(process.cwd(), "agents", "planner_memory.json");

interface PlannerMemory { rules: string[]; updated_at: string }

function loadMemory(): PlannerMemory {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8")) as PlannerMemory;
  } catch {
    return { rules: defaultRules(), updated_at: new Date().toISOString() };
  }
}

function saveMemory(m: PlannerMemory): void {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(m, null, 2));
}

function defaultRules(): string[] {
  return [
    "Decompose into ≤7 tasks unless the prompt explicitly asks for more.",
    "Prefer deterministic tools (qgot_pipeline, qal_simulate) before LLM-only tasks.",
    "Every task must have a single observable success signal.",
    "Tasks that touch the filesystem must specify the path and a rollback strategy.",
    "Avoid network calls unless the prompt explicitly requires them.",
  ];
}

export interface PlannerInput {
  run_id: string;
  prompt: string;
  iteration: number;
  /** Optional verifier feedback when re-planning after rejection. */
  feedback?: string;
}

export class PlannerAgent {
  async plan(input: PlannerInput): Promise<Plan> {
    const memory = loadMemory();
    const reg = registry();
    const binding = reg.get("planner");

    const sys = [
      "You are the Expert Planner.",
      "Output STRICT JSON matching the schema below; no prose, no markdown.",
      "{",
      '  "summary": string,',
      '  "tasks": [',
      '    { "id": string, "kind": "code_edit|shell_command|http_call|qgot_pipeline|qal_simulate|note",',
      '      "description": string, "depends_on": string[] }',
      "  ]",
      "}",
      "Rules to follow:",
      ...memory.rules.map((r, i) => `  ${i + 1}. ${r}`),
    ].join("\n");

    const user = input.feedback
      ? `Original prompt:\n${input.prompt}\n\nVerifier feedback:\n${input.feedback}\nRevise the plan.`
      : input.prompt;

    const res = await reg.invoke("planner", {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.1,
    });

    const tasks = parseTasks(res.content);
    const plan: Plan = {
      id: ulid(),
      prompt: input.prompt,
      summary: extractSummary(res.content) ?? `Plan v${input.iteration} for: ${input.prompt.slice(0, 80)}`,
      tasks,
      model: binding.model,
      provider: binding.provider,
      iteration: input.iteration,
      created_at: new Date().toISOString(),
    };

    // Memory update: append a heuristic learned from this run.
    if (input.feedback) {
      memory.rules.push(`Account for verifier feedback: ${input.feedback.slice(0, 120)}`);
      memory.updated_at = new Date().toISOString();
      saveMemory(memory);
    }
    return plan;
  }
}

function parseTasks(text: string): PlannedTask[] {
  const json = extractJSON(text);
  if (!json || !Array.isArray(json.tasks)) return fallbackTasks(text);
  return (json.tasks as Array<Partial<PlannedTask>>).map((t, i) => ({
    id: t.id ?? `t${i + 1}`,
    kind: (t.kind as PlannedTask["kind"]) ?? "note",
    description: t.description ?? "(no description)",
    depends_on: t.depends_on ?? [],
    inputs: t.inputs,
  }));
}

function extractSummary(text: string): string | null {
  const json = extractJSON(text);
  return typeof json?.summary === "string" ? json.summary : null;
}

function extractJSON(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]) as Record<string, unknown>; } catch { return null; }
}

function fallbackTasks(text: string): PlannedTask[] {
  return [{ id: "t1", kind: "note", description: text.slice(0, 240), depends_on: [] }];
}
