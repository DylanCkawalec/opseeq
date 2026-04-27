// web/api.ts — Tiny fetch wrapper around the Go gateway.
export interface RunEnvelope {
  id: string;
  prompt: string;
  status: string;
  drift_max?: number;
  plans?: any[];
  verifications?: any[];
  tasks?: any[];
}
export interface ServiceComponentStatus {
  ready?: boolean;
  state?: string;
  status?: string;
  reasons?: string[];
}

export interface ModelBinding {
  role: string;
  provider: string;
  model: string;
  defaultModel?: string;
  envOverride?: boolean;
}

export interface QgotReadinessReport {
  service?: string;
  qgot_http_base?: string;
  http?: ServiceComponentStatus;
  mcp?: ServiceComponentStatus;
  graphql?: ServiceComponentStatus;
  openapi?: ServiceComponentStatus;
  orm?: ServiceComponentStatus;
  frontend?: ServiceComponentStatus;
  run_store?: ServiceComponentStatus;
  ooda?: ServiceComponentStatus;
  qal?: ServiceComponentStatus;
  executor?: ServiceComponentStatus;
  model_roles?: ServiceComponentStatus;
  role_model_bindings?: ModelBinding[];
}

export interface QgotStatusEnvelope {
  ok?: boolean;
  source?: string;
  status?: QgotReadinessReport | string | Record<string, unknown>;
  qgot_http_base?: string;
  reasons?: string[];
  error?: string;
}

async function readJson<T>(r: Response): Promise<T> {
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text) as T;
}

export async function submitPrompt(prompt: string): Promise<RunEnvelope> {
  const r = await fetch("/v1/copilot/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  return readJson<RunEnvelope>(r);
}

export async function getQgotStatus(): Promise<QgotStatusEnvelope> {
  const r = await fetch("/v1/copilot/qgot/status");
  return readJson<QgotStatusEnvelope>(r);
}

export async function listRuns(): Promise<RunEnvelope[]> {
  const r = await fetch("/v1/copilot/runs");
  return readJson<RunEnvelope[]>(r);
}

export async function listModels(): Promise<{ bindings: ModelBinding[] }> {
  const r = await fetch("/v1/copilot/models");
  return readJson<{ bindings: ModelBinding[] }>(r);
}

export async function setRoleModel(role: string, provider: string, model: string) {
  const r = await fetch("/v1/copilot/models", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, provider, model }),
  });
  return readJson<unknown>(r);
}

export function streamRun(runId: string, onEvent: (ev: any) => void): EventSource {
  const es = new EventSource(`/v1/copilot/runs/sse/${runId}`);
  es.onmessage = (m) => {
    try { onEvent(JSON.parse(m.data)); } catch { /* keep-alive */ }
  };
  return es;
}

export async function controlRun(run_id: string, action: "pause" | "resume" | "redirect", extra: { reason?: string; new_prompt?: string } = {}) {
  const r = await fetch("/v1/copilot/runs/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ RunID: run_id, Action: action, Reason: extra.reason ?? "", NewPrompt: extra.new_prompt ?? "" }),
  });
  return readJson<unknown>(r);
}
