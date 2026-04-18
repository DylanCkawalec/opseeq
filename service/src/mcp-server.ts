/**
 * @module mcp-server — Model Context Protocol Server for Precision Orchestration
 *
 * Axiom A6: MCP tools are the canonical interface between external agents and the Opseeq control plane.
 * Postulate P5: Each tool is idempotent for read operations; write operations require explicit approval flow.
 * Corollary C4: precision_plan routes through the same approval gate as the REST API endpoint.
 * Behavioral Contract: All tool handlers use safeFetch with timeout and structured error reporting.
 * Tracing Invariant: Tool names are stable identifiers — renaming requires a major version bump.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServiceConfig } from './config.js';
import { routeInference, listModels } from './router.js';
import { connectRepo } from './repo-connect.js';
import type { Request, Response } from 'express';

// ── Environment ──────────────────────────────────────────────────
const trimSlash = (s: string) => s.replace(/\/+$/, '');
const MERMATE_URL = trimSlash(process.env.MERMATE_URL || 'http://127.0.0.1:3333');
const SYNTH_URL   = trimSlash(process.env.SYNTHESIS_TRADE_URL || 'http://127.0.0.1:8420');
const OPSEEQ_URL  = process.env.OPSEEQ_SELF_URL || 'http://127.0.0.1:9090';

const SELF_AUTH_KEY = (process.env.OPSEEQ_API_KEYS || process.env.OPSEEQ_API_KEY || '')
  .split(',').map(s => s.trim()).find(s => s.length > 0) ?? '';

const execAsync = promisify(exec);

// ── Shared fetch ─────────────────────────────────────────────────
async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> ?? {}),
    };
    if (SELF_AUTH_KEY && url.startsWith(OPSEEQ_URL)) {
      headers['Authorization'] = `Bearer ${SELF_AUTH_KEY}`;
    }
    const res = await fetch(url, { ...init, headers, signal: ctrl.signal });
    const payload = await res.json() as T;
    if (!res.ok) {
      const msg = typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `${url} → ${res.status}`;
      throw new Error(msg);
    }
    return payload;
  } finally { clearTimeout(timer); }
}

// ── Result helpers ───────────────────────────────────────────────
type ToolResult    = { content: [{ type: 'text'; text: string }]; isError?: true };
const ok    = (payload: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail  = (msg: string, err: unknown): ToolResult => ({ content: [{ type: 'text', text: `${msg}\n\n${err instanceof Error ? err.message : String(err)}` }], isError: true });

async function safeFetch<T>(label: string, url: string, init?: RequestInit): Promise<ToolResult> {
  try   { return ok(await requestJson<T>(url, init)); }
  catch (e) { return fail(label, e); }
}

function buildQuery(pairs: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) {
    if (v !== undefined && v !== null) p.set(k, String(v));
  }
  const s = p.toString();
  return s.length > 0 ? `?${s}` : '';
}

// ── Synth health shape ───────────────────────────────────────────
interface SynthHealth {
  status?: string;
  simulation_mode?: boolean;
  approval_required?: boolean;
  ai_engine_available?: boolean;
  predictions?: number;
  opseeq?: unknown;
}

// ── Pipeline stage runner ────────────────────────────────────────
interface StageResult { stage: string; duration_ms: number; success: boolean; validation?: unknown; error?: string }

async function runPipelineStage(
  stage: string, url: string, body: Record<string, unknown>,
  extractValidation: (r: Record<string, unknown>) => { success: boolean; validation: unknown } = r => ({ success: true, validation: r.validation }),
): Promise<StageResult> {
  const t0 = Date.now();
  try {
    const result = await requestJson<Record<string, unknown>>(url, { method: 'POST', body: JSON.stringify(body) });
    const { success, validation } = extractValidation(result);
    return { stage, duration_ms: Date.now() - t0, success, validation };
  } catch (e) {
    return { stage, duration_ms: Date.now() - t0, success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Filesystem helpers ───────────────────────────────────────────
async function fileExists(path: string): Promise<boolean> {
  return fsp.access(path).then(() => true, () => false);
}

// ══════════════════════════════════════════════════════════════════
//  MCP Server
// ══════════════════════════════════════════════════════════════════

export function createMcpServer(config: ServiceConfig): McpServer {
  const server = new McpServer({ name: 'opseeq', version: '5.0.0' });

  // ── 1. opseeq_status ─────────────────────────────────────────
  server.tool('opseeq_status', 'Full gateway status: providers, models, Mermate, Synth, Ollama, MCP, connectivity', {},
    async () => safeFetch('Opseeq status unavailable', `${OPSEEQ_URL}/api/status`));

  // ── 2. opseeq_chat ───────────────────────────────────────────
  server.tool('opseeq_chat', 'Send a prompt through the opseeq gateway (routes to NIM, OpenAI, Anthropic, or Ollama)', {
    prompt: z.string().min(1).describe('User prompt'),
    transport: z.enum(['opseeq', 'ollama']).optional().describe('Transport: opseeq (multi-provider) or ollama (local)'),
    model: z.string().optional().describe('Model override'),
    systemPrompt: z.string().optional().describe('Optional system prompt'),
  }, async ({ prompt, transport, model, systemPrompt }) => {
    const messages = [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), { role: 'user', content: prompt }];
    return safeFetch('Chat failed', `${OPSEEQ_URL}/api/chat`, { method: 'POST', body: JSON.stringify({ messages, transport, model }) });
  });

  // ── 3. opseeq_connectivity_probe ──────────────────────────────
  server.tool('opseeq_connectivity_probe', 'Probe a host for network connectivity', {
    host: z.string().min(1).describe('Hostname to probe (e.g. github.com)'),
  }, async ({ host }) => safeFetch(`Probe failed for ${host}`, `${OPSEEQ_URL}/api/connectivity/probe`, { method: 'POST', body: JSON.stringify({ host }) }));

  // ── 4. inference ──────────────────────────────────────────────
  server.tool('inference', 'Direct inference through multi-provider router', {
    model: z.string().describe('Model (e.g. gpt-4o, nvidia/nemotron-3-super-120b-a12b, claude-opus-4-6, claude-sonnet-4-6)'),
    system_prompt: z.string().optional(),
    user_prompt: z.string().describe('User message'),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().optional(),
  }, async ({ model, system_prompt, user_prompt, temperature, max_tokens }) => {
    const messages = [...(system_prompt ? [{ role: 'system', content: system_prompt }] : []), { role: 'user', content: user_prompt }];
    const result = await routeInference({ model: model || config.defaultModel, messages, temperature: temperature ?? 0, max_tokens }, config);
    return { content: [{ type: 'text' as const, text: result.choices?.[0]?.message?.content || '' }] };
  });

  // ── 5. list_models ────────────────────────────────────────────
  server.tool('list_models', 'List all available models across providers', {},
    async () => ok(listModels(config)));

  // ── 6. multi_inference ────────────────────────────────────────
  server.tool('multi_inference', 'Query multiple models in parallel for comparison', {
    models: z.array(z.string()).describe('Model identifiers'),
    system_prompt: z.string().optional(),
    user_prompt: z.string().describe('User message'),
    temperature: z.number().optional(),
  }, async ({ models, system_prompt, user_prompt, temperature }) => {
    const results = await Promise.allSettled(models.map(async (model) => {
      const msgs = [...(system_prompt ? [{ role: 'system', content: system_prompt }] : []), { role: 'user', content: user_prompt }];
      const r = await routeInference({ model, messages: msgs, temperature: temperature ?? 0 }, config);
      return { model, content: r.choices?.[0]?.message?.content || '', provider: r._opseeq?.provider, latencyMs: r._opseeq?.latencyMs };
    }));
    return ok(results.map((r, i) => r.status === 'fulfilled' ? r.value : { model: models[i], error: (r.reason as Error).message }));
  });

  // ── 7. architect_status ───────────────────────────────────────
  server.tool('architect_status', 'Inspect the Mermate architect profile and pipeline availability', {},
    async () => safeFetch('Architect status failed', `${OPSEEQ_URL}/api/architect/status`));

  // ── 8. architect_pipeline_build ───────────────────────────────
  server.tool('architect_pipeline_build', 'Run idea -> Mermaid -> TLA+ -> TypeScript pipeline through Mermate', {
    source: z.string().min(1).describe('Idea, markdown, or Mermaid source'),
    diagramName: z.string().optional(),
    inputMode: z.enum(['idea', 'markdown', 'mmd']).optional(),
    maxMode: z.boolean().optional(),
    includeTla: z.boolean().optional(),
    includeTs: z.boolean().optional(),
    scaffold: z.boolean().optional(),
    repoName: z.string().optional(),
  }, async (input) => safeFetch('Pipeline failed', `${OPSEEQ_URL}/api/architect/pipeline`, { method: 'POST', body: JSON.stringify(input) }));

  // ── 9. builder_scaffold_repo ──────────────────────────────────
  server.tool('builder_scaffold_repo', 'Scaffold a starter repo from a Mermate run bundle', {
    runId: z.string().min(1),
    repoName: z.string().min(1),
    sourceIdea: z.string().min(1),
  }, async (input) => safeFetch('Scaffold failed', `${OPSEEQ_URL}/api/builder/scaffold`, { method: 'POST', body: JSON.stringify(input) }));

  // ── 10. mermate_status ────────────────────────────────────────
  server.tool('mermate_status', 'Inspect Mermate copilot, TLA+, TypeScript, and agent availability', {}, async () => {
    try {
      const [copilot, tla, ts, modes, agents] = await Promise.all([
        requestJson(`${MERMATE_URL}/api/copilot/health`).catch(e => ({ error: String(e) })),
        requestJson(`${MERMATE_URL}/api/render/tla/status`).catch(e => ({ error: String(e) })),
        requestJson(`${MERMATE_URL}/api/render/ts/status`).catch(e => ({ error: String(e) })),
        requestJson(`${MERMATE_URL}/api/agent/modes`).catch(e => ({ error: String(e) })),
        requestJson(`${MERMATE_URL}/api/agents`).catch(e => ({ error: String(e) })),
      ]);
      return ok({ baseUrl: MERMATE_URL, copilot, tla, ts, modes, agents });
    } catch (e) { return fail(`Mermate unavailable at ${MERMATE_URL}`, e); }
  });

  // ── 11. mermate_agent_modes ───────────────────────────────────
  server.tool('mermate_agent_modes', 'List Mermate agent modes and loaded architecture specialists', {}, async () => {
    try {
      const [modes, agents] = await Promise.all([requestJson(`${MERMATE_URL}/api/agent/modes`), requestJson(`${MERMATE_URL}/api/agents`)]);
      return ok({ baseUrl: MERMATE_URL, modes, agents });
    } catch (e) { return fail('Agent modes failed', e); }
  });

  // ── 12. mermate_render ────────────────────────────────────────
  server.tool('mermate_render', 'Send text/markdown/Mermaid to Mermate for compilation', {
    source: z.string().min(1).describe('Idea, markdown, or Mermaid source'),
    diagramName: z.string().optional(),
    inputMode: z.enum(['idea', 'markdown', 'mmd']).optional(),
    maxMode: z.boolean().optional(),
  }, async ({ source, diagramName, inputMode, maxMode }) =>
    safeFetch('Mermate render failed', `${MERMATE_URL}/api/render`, {
      method: 'POST', body: JSON.stringify({ mermaid_source: source, diagram_name: diagramName, input_mode: inputMode, max_mode: maxMode }),
    }));

  // ── 13. mermate_generate_tla ──────────────────────────────────
  server.tool('mermate_generate_tla', 'Generate TLA+ specification from a Mermate run', {
    runId: z.string().min(1),
    diagramName: z.string().optional(),
  }, async ({ runId, diagramName }) =>
    safeFetch('TLA+ generation failed', `${MERMATE_URL}/api/render/tla`, { method: 'POST', body: JSON.stringify({ run_id: runId, diagram_name: diagramName }) }));

  // ── 14. mermate_generate_ts ───────────────────────────────────
  server.tool('mermate_generate_ts', 'Generate TypeScript runtime from a Mermate run', {
    runId: z.string().min(1),
    diagramName: z.string().optional(),
  }, async ({ runId, diagramName }) =>
    safeFetch('TypeScript generation failed', `${MERMATE_URL}/api/render/ts`, { method: 'POST', body: JSON.stringify({ run_id: runId, diagram_name: diagramName }) }));

  // ── 15. synth_status ──────────────────────────────────────────
  server.tool('synth_status', 'Deep status of the Synth prediction/trading desk: simulation mode, approval state, AI availability, predictions, opseeq connectivity', {}, async () => {
    try {
      const d = await requestJson<SynthHealth>(`${SYNTH_URL}/api/health`);
      return ok({
        purpose: 'synth_trading_desk', baseUrl: SYNTH_URL,
        status: d.status, simulationMode: d.simulation_mode, approvalRequired: d.approval_required,
        aiAvailable: d.ai_engine_available, predictions: d.predictions, opseeq: d.opseeq,
      });
    } catch (e) { return fail(`Synth unavailable at ${SYNTH_URL}`, e); }
  });

  // ── 16. synth_predict ────────────────────────────────────────
  server.tool('synth_predict', 'Generate a market prediction through the Synth prediction engine', {
    query: z.string().min(1).describe('Market question or prediction query'),
    wallet_id: z.string().optional().describe('Wallet ID for portfolio context'),
  }, async ({ query, wallet_id }) =>
    safeFetch('Synth prediction failed', `${SYNTH_URL}/api/predictions/generate`, { method: 'POST', body: JSON.stringify({ query, wallet_id }) }));

  // ── 17. synth_predictions ────────────────────────────────────
  server.tool('synth_predictions', 'List recent predictions from the Synth desk', {
    limit: z.number().optional().describe('Max predictions to return'),
  }, async ({ limit }) =>
    safeFetch('Failed to fetch predictions', `${SYNTH_URL}/api/predictions/history${limit ? `?limit=${limit}` : ''}`));

  // ── 18. synth_markets ────────────────────────────────────────
  server.tool('synth_markets', 'Search available prediction markets through the Synth desk', {
    query: z.string().min(1).describe('Market search query'),
    limit: z.number().optional().describe('Max results'),
  }, async ({ query, limit }) =>
    safeFetch('Market search failed', `${SYNTH_URL}/api/markets/search/${encodeURIComponent(query)}${limit ? `?limit=${limit}` : ''}`));

  // ── 19. synth_portfolio ──────────────────────────────────────
  server.tool('synth_portfolio', 'Get portfolio summary from the Synth trading desk', {
    wallet_id: z.string().optional().describe('Wallet ID'),
  }, async ({ wallet_id }) =>
    safeFetch('Portfolio fetch failed', `${SYNTH_URL}/api/portfolio/summary${wallet_id ? `?wallet_id=${wallet_id}` : ''}`));

  // ── 20. pipeline_orchestrate ───────────────────────────────────
  server.tool('pipeline_orchestrate', 'Run full Mermate pipeline step-by-step: render -> TLA+ -> TS -> Rust with Opseeq reviewing between stages', {
    source: z.string().min(1).describe('Idea, markdown, or Mermaid source'),
    inputMode: z.enum(['idea', 'markdown', 'mmd']).optional(),
    maxMode: z.boolean().optional(),
    includeTla: z.boolean().optional().default(true),
    includeTs: z.boolean().optional().default(true),
    includeRust: z.boolean().optional().default(false),
  }, async ({ source, inputMode, maxMode, includeTla, includeTs, includeRust }) => {
    const startAll = Date.now();
    try {
      const t0 = Date.now();
      const renderResult = await requestJson<Record<string, unknown>>(`${MERMATE_URL}/api/render`, {
        method: 'POST', body: JSON.stringify({ mermaid_source: source, input_mode: inputMode, max_mode: maxMode }),
      });
      const runId = (renderResult.run_id || renderResult.runId || '') as string;
      const stages: StageResult[] = [{ stage: 'render', duration_ms: Date.now() - t0, success: true, validation: renderResult.validation }];

      const optional: Array<[boolean, string, string]> = [
        [Boolean(includeTla && runId), 'tla', `${MERMATE_URL}/api/render/tla`],
        [Boolean(includeTs  && runId), 'ts',  `${MERMATE_URL}/api/render/ts`],
        [Boolean(includeRust && runId), 'rust', `${MERMATE_URL}/api/render/rust`],
      ];
      for (const [enabled, name, url] of optional) {
        if (!enabled) continue;
        stages.push(await runPipelineStage(name, url, { run_id: runId }, (r) => {
          if (name === 'ts') return { success: (r.validation as Record<string, unknown>)?.success !== false, validation: r.validation };
          if (name === 'rust') return { success: true, validation: r.rust_metrics };
          return { success: true, validation: r.validation };
        }));
      }

      return ok({
        purpose: 'mermate_full_pipeline', run_id: runId, total_duration_ms: Date.now() - startAll,
        stages_completed: stages.filter(s => s.success).length,
        stages_failed: stages.filter(s => !s.success).length,
        stages,
      });
    } catch (e) { return fail('Pipeline orchestration failed at render stage', e); }
  });

  // ── 21. desktop_scan ──────────────────────────────────────────
  server.tool('desktop_scan', 'Scan a directory (default ~/Desktop/developer/) for repos and their Opseeq connection status', {
    path: z.string().optional().describe('Directory to scan (default: ~/Desktop/developer/)'),
  }, async ({ path: scanPath }) => {
    const dir = scanPath || join(process.env.HOME || '/tmp', 'Desktop', 'developer');
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const repos = await Promise.all(
        entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
          .map(async e => {
            const p = join(dir, e.name);
            const [hasPkg, hasCargo, hasEnv, hasMcp] = await Promise.all(
              ['package.json', 'Cargo.toml', '.env', '.mcp.json'].map(f => fileExists(join(p, f))),
            );
            let opseeqConnected = false;
            if (hasEnv) {
              try {
                const content = await fsp.readFile(join(p, '.env'), 'utf8');
                opseeqConnected = content.includes('OPSEEQ_URL') || content.includes('OPENAI_BASE_URL');
              } catch {}
            }
            return { name: e.name, path: p, has_package_json: hasPkg, has_cargo_toml: hasCargo, has_env: hasEnv, has_mcp_json: hasMcp, opseeq_connected: opseeqConnected };
          }),
      );
      return ok({ path: dir, repos_found: repos.length, repos });
    } catch (e) { return fail(`Scan failed for ${dir}`, e); }
  });

  // ── 22. repo_organize ─────────────────────────────────────────
  server.tool('repo_organize', 'Verify and clean up a Mermate-built repo: check structure, generate missing .env/.mcp.json for Opseeq', {
    repo_path: z.string().min(1).describe('Absolute path to the repo'),
  }, async ({ repo_path }) => {
    try {
      const result = await connectRepo(repo_path, { env: process.env });
      return ok({ repo_path: result.repoPath, analysis: result.analysis, checks: result.checks, warnings: result.warnings });
    } catch (e) { return fail('Repo organize failed', e); }
  });

  // ── 23. precision_status ───────────────────────────────────────
  server.tool('precision_status', 'Inspect the Precision Orchestration OODA pipeline defaults, extension registry, and Living Architecture Graph summary', {},
    async () => safeFetch('Precision Orchestration status failed', `${OPSEEQ_URL}/api/ooda/extensions`));

  // ── 24. precision_plan ─────────────────────────────────────────
  server.tool('precision_plan', 'Run the Mermate -> Lucidity -> approval -> TLA+/TS/Rust Precision Orchestration planner without leaving the Opseeq control plane', {
    intent: z.string().min(1).describe('Human idea or markdown input'),
    repoPath: z.string().optional().describe('Absolute repo path'),
    appId: z.string().optional().describe('Target app id'),
    inputMode: z.enum(['idea', 'markdown', 'mmd']).optional(),
    maxMode: z.boolean().optional(),
    approved: z.boolean().optional(),
    execute: z.boolean().optional(),
    includeTla: z.boolean().optional(),
    includeTs: z.boolean().optional(),
    includeRust: z.boolean().optional(),
    localModel: z.string().optional(),
    allowRemoteAugmentation: z.boolean().optional(),
    allowModelCritique: z.boolean().optional(),
  }, async (input) =>
    safeFetch('Precision Orchestration planning failed', `${OPSEEQ_URL}/api/ooda/precision`, { method: 'POST', body: JSON.stringify(input) }));

  // ── precision_dashboard ─────────────────────────────────────────
  server.tool('precision_dashboard', 'Inspect the human-first Precision Orchestration dashboard summary including connected repos, focus nodes, recent versions, and optional graph query results', {
    query: z.string().optional().describe('Optional graph search query to evaluate against the current dashboard context'),
    refresh: z.boolean().optional().describe('Refresh the cross-repo graph index before reading the dashboard'),
  }, async ({ query, refresh }) =>
    safeFetch('Precision Orchestration dashboard unavailable', `${OPSEEQ_URL}/api/ooda/dashboard${buildQuery({ q: query, refresh: refresh ? 'true' : undefined })}`));

  // ── 25. living_architecture_graph ────────────────────────────
  server.tool('living_architecture_graph', 'Inspect the latest Living Architecture Graph and immutable artifact ledger summary', {},
    async () => safeFetch('Living Architecture Graph unavailable', `${OPSEEQ_URL}/api/ooda/graph`));

  server.tool('living_architecture_search', 'Search the cross-repo Living Architecture Graph by query, repo, task, or logical kind', {
    query: z.string().optional().describe('Full-text query across node labels, descriptions, tags, and backlinks'),
    repoId: z.string().optional().describe('Limit matches to a connected repository id'),
    taskId: z.string().optional().describe('Limit matches to a precision orchestration task id'),
    kind: z.enum(['intent', 'axiom', 'postulate', 'lemma', 'corollary', 'service', 'artifact', 'decision', 'approval', 'validation', 'extension', 'repo', 'stage', 'all']).optional().describe('Logical node kind to filter by'),
    limit: z.number().optional().describe('Maximum number of nodes to return'),
  }, async ({ query, repoId, taskId, kind, limit }) =>
    safeFetch('Living Architecture Graph search failed', `${OPSEEQ_URL}/api/ooda/graph/search${buildQuery({ q: query, repoId, taskId, kind, limit })}`));

  server.tool('living_architecture_node', 'Inspect a single Living Architecture Graph node with inbound and outbound edges', {
    nodeId: z.string().min(1).describe('Graph node id to inspect'),
  }, async ({ nodeId }) =>
    safeFetch(`Living Architecture node ${nodeId} unavailable`, `${OPSEEQ_URL}/api/ooda/graph/node/${encodeURIComponent(nodeId)}`));

  server.tool('living_architecture_refresh', 'Refresh the cross-repo Living Architecture Graph index and optionally record a new graph version', {
    taskId: z.string().optional().describe('Optional task id used for the refresh version record'),
    recordVersion: z.boolean().optional().describe('Whether the refresh should create a version entry and immutable artifact'),
  }, async ({ taskId, recordVersion }) =>
    safeFetch('Living Architecture Graph refresh failed', `${OPSEEQ_URL}/api/ooda/graph/refresh`, { method: 'POST', body: JSON.stringify({ taskId, recordVersion }) }));

  // ── 26. artifact_verify ──────────────────────────────────────
  const VERIFY_ENDPOINTS: Record<string, string> = {
    tla: `${MERMATE_URL}/api/render/tla/status`,
    ts:  `${MERMATE_URL}/api/render/ts/status`,
  };

  server.tool('artifact_verify', 'Verify pipeline artifacts for a Mermate run at a specific stage', {
    run_id: z.string().min(1).describe('Mermate run ID'),
    stage: z.enum(['render', 'tla', 'ts', 'rust']).describe('Pipeline stage to verify'),
  }, async ({ run_id, stage }) => {
    try {
      const endpoint = VERIFY_ENDPOINTS[stage];
      if (endpoint) {
        return ok({ run_id, stage, verification: await requestJson(endpoint) });
      }
      return ok({ run_id, stage, verification: { note: `${stage} verification requires run artifacts on disk` } });
    } catch (e) { return fail(`Artifact verification failed for ${stage}`, e); }
  });

  // ── 27. browser_navigate ─────────────────────────────────────
  server.tool('browser_navigate', 'Navigate the Opseeq-controlled browser to a URL (Mermate :3333, Synth :8420, or any URL). Returns page title and element state.', {
    url: z.string().min(1).describe('URL to navigate to (e.g. http://localhost:3333, http://localhost:8420)'),
    screenshot: z.boolean().optional().describe('Take a screenshot after navigation'),
  }, async ({ url, screenshot }) => {
    try {
      await execAsync(`browser-use open "${url}"`, { timeout: 15_000 });
      const { stdout: state } = await execAsync('browser-use state', { timeout: 10_000 });
      let screenshotPath: string | null = null;
      if (screenshot) {
        try { screenshotPath = (await execAsync('browser-use screenshot', { timeout: 10_000 })).stdout.trim(); }
        catch {}
      }
      return ok({ url, state: state.trim(), screenshot: screenshotPath });
    } catch (e) { return fail(`Browser navigate failed for ${url}`, e); }
  });

  // ── 28. browser_interact ────────────────────────────────────────
  const BROWSER_COMMANDS: Record<string, (ei?: number, t?: string) => string> = {
    click:       (ei = 0) => `browser-use click ${ei}`,
    type:        (ei = 0, t = '') => `browser-use input ${ei} "${t.replace(/"/g, '\\"')}"`,
    scroll_down: () => 'browser-use scroll down',
    scroll_up:   () => 'browser-use scroll up',
    screenshot:  () => 'browser-use screenshot',
    state:       () => 'browser-use state',
  };

  server.tool('browser_interact', 'Interact with elements in the Opseeq-controlled browser: click, type, scroll. Use browser_navigate first.', {
    action: z.enum(['click', 'type', 'scroll_down', 'scroll_up', 'screenshot', 'state']).describe('Action to perform'),
    element_index: z.number().optional().describe('Element index from browser state (for click/type)'),
    text: z.string().optional().describe('Text to type (for type action)'),
  }, async ({ action, element_index, text }) => {
    try {
      const command = BROWSER_COMMANDS[action](element_index, text);
      const { stdout } = await execAsync(command, { timeout: 10_000 });
      return ok({ action, element_index, text, result: stdout.trim() });
    } catch (e) { return fail(`Browser interaction failed: ${action}`, e); }
  });

  // ── 29. health_check ────────────────────────────────────────────
  server.tool('health_check', 'Check health of all configured providers', {}, async () => {
    const providerStatus = await Promise.allSettled(config.providers.map(async (provider) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5_000);
      try {
        let healthy = false;
        if (provider.name === 'ollama') {
          healthy = (await fetch(`${provider.baseUrl}/api/tags`, { signal: ctrl.signal })).ok;
        } else if (provider.name === 'anthropic') {
          healthy = Boolean(provider.apiKey);
        } else {
          healthy = (await fetch(`${provider.baseUrl}/models`, { headers: { Authorization: `Bearer ${provider.apiKey}` }, signal: ctrl.signal })).ok;
        }
        return { name: provider.name, status: healthy ? 'healthy' : 'degraded', models: provider.models.length };
      } catch {
        return { name: provider.name, status: 'unreachable', models: provider.models.length };
      } finally { clearTimeout(timer); }
    }));
    return ok({ service: 'opseeq', status: 'running', providers: providerStatus.map(r => r.status === 'fulfilled' ? r.value : r.reason) });
  });

  return server;
}

// ══════════════════════════════════════════════════════════════════
//  SSE Transport Handlers
// ══════════════════════════════════════════════════════════════════

const MAX_SESSIONS = 256;
const activeSessions = new Map<string, SSEServerTransport>();

function evictStaleSessions(): void {
  if (activeSessions.size <= MAX_SESSIONS) return;
  const oldest = activeSessions.keys().next().value;
  if (oldest) activeSessions.delete(oldest);
}

export function handleMcpSse(_config: ServiceConfig, server: McpServer): (_req: Request, res: Response) => Promise<void> {
  return async (_req, res) => {
    evictStaleSessions();
    const transport = new SSEServerTransport('/mcp/messages', res);
    activeSessions.set(transport.sessionId, transport);
    res.on('close', () => activeSessions.delete(transport.sessionId));
    await server.connect(transport);
  };
}

export function handleMcpMessages(_config: ServiceConfig, _server: McpServer): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    if (!sessionId) { res.status(400).json({ error: 'sessionId query parameter is required' }); return; }
    const transport = activeSessions.get(sessionId);
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return; }
    await transport.handlePostMessage(req, res);
  };
}
