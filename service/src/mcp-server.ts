import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import type { ServiceConfig } from './config.js';
import { routeInference, listModels } from './router.js';
import type { Request, Response } from 'express';

const MERMATE_URL = (process.env.MERMATE_URL || 'http://127.0.0.1:3333').replace(/\/+$/, '');
const SYNTH_URL = (process.env.SYNTHESIS_TRADE_URL || 'http://127.0.0.1:8420').replace(/\/+$/, '');
const OPSEEQ_URL = process.env.OPSEEQ_SELF_URL || 'http://127.0.0.1:9090';

const SELF_AUTH_KEY = (() => {
  const raw = process.env.OPSEEQ_API_KEYS || process.env.OPSEEQ_API_KEY || '';
  const first = raw.split(',').map(s => s.trim()).find(s => s.length > 0);
  return first || '';
})();

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
  const server = new McpServer({ name: 'opseeq', version: '5.0.0' });

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

  // ── 15. synth_status ──────────────────────────────────────────
  server.tool('synth_status', 'Deep status of the Synth prediction/trading desk: simulation mode, approval state, AI availability, predictions, opseeq connectivity', {}, async () => {
    try {
      const data = await requestJson<Record<string, unknown>>(`${SYNTH_URL}/api/health`, {});
      return jsonResult({
        purpose: 'synth_trading_desk',
        baseUrl: SYNTH_URL,
        status: (data as { status?: string }).status,
        simulationMode: (data as { simulation_mode?: boolean }).simulation_mode,
        approvalRequired: (data as { approval_required?: boolean }).approval_required,
        aiAvailable: (data as { ai_engine_available?: boolean }).ai_engine_available,
        predictions: (data as { predictions?: number }).predictions,
        opseeq: (data as { opseeq?: unknown }).opseeq,
      });
    } catch (e) { return errorResult(`Synth unavailable at ${SYNTH_URL}`, e); }
  });

  // ── 16. synth_predict ────────────────────────────────────────
  server.tool('synth_predict', 'Generate a market prediction through the Synth prediction engine', {
    query: z.string().min(1).describe('Market question or prediction query'),
    wallet_id: z.string().optional().describe('Wallet ID for portfolio context'),
  }, async ({ query, wallet_id }) => {
    try {
      return jsonResult(await requestJson(`${SYNTH_URL}/api/predictions/generate`, {
        method: 'POST',
        body: JSON.stringify({ query, wallet_id }),
      }));
    } catch (e) { return errorResult('Synth prediction failed', e); }
  });

  // ── 17. synth_predictions ────────────────────────────────────
  server.tool('synth_predictions', 'List recent predictions from the Synth desk', {
    limit: z.number().optional().describe('Max predictions to return'),
  }, async ({ limit }) => {
    try {
      const url = limit ? `${SYNTH_URL}/api/predictions/history?limit=${limit}` : `${SYNTH_URL}/api/predictions/history`;
      return jsonResult(await requestJson(url));
    } catch (e) { return errorResult('Failed to fetch predictions', e); }
  });

  // ── 18. synth_markets ────────────────────────────────────────
  server.tool('synth_markets', 'Search available prediction markets through the Synth desk', {
    query: z.string().min(1).describe('Market search query'),
    limit: z.number().optional().describe('Max results'),
  }, async ({ query, limit }) => {
    try {
      const url = `${SYNTH_URL}/api/markets/search/${encodeURIComponent(query)}${limit ? `?limit=${limit}` : ''}`;
      return jsonResult(await requestJson(url));
    } catch (e) { return errorResult('Market search failed', e); }
  });

  // ── 19. synth_portfolio ──────────────────────────────────────
  server.tool('synth_portfolio', 'Get portfolio summary from the Synth trading desk', {
    wallet_id: z.string().optional().describe('Wallet ID'),
  }, async ({ wallet_id }) => {
    try {
      const url = wallet_id ? `${SYNTH_URL}/api/portfolio/summary?wallet_id=${wallet_id}` : `${SYNTH_URL}/api/portfolio/summary`;
      return jsonResult(await requestJson(url));
    } catch (e) { return errorResult('Portfolio fetch failed', e); }
  });

  // ── 20. pipeline_orchestrate ───────────────────────────────────
  server.tool('pipeline_orchestrate', 'Run full Mermate pipeline step-by-step: render -> TLA+ -> TS -> Rust with Opseeq reviewing between stages', {
    source: z.string().min(1).describe('Idea, markdown, or Mermaid source'),
    inputMode: z.enum(['idea', 'markdown', 'mmd']).optional(),
    maxMode: z.boolean().optional(),
    includeTla: z.boolean().optional().default(true),
    includeTs: z.boolean().optional().default(true),
    includeRust: z.boolean().optional().default(false),
  }, async ({ source, inputMode, maxMode, includeTla, includeTs, includeRust }) => {
    const stages: Array<{ stage: string; duration_ms: number; success: boolean; validation?: unknown; error?: string }> = [];
    const startAll = Date.now();
    try {
      const t0 = Date.now();
      const renderResult = await requestJson<Record<string, unknown>>(`${MERMATE_URL}/api/render`, {
        method: 'POST', body: JSON.stringify({ mermaid_source: source, input_mode: inputMode, max_mode: maxMode }),
      });
      const runId = (renderResult.run_id || renderResult.runId || '') as string;
      stages.push({ stage: 'render', duration_ms: Date.now() - t0, success: true, validation: renderResult.validation });

      if (includeTla && runId) {
        const t1 = Date.now();
        try {
          const tlaResult = await requestJson<Record<string, unknown>>(`${MERMATE_URL}/api/render/tla`, {
            method: 'POST', body: JSON.stringify({ run_id: runId }),
          });
          stages.push({ stage: 'tla', duration_ms: Date.now() - t1, success: true, validation: tlaResult.validation });
        } catch (e) { stages.push({ stage: 'tla', duration_ms: Date.now() - t1, success: false, error: e instanceof Error ? e.message : String(e) }); }
      }

      if (includeTs && runId) {
        const t2 = Date.now();
        try {
          const tsResult = await requestJson<Record<string, unknown>>(`${MERMATE_URL}/api/render/ts`, {
            method: 'POST', body: JSON.stringify({ run_id: runId }),
          });
          stages.push({ stage: 'ts', duration_ms: Date.now() - t2, success: (tsResult.validation as Record<string, unknown>)?.success !== false, validation: tsResult.validation });
        } catch (e) { stages.push({ stage: 'ts', duration_ms: Date.now() - t2, success: false, error: e instanceof Error ? e.message : String(e) }); }
      }

      if (includeRust && runId) {
        const t3 = Date.now();
        try {
          const rustResult = await requestJson<Record<string, unknown>>(`${MERMATE_URL}/api/render/rust`, {
            method: 'POST', body: JSON.stringify({ run_id: runId }),
          });
          stages.push({ stage: 'rust', duration_ms: Date.now() - t3, success: true, validation: rustResult.rust_metrics });
        } catch (e) { stages.push({ stage: 'rust', duration_ms: Date.now() - t3, success: false, error: e instanceof Error ? e.message : String(e) }); }
      }

      return jsonResult({
        purpose: 'mermate_full_pipeline',
        run_id: runId,
        total_duration_ms: Date.now() - startAll,
        stages_completed: stages.filter(s => s.success).length,
        stages_failed: stages.filter(s => !s.success).length,
        stages,
      });
    } catch (e) {
      return errorResult('Pipeline orchestration failed at render stage', e);
    }
  });

  // ── 21. desktop_scan (async fs) ──────────────────────────────
  server.tool('desktop_scan', 'Scan a directory (default ~/Desktop/developer/) for repos and their Opseeq connection status', {
    path: z.string().optional().describe('Directory to scan (default: ~/Desktop/developer/)'),
  }, async ({ path: scanPath }) => {
    const dir = scanPath || `${process.env.HOME || '/tmp'}/Desktop/developer`;
    try {
      const fsp = (await import('node:fs')).promises;
      const pathMod = await import('node:path');
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const repos = await Promise.all(
        entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
          .map(async e => {
            const p = pathMod.join(dir, e.name);
            const check = async (f: string) => fsp.access(pathMod.join(p, f)).then(() => true, () => false);
            const [hasPkg, hasCargo, hasEnv, hasMcp] = await Promise.all([
              check('package.json'), check('Cargo.toml'), check('.env'), check('.mcp.json'),
            ]);
            let opseeqConnected = false;
            if (hasEnv) {
              try {
                const envContent = await fsp.readFile(pathMod.join(p, '.env'), 'utf8');
                opseeqConnected = envContent.includes('OPSEEQ_URL') || envContent.includes('OPENAI_BASE_URL');
              } catch {}
            }
            return { name: e.name, path: p, has_package_json: hasPkg, has_cargo_toml: hasCargo, has_env: hasEnv, has_mcp_json: hasMcp, opseeq_connected: opseeqConnected };
          }),
      );
      return jsonResult({ path: dir, repos_found: repos.length, repos });
    } catch (e) { return errorResult(`Scan failed for ${dir}`, e); }
  });

  // ── 22. repo_organize (async fs) ─────────────────────────────
  server.tool('repo_organize', 'Verify and clean up a Mermate-built repo: check structure, generate missing .env/.mcp.json for Opseeq', {
    repo_path: z.string().min(1).describe('Absolute path to the repo'),
  }, async ({ repo_path }) => {
    try {
      const fsp = (await import('node:fs')).promises;
      const pathMod = await import('node:path');

      const safeRoot = process.env.HOME || '/tmp';
      const resolved = pathMod.resolve(repo_path);
      if (!resolved.startsWith(safeRoot)) {
        return errorResult('Path must be under home directory', new Error(`path traversal blocked: ${resolved}`));
      }
      try {
        const stat = await fsp.lstat(resolved);
        if (stat.isSymbolicLink()) {
          return errorResult('Symlinks not allowed for repo root', new Error('symlink detected'));
        }
        if (!stat.isDirectory()) {
          return errorResult('Path is not a directory', new Error(`not a directory: ${resolved}`));
        }
      } catch (statErr) {
        return errorResult('Path not accessible', statErr);
      }

      const checks: Array<{ item: string; status: string; action?: string }> = [];
      const exists = async (f: string) => fsp.access(pathMod.join(resolved, f)).then(() => true, () => false);

      const [hasPkg, hasCargo, hasReadme, hasRun] = await Promise.all([
        exists('package.json'), exists('Cargo.toml'), exists('README.md'), exists('run.sh'),
      ]);
      checks.push({ item: 'project_file', status: hasPkg || hasCargo ? 'found' : 'missing' });
      checks.push({ item: 'README.md', status: hasReadme ? 'found' : 'missing' });
      checks.push({ item: 'run.sh', status: hasRun ? 'found' : 'missing' });

      const envPath = pathMod.join(resolved, '.env');
      if (!(await exists('.env'))) {
        await fsp.writeFile(envPath, `# Opseeq connection\nOPENAI_BASE_URL=http://localhost:9090/v1\nOPSEEQ_URL=http://localhost:9090\n`);
        checks.push({ item: '.env', status: 'created', action: 'Generated with Opseeq connection vars' });
      } else {
        const content = await fsp.readFile(envPath, 'utf8');
        if (!content.includes('OPSEEQ_URL')) {
          await fsp.appendFile(envPath, `\n# Opseeq connection\nOPSEEQ_URL=http://localhost:9090\n`);
          checks.push({ item: '.env', status: 'updated', action: 'Appended OPSEEQ_URL' });
        } else {
          checks.push({ item: '.env', status: 'found' });
        }
      }

      const mcpPath = pathMod.join(resolved, '.mcp.json');
      if (!(await exists('.mcp.json'))) {
        await fsp.writeFile(mcpPath, JSON.stringify({ mcpServers: { opseeq: { url: 'http://localhost:9090/mcp' } } }, null, 2) + '\n');
        checks.push({ item: '.mcp.json', status: 'created', action: 'Generated for Opseeq MCP' });
      } else {
        checks.push({ item: '.mcp.json', status: 'found' });
      }

      if (hasCargo) {
        const hasBin = await exists('target/release');
        checks.push({ item: 'rust_binary', status: hasBin ? 'found' : 'not_built' });
      }

      return jsonResult({ repo_path: resolved, checks });
    } catch (e) { return errorResult('Repo organize failed', e); }
  });

  // ── 23. artifact_verify ──────────────────────────────────────
  server.tool('artifact_verify', 'Verify pipeline artifacts for a Mermate run at a specific stage', {
    run_id: z.string().min(1).describe('Mermate run ID'),
    stage: z.enum(['render', 'tla', 'ts', 'rust']).describe('Pipeline stage to verify'),
  }, async ({ run_id, stage }) => {
    try {
      if (stage === 'tla') {
        const result = await requestJson(`${MERMATE_URL}/api/render/tla/status`);
        return jsonResult({ run_id, stage, verification: result });
      } else if (stage === 'ts') {
        const result = await requestJson(`${MERMATE_URL}/api/render/ts/status`);
        return jsonResult({ run_id, stage, verification: result });
      } else {
        return jsonResult({ run_id, stage, verification: { note: `${stage} verification requires run artifacts on disk` } });
      }
    } catch (e) { return errorResult(`Artifact verification failed for ${stage}`, e); }
  });

  // ── 25. browser_navigate ─────────────────────────────────────
  server.tool('browser_navigate', 'Navigate the Opseeq-controlled browser to a URL (Mermate :3333, Synth :8420, or any URL). Returns page title and element state.', {
    url: z.string().min(1).describe('URL to navigate to (e.g. http://localhost:3333, http://localhost:8420)'),
    screenshot: z.boolean().optional().describe('Take a screenshot after navigation'),
  }, async ({ url, screenshot }) => {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    try {
      await execAsync(`browser-use open "${url}"`, { timeout: 15_000 });
      const { stdout: state } = await execAsync('browser-use state', { timeout: 10_000 });
      let screenshotPath: string | null = null;
      if (screenshot) {
        try {
          const { stdout: ssOut } = await execAsync('browser-use screenshot', { timeout: 10_000 });
          screenshotPath = ssOut.trim();
        } catch {}
      }
      return jsonResult({ url, state: state.trim(), screenshot: screenshotPath });
    } catch (e) { return errorResult(`Browser navigate failed for ${url}`, e); }
  });

  // ── 26. browser_interact ────────────────────────────────────
  server.tool('browser_interact', 'Interact with elements in the Opseeq-controlled browser: click, type, scroll. Use browser_navigate first.', {
    action: z.enum(['click', 'type', 'scroll_down', 'scroll_up', 'screenshot', 'state']).describe('Action to perform'),
    element_index: z.number().optional().describe('Element index from browser state (for click/type)'),
    text: z.string().optional().describe('Text to type (for type action)'),
  }, async ({ action, element_index, text }) => {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    try {
      let cmd: string;
      switch (action) {
        case 'click': cmd = `browser-use click ${element_index ?? 0}`; break;
        case 'type': cmd = `browser-use input ${element_index ?? 0} "${(text ?? '').replace(/"/g, '\\"')}"`; break;
        case 'scroll_down': cmd = 'browser-use scroll down'; break;
        case 'scroll_up': cmd = 'browser-use scroll up'; break;
        case 'screenshot': cmd = 'browser-use screenshot'; break;
        case 'state': cmd = 'browser-use state'; break;
        default: cmd = 'browser-use state';
      }
      const { stdout } = await execAsync(cmd, { timeout: 10_000 });
      return jsonResult({ action, element_index, text, result: stdout.trim() });
    } catch (e) { return errorResult(`Browser interaction failed: ${action}`, e); }
  });

  // ── 27. health_check ─────────────────────────────────────────
  server.tool('health_check', 'Check health of all configured providers', {}, async () => {
    const providerStatus = await Promise.all(config.providers.map(async (p) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        let ok = false;
        if (p.name === 'ollama') { const r = await fetch(`${p.baseUrl}/api/tags`, { signal: ctrl.signal }); ok = r.ok; }
        else if (p.name === 'anthropic') { ok = !!p.apiKey; }
        else { const r = await fetch(`${p.baseUrl}/models`, { headers: { 'Authorization': `Bearer ${p.apiKey}` }, signal: ctrl.signal }); ok = r.ok; }
        return { name: p.name, status: ok ? 'healthy' : 'degraded', models: p.models.length };
      } catch { return { name: p.name, status: 'unreachable', models: p.models.length }; }
      finally { clearTimeout(timer); }
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
