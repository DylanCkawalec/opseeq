// mcp/qgot_bridge.ts — Contract bridge to authoritative Rust QGoT.
//
// Preferred path:
//   1. QGoT HTTP copilot endpoints as they land under /v1/qgot/copilot/*
//   2. Existing QGoT HTTP endpoints (/pipelines, /qal/simulate, /observability/status)
//   3. Rust MCP stdio command from QGOT_MCP_CMD when explicitly configured
//   4. Local Opseeq TS workflow fallback owned by mcp/server.ts
//
// This file normalizes Rust QGoT payloads into Opseeq's RunEnvelope/Plan/
// Verification shapes so the Go API, GraphQL proxy, and dashboard can stay
// stable while QGoT's service-completion plan lands incrementally.
import { spawn } from "node:child_process";
import { env } from "../models/env.ts";
import type { QGoTBridge } from "../agents/executor.ts";
import type { Plan, PlannedTask, RunEnvelope, TaskRun, Verification } from "../obs/schema.ts";

type JsonRecord = Record<string, unknown>;

interface BridgeCallOptions {
  timeoutMs?: number;
}

export interface QGoTServiceBridge {
  plan(args: JsonRecord): Promise<Plan | null>;
  verify(args: JsonRecord): Promise<Verification | null>;
  execute(args: JsonRecord): Promise<RunEnvelope | null>;
  observe(args: JsonRecord): Promise<unknown | null>;
  qalSimulate(args: JsonRecord): Promise<{ output: string; raw?: unknown }>;
  models(args?: JsonRecord): Promise<unknown | null>;
  status(): Promise<JsonRecord>;
}

let _executorBridge: QGoTBridge | null = null;
let _serviceBridge: QGoTServiceBridge | null = null;

export function qgotBridge(): QGoTBridge {
  if (_executorBridge) return _executorBridge;
  const service = qgotServiceBridge();
  _executorBridge = {
    async pipeline({ prompt, config }) {
      const raw = await callHttpPipeline({ prompt, config });
      if (!raw) return { output: "(qgot bridge offline)" };
      return { output: pipelineOutput(raw), raw };
    },
    async qalSimulate(input) {
      return service.qalSimulate(input);
    },
  };
  return _executorBridge;
}

export function qgotServiceBridge(): QGoTServiceBridge {
  if (_serviceBridge) return _serviceBridge;
  _serviceBridge = {
    async plan(args) {
      const raw = await callRustTool("qgot.plan", args, { timeoutMs: quickTimeoutMs() });
      return raw ? normalizePlan(raw, stringField(args, "prompt")) : null;
    },
    async verify(args) {
      const raw = await callRustTool("qgot.verify", args, { timeoutMs: quickTimeoutMs() });
      return raw ? normalizeVerification(raw, args.plan) : null;
    },
    async execute(args) {
      const raw = await callRustTool("qgot.execute", args, { timeoutMs: executeTimeoutMs() });
      return raw ? normalizeRunEnvelope(raw, stringField(args, "prompt")) : null;
    },
    async observe(args) {
      return callRustTool("qgot.observe", args, { timeoutMs: quickTimeoutMs() });
    },
    async qalSimulate(args) {
      const normalized = normalizeQalInput(args);
      const raw = await callRustTool("qgot.qal.simulate", normalized, { timeoutMs: executeTimeoutMs() });
      if (!raw) return { output: "(qal bridge offline)" };
      const result = asRecord(raw).result ?? raw;
      return { output: JSON.stringify(result), raw: result };
    },
    async models(args = { action: "list" }) {
      return callRustTool("qgot.models", args, { timeoutMs: quickTimeoutMs() });
    },
    async status() {
      const raw = await callRustTool("qgot.status", {}, { timeoutMs: quickTimeoutMs() });
      if (raw) return { ok: true, source: "qgot", status: raw };
      return {
        ok: false,
        source: "opseeq.local_fallback",
        status: "qgot_unavailable",
        qgot_http_base: httpBase(),
        reasons: ["QGoT HTTP/MCP did not respond within the bridge timeout"],
      };
    },
  };
  return _serviceBridge;
}

