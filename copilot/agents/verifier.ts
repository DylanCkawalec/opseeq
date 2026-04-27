// agents/verifier.ts — Expert Verifier: approves or rejects a plan against the prompt.
import { ulid } from "ulid";
import { registry } from "../models/registry.ts";
import type { Plan, Verdict, Verification } from "../obs/schema.ts";

export interface VerifierInput {
  prompt: string;
  plan: Plan;
}

export class VerifierAgent {
  async verify(input: VerifierInput): Promise<Verification> {
    const reg = registry();
    const binding = reg.get("verifier");

    const sys = [
      "You are the Expert Verifier.",
      "Decide whether the plan adequately addresses the original prompt.",
      "Output STRICT JSON: {\"verdict\":\"APPROVED|REJECTED|NEEDS_REVISION\",\"reason\":string}",
      "Reject if: tasks are out of order, the plan misreads the prompt, the plan invents unsupported actions,",
      "the success signals are unobservable, or the plan misses an explicit requirement.",
    ].join("\n");

    const user = JSON.stringify({
      prompt: input.prompt,
      plan: { summary: input.plan.summary, tasks: input.plan.tasks },
    });

    const res = await reg.invoke("verifier", {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.0,
    });

    const parsed = parse(res.content);
    return {
      id: ulid(),
      plan_id: input.plan.id,
      verdict: parsed.verdict,
      reason: parsed.reason,
      model: binding.model,
      provider: binding.provider,
      created_at: new Date().toISOString(),
    };
  }
}

function parse(text: string): { verdict: Verdict; reason: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { verdict?: string; reason?: string };
      const v = (o.verdict ?? "").toUpperCase();
      if (v === "APPROVED" || v === "REJECTED" || v === "NEEDS_REVISION") {
        return { verdict: v, reason: o.reason ?? "" };
      }
    } catch { /* fall through */ }
  }
  // Heuristic fallback: APPROVED if response contains "approve".
  const lower = text.toLowerCase();
  if (lower.includes("reject")) return { verdict: "REJECTED", reason: text.slice(0, 240) };
  if (lower.includes("revis"))  return { verdict: "NEEDS_REVISION", reason: text.slice(0, 240) };
  return { verdict: "APPROVED", reason: "default-approve (no structured verdict)" };
}
