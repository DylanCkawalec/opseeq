import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import type { ServiceConfig } from './config.js';
import { routeInference, listModels } from './router.js';
import type { Request, Response } from 'express';

const MERMATE_URL = (process.env.MERMATE_URL || 'http://127.0.0.1:3333').replace(/\/+$/, '');
const SYNTH_URL = (process.env.SYNTHESIS_TRADE_URL || 'http://127.0.0.1:8420').replace(/\/+$/, '');
const OPSEEQ_URL = process.env.OPSEEQ_SELF_URL || 'http://127.0.0.1:9090';

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> ?? {}) }, signal: ctrl.signal });
    const payload = await res.json() as T;
    if (!res.ok) throw new Error(typeof payload === 'object' && payload !== null && 'error' in payload ? String((payload as { error: unknown }).error) : `${url} → ${res.status}`);
    return payload;
  } finally { clearTimeout(timer); }
}

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
function errorResult(msg: string, err: unknown) {
  return { content: [{ type: 'text' as const, text: `${msg}\n\n${err instanceof Error ? err.message : String(err)}` }], isError: true };
}

export function createMcpServer(config: ServiceConfig): McpServer {
  const server = new McpServer({ name: 'opseeq', version: '2.0.0' });

  // ── 1. opseeq_status ─────────────────────────────────────────
  server.tool('opseeq_status', 'Full gateway status: providers, models, Mermate, Synth, Ollama, MCP, connectivity', {}, async () => {
    try { return jsonResult(await requestJson(`${OPSEEQ_URL}/api/status`)); }
    catch (e) { return errorResult('Opseeq status unavailable', e); }
  });

  // ── 2. opseeq_chat ───────────────────────────────────────────
  server.tool('opseeq_chat', 'Send a prompt through the opseeq gateway (routes to NIM, OpenAI, Anthropic, or Ollama)', {
    prompt: z.string().min(1).describe('User prompt'),
    transport: z.enum(['opseeq', 'ollama']).optional().describe('Transport: opseeq (multi-provider) or ollama (local)'),
    model: z.string().optional().describe('Model override'),
    systemPrompt: z.string().optional().describe('Optional system prompt'),
  }, async ({ prompt, transport, model, systemPrompt }) => {
    try {
      const messages = [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), { role: 'user', content: prompt }];
      return jsonResult(await requestJson(`${OPSEEQ_URL}/api/chat`, { method: 'POST', body: JSON.stringify({ messages, transport, model }) }));
    } catch (e) { return errorResult('Chat failed', e); }
  });

  // ── 3. opseeq_connectivity_probe ──────────────────────────────
  server.tool('opseeq_connectivity_probe', 'Probe a host for network connectivity', {
    host: z.string().min(1).describe('Hostname to probe (e.g. github.com)'),
  }, async ({ host }) => {
    try { return jsonResult(await requestJson(`${OPSEEQ_URL}/api/connectivity/probe`, { method: 'POST', body: JSON.stringify({ host }) })); }
    catch (e) { return errorResult(`Probe failed for ${host}`, e); }
  });

  // ── 4. inference ──────────────────────────────────────────────
  server.tool('inference', 'Direct inference through multi-provider router', {
    model: z.string().describe('Model (e.g. gpt-4o, nvidia/nemotron-3-super-120b-a12b, claude-4-sonnet)'),
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
  server.tool('list_models', 'List all available models across providers', {}, async () => {
    return jsonResult(listModels(config));
  });

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
    return jsonResult(results.map((r, i) => r.status === 'fulfilled' ? r.value : { model: models[i], error: (r.reason as Error).message }));
  });

  // ── 7. architect_status ───────────────────────────────────────
  server.tool('architect_status', 'Inspect the Mermate architect profile and pipeline availability', {}, async () => {
    try { return jsonResult(await requestJson(`${OPSEEQ_URL}/api/architect/status`)); }
    catch (e) { return errorResult('Architect status failed', e); }
  });

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
  }, async (input) => {
    try { return jsonResult(await requestJson(`${OPSEEQ_URL}/api/architect/pipeline`, { method: 'POST', body: JSON.stringify(input) })); }
    catch (e) { return errorResult('Pipeline failed', e); }
  });

  // ── 9. builder_scaffold_repo ──────────────────────────────────
  server.tool('builder_scaffold_repo', 'Scaffold a starter repo from a Mermate run bundle', {
    runId: z.string().min(1),
    repoName: z.string().min(1),
    sourceIdea: z.string().min(1),
  }, async (input) => {
    try { return jsonResult(await requestJson(`${OPSEEQ_URL}/api/builder/scaffold`, { method: 'POST', body: JSON.stringify(input) })); }
    catch (e) { return errorResult('Scaffold failed', e); }
  });

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
      return jsonResult({ baseUrl: MERMATE_URL, copilot, tla, ts, modes, agents });
    } catch (e) { return errorResult(`Mermate unavailable at ${MERMATE_URL}`, e); }
  });

  // ── 11. mermate_agent_modes ───────────────────────────────────
  server.tool('mermate_agent_modes', 'List Mermate agent modes and loaded architecture specialists', {}, async () => {
    try {
      const [modes, agents] = await Promise.all([requestJson(`${MERMATE_URL}/api/agent/modes`), requestJson(`${MERMATE_URL}/api/agents`)]);
      return jsonResult({ baseUrl: MERMATE_URL, modes, agents });
    } catch (e) { return errorResult('Agent modes failed', e); }
  });

  // ── 12. mermate_render ────────────────────────────────────────
  server.tool('mermate_render', 'Send text/markdown/Mermaid to Mermate for compilation', {
    source: z.string().min(1).describe('Idea, markdown, or Mermaid source'),
    diagramName: z.string().optional(),
    inputMode: z.enum(['idea', 'markdown', 'mmd']).optional(),
    maxMode: z.boolean().optional(),
  }, async ({ source, diagramName, inputMode, maxMode }) => {
    try {
      return jsonResult(await requestJson(`${MERMATE_URL}/api/render`, {
        method: 'POST', body: JSON.stringify({ mermaid_source: source, diagram_name: diagramName, input_mode: inputMode, max_mode: maxMode }),
      }));
    } catch (e) { return errorResult('Mermate render failed', e); }
  });

  // ── 13. mermate_generate_tla ──────────────────────────────────
  server.tool('mermate_generate_tla', 'Generate TLA+ specification from a Mermate run', {
    runId: z.string().min(1),
    diagramName: z.string().optional(),
  }, async ({ runId, diagramName }) => {
    try {
      return jsonResult(await requestJson(`${MERMATE_URL}/api/render/tla`, { method: 'POST', body: JSON.stringify({ run_id: runId, diagram_name: diagramName }) }));
    } catch (e) { return errorResult('TLA+ generation failed', e); }
  });

  // ── 14. mermate_generate_ts ───────────────────────────────────
  server.tool('mermate_generate_ts', 'Generate TypeScript runtime from a Mermate run', {
    runId: z.string().min(1),
    diagramName: z.string().optional(),
  }, async ({ runId, diagramName }) => {
    try {
      return jsonResult(await requestJson(`${MERMATE_URL}/api/render/ts`, { method: 'POST', body: JSON.stringify({ run_id: runId, diagram_name: diagramName }) }));
    } catch (e) { return errorResult('TypeScript generation failed', e); }
  });

  // ── 15. health_check ──────────────────────────────────────────
  server.tool('health_check', 'Check health of all configured providers', {}, async () => {
    const providerStatus = await Promise.all(config.providers.map(async (p) => {
      try {
        const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 5000);
        let ok = false;
        if (p.name === 'ollama') { const r = await fetch(`${p.baseUrl}/api/tags`, { signal: ctrl.signal }); ok = r.ok; }
        else if (p.name === 'anthropic') { ok = !!p.apiKey; }
        else { const r = await fetch(`${p.baseUrl}/models`, { headers: { 'Authorization': `Bearer ${p.apiKey}` }, signal: ctrl.signal }); ok = r.ok; }
        return { name: p.name, status: ok ? 'healthy' : 'degraded', models: p.models.length };
      } catch { return { name: p.name, status: 'unreachable', models: p.models.length }; }
    }));
    return jsonResult({ service: 'opseeq', status: 'running', providers: providerStatus });
  });

  return server;
}

const activeSessions = new Map<string, SSEServerTransport>();

export function handleMcpSse(_config: ServiceConfig, server: McpServer) {
  return async (_req: Request, res: Response) => {
    const transport = new SSEServerTransport('/mcp/messages', res);
    activeSessions.set(transport.sessionId, transport);
    res.on('close', () => activeSessions.delete(transport.sessionId));
    await server.connect(transport);
  };
}

export function handleMcpMessages(_config: ServiceConfig, _server: McpServer) {
  return async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const transport = activeSessions.get(sessionId);
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return; }
    await transport.handlePostMessage(req, res);
  };
}