async function callRustTool(
  name: string,
  args: JsonRecord,
  options: BridgeCallOptions = {},
): Promise<unknown | null> {
  if (bridgeMode() === "local") return null;
  const http = await callHttpTool(name, args, options);
  if (http !== null) return unwrapToolPayload(http);
  if (bridgeMode() === "http") return null;
  const cmd = env("QGOT_MCP_CMD", "").trim();
  if (!cmd) return null;
  return callMcpCommand(cmd, name, args, options);
}

async function callHttpTool(
  name: string,
  args: JsonRecord,
  options: BridgeCallOptions,
): Promise<unknown | null> {
  switch (name) {
    case "qgot.plan":
      return postJson("/v1/qgot/copilot/plan", args, options);
    case "qgot.verify":
      return postJson("/v1/qgot/copilot/verify", args, options);
    case "qgot.execute": {
      const copilot = await postJson("/v1/qgot/copilot/execute", args, options);
      if (copilot !== null) return copilot;
      return callHttpPipeline(args, options);
    }
    case "qgot.observe": {
      const runID = stringField(args, "run_id");
      if (runID) {
        const copilotRun = await getJson(`/v1/qgot/copilot/runs/${encodeURIComponent(runID)}`, options);
        if (copilotRun !== null) return copilotRun;
        return getJson(`/v1/qgot/runs/${encodeURIComponent(runID)}`, options);
      }
      return callHttpTool("qgot.status", {}, options);
    }
    case "qgot.qal.simulate":
      return postJson("/v1/qgot/qal/simulate", normalizeQalInput(args), options);
    case "qgot.models": {
      const copilotModels = await getJson("/v1/qgot/copilot/models", options);
      if (copilotModels !== null) return copilotModels;
      const status = await getJson("/v1/qgot/observability/status", options);
      if (!status) return null;
      const record = asRecord(status);
      return { ok: true, bindings: record.role_model_bindings ?? [] };
    }
    case "qgot.status": {
      const copilotStatus = await getJson("/v1/qgot/copilot/status", options);
      if (copilotStatus !== null) return copilotStatus;
      return getJson("/v1/qgot/observability/status", options);
    }
    default:
      return null;
  }
}

async function callHttpPipeline(
  args: JsonRecord,
  options: BridgeCallOptions = {},
): Promise<unknown | null> {
  const prompt = stringField(args, "prompt");
  if (!prompt) return null;
  return postJson(
    "/v1/qgot/pipelines",
    {
      prompt,
      request_id: stringField(args, "request_id") || undefined,
      config: stringField(args, "config") || undefined,
    },
    { timeoutMs: options.timeoutMs ?? executeTimeoutMs() },
  );
}

async function callMcpCommand(
  command: string,
  name: string,
  args: JsonRecord,
  options: BridgeCallOptions,
): Promise<unknown | null> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, options.timeoutMs ?? executeTimeoutMs());

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (!line) {
        if (stderr.trim()) process.stderr.write(`[qgot-bridge] MCP stderr: ${stderr.slice(0, 500)}\n`);
        resolve(null);
        return;
      }
      try {
        const rpc = JSON.parse(line) as JsonRecord;
        const result = asRecord(rpc.result);
        if (rpc.error) resolve(null);
        else resolve(unwrapToolPayload(result));
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }) + "\n");
  });
}

async function getJson(path: string, options: BridgeCallOptions): Promise<unknown | null> {
  return fetchJson(path, { method: "GET" }, options);
}

async function postJson(path: string, body: unknown, options: BridgeCallOptions): Promise<unknown | null> {
  return fetchJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, options);
}

async function fetchJson(
  path: string,
  init: RequestInit,
  options: BridgeCallOptions,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? quickTimeoutMs());
  try {
    const res = await fetch(`${httpBase()}${path}`, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json() as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizePlan(raw: unknown, promptFallback: string): Plan | null {
  const value = asRecord(unwrapToolPayload(raw));
  const plan = asRecord(value.plan ?? value);
  const tasksValue = Array.isArray(plan.tasks) ? plan.tasks : [];
  const tasks = tasksValue.map((task, index) => normalizeTask(asRecord(task), index));
  return {
    id: stringField(plan, "id") || stringField(plan, "plan_id") || `qgot-plan-${Date.now()}`,
    prompt: stringField(plan, "prompt") || promptFallback,
    summary: stringField(plan, "summary") || stringField(plan, "objective") || "QGoT copilot plan",
    tasks,
    model: firstModel(plan.model_bindings) || "qgot",
    provider: firstProvider(plan.model_bindings) || "qgot",
    iteration: numberField(plan, "iteration") ?? 0,
    created_at: dateFromUnix(numberField(plan, "created_at_unix")) ?? new Date().toISOString(),
  };
}

function normalizeVerification(raw: unknown, planValue: unknown): Verification | null {
  const value = asRecord(unwrapToolPayload(raw));
  const verification = asRecord(value.verification ?? value);
  const plan = asRecord(planValue);
  const status = stringField(verification, "status").toUpperCase();
  const verdict = status === "APPROVED" || status === "REJECTED" || status === "NEEDS_REVISION"
    ? status
    : "NEEDS_REVISION";
  return {
    id: stringField(verification, "id") || stringField(verification, "verification_id") || `qgot-verification-${Date.now()}`,
    plan_id: stringField(verification, "plan_id") || stringField(plan, "id") || stringField(plan, "plan_id") || "qgot-plan",
    verdict,
    reason: stringField(verification, "reason") || stringField(verification, "rationale") || "",
    model: stringField(verification, "model") || stringField(verification, "verifier") || "qgot.gateway.rule_verifier",
    provider: stringField(verification, "provider") || "qgot",
    created_at: new Date().toISOString(),
  };
}

function normalizeRunEnvelope(raw: unknown, promptFallback: string): RunEnvelope | null {
  const value = asRecord(unwrapToolPayload(raw));
  if (stringField(value, "id") && Array.isArray(value.plans) && Array.isArray(value.tasks)) {
    return value as unknown as RunEnvelope;
  }

  const pipelineEnvelope = asRecord(value.pipeline ?? value.envelope ?? value);
  const runID = stringField(value, "run_id") || stringField(pipelineEnvelope, "run_id") || `qgot-${Date.now()}`;
  const prompt = promptFallback || stringField(value, "prompt") || stringField(pipelineEnvelope, "prompt") || "";
  const plan = normalizePlan(value.plan ? { plan: value.plan } : buildSyntheticPlan(runID, prompt), prompt);
  const verification = value.verification
    ? normalizeVerification({ verification: value.verification }, plan)
    : buildSyntheticVerification(plan?.id ?? "qgot-plan");
  const taskRuns = Array.isArray(value.task_runs)
    ? value.task_runs.map((task, index) => normalizeTaskRun(asRecord(task), index, plan?.id ?? "qgot-plan"))
    : [buildSyntheticTaskRun(runID, plan?.id ?? "qgot-plan", pipelineOutput(pipelineEnvelope))];

  return {
    id: runID,
    prompt,
    status: value.ok === false ? "FAILED" : "DONE",
    plans: plan ? [plan] : [],
    verifications: verification ? [verification] : [],
    tasks: taskRuns,
    drift_max: 0,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    qgot: value,
  } as RunEnvelope & { qgot: unknown };
}

function normalizeTask(task: JsonRecord, index: number): PlannedTask {
  return {
    id: stringField(task, "id") || stringField(task, "task_id") || `qgot-task-${index + 1}`,
    kind: mapTaskKind(stringField(task, "kind")),
    description: stringField(task, "description") || stringField(task, "title") || "(qgot task)",
    depends_on: stringArray(task.depends_on),
    inputs: task.input ? { input: task.input } : asOptionalRecord(task.inputs),
  };
}

function normalizeTaskRun(task: JsonRecord, index: number, planID: string): TaskRun {
  const status = stringField(task, "status").toLowerCase();
  return {
    id: stringField(task, "id") || `${stringField(task, "task_id") || `qgot-task-${index + 1}`}-run`,
    plan_id: planID,
    task_id: stringField(task, "task_id") || stringField(task, "id") || `qgot-task-${index + 1}`,
    status: status === "completed" || status === "done" ? "DONE" : status === "blocked" ? "SKIPPED" : status === "failed" ? "FAILED" : "RUNNING",
    output: task.output,
    error: stringField(task, "error") || undefined,
    model: "qgot",
    provider: "qgot",
    started_at: dateFromUnix(numberField(task, "started_at_unix")) ?? new Date().toISOString(),
    finished_at: dateFromUnix(numberField(task, "ended_at_unix")) ?? new Date().toISOString(),
  };
}

function buildSyntheticPlan(runID: string, prompt: string): { plan: JsonRecord } {
  return {
    plan: {
      plan_id: `${runID}-plan`,
      prompt,
      objective: "Execute prompt through QGoT pipeline",
      tasks: [{
        id: "execute-qgot-pipeline",
        kind: "pipeline",
        title: "Execute QGoT pipeline",
        depends_on: [],
        input: prompt,
      }],
    },
  };
}

function buildSyntheticVerification(planID: string): Verification {
  return {
    id: `${planID}-verification`,
    plan_id: planID,
    verdict: "APPROVED",
    reason: "QGoT pipeline envelope returned successfully.",
    model: "qgot",
    provider: "qgot",
    created_at: new Date().toISOString(),
  };
}

function buildSyntheticTaskRun(runID: string, planID: string, output: string): TaskRun {
  return {
    id: `${runID}-pipeline-task-run`,
    plan_id: planID,
    task_id: "execute-qgot-pipeline",
    status: "DONE",
    output,
    model: "qgot",
    provider: "qgot",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
}

function mapTaskKind(kind: string): PlannedTask["kind"] {
  switch (kind) {
    case "pipeline":
    case "qgot_pipeline":
      return "qgot_pipeline";
    case "qal_simulate":
      return "qal_simulate";
    case "shell":
    case "shell_command":
      return "shell_command";
    default:
      return "note";
  }
}

function normalizeQalInput(input: JsonRecord): JsonRecord {
  const direct = stringField(input, "input") || stringField(input, "prompt");
  return { input: direct || JSON.stringify(input) };
}

function pipelineOutput(raw: unknown): string {
  const record = asRecord(raw);
  const pipeline = asRecord(record.pipeline);
  return stringField(record, "final_answer")
    || stringField(pipeline, "final_answer")
    || stringField(asRecord(record.summary), "final_answer_preview")
    || JSON.stringify(raw);
}

function unwrapToolPayload(raw: unknown): unknown {
  const record = asRecord(raw);
  if (record.structuredContent) return record.structuredContent;
  const result = asRecord(record.result);
  if (result.structuredContent) return result.structuredContent;
  return raw;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asOptionalRecord(value: unknown): JsonRecord | undefined {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : undefined;
}

function stringField(record: JsonRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function dateFromUnix(value: number | undefined): string | undefined {
  return value ? new Date(value * 1000).toISOString() : undefined;
}

function firstModel(bindings: unknown): string {
  const first = Array.isArray(bindings) ? asRecord(bindings[0]) : {};
  return stringField(first, "model");
}

function firstProvider(bindings: unknown): string {
  const first = Array.isArray(bindings) ? asRecord(bindings[0]) : {};
  return stringField(first, "provider");
}

function httpBase(): string {
  return env("QGOT_HTTP_BASE", "http://127.0.0.1:7300").replace(/\/$/, "");
}

function bridgeMode(): string {
  return env("QGOT_BRIDGE_MODE", "auto").trim().toLowerCase();
}

function quickTimeoutMs(): number {
  return Number(env("QGOT_BRIDGE_TIMEOUT_MS", "700")) || 700;
}

function executeTimeoutMs(): number {
  return Number(env("QGOT_BRIDGE_EXECUTE_TIMEOUT_MS", "30000")) || 30_000;
}
