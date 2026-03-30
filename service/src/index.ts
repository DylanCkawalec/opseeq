import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import http from 'node:http';
import { loadConfig, type ServiceConfig } from './config.js';
import { routeInference, routeInferenceStream, listModels, setKernel } from './router.js';
import { createMcpServer, handleMcpSse, handleMcpMessages } from './mcp-server.js';
import { KernelClient } from './kernel.js';
import type { ChatCompletionRequest } from './router.js';

const config = loadConfig();
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const VERSION = '3.0.0';

// ── Request ID + structured logging ──────────────────────────────
app.use((req, _res, next) => {
  (req as any).id = (req.headers['x-request-id'] as string) || crypto.randomUUID().slice(0, 12);
  next();
});

function log(level: string, msg: string, meta?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ── Per-IP rate limiter (sliding window, in-memory) ──────────────
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT - bucket.count)));
  if (bucket.count > RATE_LIMIT) {
    res.status(429).json({ error: { message: 'Rate limit exceeded', type: 'rate_limit' } });
    return;
  }
  next();
}
app.use(rateLimit);

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) { if (now >= b.resetAt) rateBuckets.delete(ip); }
}, 60_000);
const serverStartedAt = new Date().toISOString();

const MERMATE_URL = (process.env.MERMATE_URL || 'http://127.0.0.1:3333').replace(/\/+$/, '');
const SYNTH_URL = (process.env.SYNTHESIS_TRADE_URL || 'http://127.0.0.1:8420').replace(/\/+$/, '');
const OLLAMA_URL = (process.env.OLLAMA_URL || process.env.LOCAL_LLM_BASE_URL || '').replace(/\/+$/, '');
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.LOCAL_LLM_MODEL || 'gpt-oss:20b';

// ── Graceful shutdown state ──────────────────────────────────────
let isShuttingDown = false;
let httpServer: http.Server | null = null;
const watchIntervals: ReturnType<typeof setInterval>[] = [];

function shutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[opseeq] ${signal} received — draining connections (5s grace)…`);
  for (const iv of watchIntervals) clearInterval(iv);
  kernel.stop();
  if (httpServer) {
    httpServer.close(() => {
      console.log('[opseeq] All connections drained. Exiting.');
      process.exit(0);
    });
    setTimeout(() => {
      console.log('[opseeq] Grace period expired. Force exit.');
      process.exit(1);
    }, 5_000).unref();
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Auth middleware ────────────────────────────────────────────────
function authenticate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (config.apiKeys.length === 0) { next(); return; }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { message: 'Missing Authorization header', type: 'auth_error' } });
    return;
  }
  if (!config.apiKeys.includes(authHeader.slice(7))) {
    res.status(403).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
    return;
  }
  next();
}

// ── Idle shutdown (serverless + explicit) ─────────────────────────
let lastRequestAt = Date.now();
const idleEnabled = config.serverlessMode || process.env.OPSEEQ_IDLE_SHUTDOWN === 'true';
if (idleEnabled) {
  const idleCheck = setInterval(() => {
    const idleMs = Date.now() - lastRequestAt;
    if (idleMs > config.idleTimeoutMs * 0.75) console.log(`[opseeq] Idle warning: ${Math.round(idleMs / 1000)}s / ${Math.round(config.idleTimeoutMs / 1000)}s`);
    if (idleMs > config.idleTimeoutMs) shutdown('idle-timeout');
  }, 30_000);
  watchIntervals.push(idleCheck);
}
app.use((_req, _res, next) => { lastRequestAt = Date.now(); next(); });

// ── Timed cache helper ───────────────────────────────────────────
function timedCache<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
  let cached: T | undefined; let expiresAt = 0;
  return async () => {
    if (cached !== undefined && Date.now() < expiresAt) return cached;
    cached = await fn();
    expiresAt = Date.now() + ttlMs;
    return cached;
  };
}

// ── Shared fetch helper ──────────────────────────────────────────
async function fetchJson<T>(url: string, opts: { timeoutMs?: number; method?: string; body?: string } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return await res.json() as T;
  } finally { clearTimeout(timer); }
}

async function probeService(baseUrl: string, path: string, timeoutMs = 2500): Promise<{ ok: boolean; data?: unknown; ms: number }> {
  const start = Date.now();
  try {
    const data = await fetchJson(`${baseUrl}${path}`, { timeoutMs });
    return { ok: true, data, ms: Date.now() - start };
  } catch {
    return { ok: false, ms: Date.now() - start };
  }
}

// ── Synth desk watch (background polling) ─────────────────────────
interface SynthWatchState {
  reachable: boolean; verified: boolean; simulationMode: boolean | null;
  approvalRequired: boolean | null; aiEngineAvailable: boolean | null;
  predictionsAvailable: boolean | null; version: string | null;
  latencyMs: number | null; probedAt: string;
  registeredAt: string | null; lastVerifiedAt: string | null;
  consecutiveSuccesses: number; consecutiveFailures: number;
  error: string | null;
}

const synthWatch: SynthWatchState = {
  reachable: false, verified: false, simulationMode: null,
  approvalRequired: null, aiEngineAvailable: null, predictionsAvailable: null,
  version: null, latencyMs: null, probedAt: '',
  registeredAt: null, lastVerifiedAt: null,
  consecutiveSuccesses: 0, consecutiveFailures: 0, error: null,
};

async function pollSynth(): Promise<void> {
  const t0 = Date.now();
  try {
    const d = await fetchJson<Record<string, unknown>>(`${SYNTH_URL}/health`, { timeoutMs: 2000 });
    const ms = Date.now() - t0;
    const verified = (d as { status?: string }).status === 'ok';
    synthWatch.reachable = true;
    synthWatch.verified = verified;
    synthWatch.latencyMs = ms;
    synthWatch.probedAt = new Date().toISOString();
    synthWatch.simulationMode = (d as { simulation_mode?: boolean }).simulation_mode ?? null;
    synthWatch.approvalRequired = (d as { approval_required?: boolean }).approval_required ?? null;
    synthWatch.aiEngineAvailable = (d as { ai_engine_available?: boolean }).ai_engine_available ?? null;
    synthWatch.predictionsAvailable = (d as { predictions?: number }).predictions != null ? Number((d as { predictions: number }).predictions) > 0 : null;
    synthWatch.version = (d as { version?: string }).version ?? null;
    synthWatch.error = null;
    if (verified) {
      synthWatch.consecutiveSuccesses++;
      synthWatch.consecutiveFailures = 0;
      if (!synthWatch.registeredAt) synthWatch.registeredAt = new Date().toISOString();
      synthWatch.lastVerifiedAt = new Date().toISOString();
    }
  } catch (err) {
    synthWatch.reachable = false; synthWatch.verified = false;
    synthWatch.consecutiveFailures++; synthWatch.consecutiveSuccesses = 0;
    synthWatch.latencyMs = Date.now() - t0;
    synthWatch.probedAt = new Date().toISOString();
    synthWatch.error = err instanceof Error ? err.message : String(err);
  }
}

// ── Mermate deep probe ───────────────────────────────────────────
interface MermateState {
  running: boolean; copilotAvailable: boolean; maxModeAvailable: boolean;
  tlaAvailable: boolean; tsAvailable: boolean;
  providers: Record<string, boolean> | null;
  agentModes: Array<{ id: string; label: string; description: string; stage: string }>;
  agentsLoaded: number; agentDomains: string[];
  probedAt: string; probeDurationMs: number;
  registeredAt: string | null; lastHealthyAt: string | null;
}

let mermateRegisteredAt: string | null = null;

async function getMermateState(): Promise<MermateState> {
  const t0 = Date.now();
  const [copilot, tla, ts, modes, agents] = await Promise.all([
    fetchJson<{ available?: boolean; providers?: Record<string, boolean>; maxAvailable?: boolean }>(`${MERMATE_URL}/api/copilot/health`, { timeoutMs: 1200 }).catch(() => null),
    fetchJson<{ available?: boolean }>(`${MERMATE_URL}/api/render/tla/status`, { timeoutMs: 1200 }).catch(() => null),
    fetchJson<{ available?: boolean }>(`${MERMATE_URL}/api/render/ts/status`, { timeoutMs: 1200 }).catch(() => null),
    fetchJson<{ modes?: Array<{ id: string; label: string; description: string; stage: string }> }>(`${MERMATE_URL}/api/agent/modes`, { timeoutMs: 1200 }).catch(() => null),
    fetchJson<{ agents?: Array<{ name: string; domain?: string }> }>(`${MERMATE_URL}/api/agents`, { timeoutMs: 1200 }).catch(() => null),
  ]);
  const running = Boolean(copilot || tla || ts || modes || agents);
  if (running && !mermateRegisteredAt) mermateRegisteredAt = new Date().toISOString();
  const agentDomains = [...new Set((agents?.agents ?? []).map(a => a.domain).filter((d): d is string => !!d))].sort();
  return {
    running, copilotAvailable: copilot?.available ?? false,
    maxModeAvailable: copilot?.maxAvailable ?? false,
    providers: copilot?.providers ?? null,
    tlaAvailable: tla?.available ?? false, tsAvailable: ts?.available ?? false,
    agentModes: (modes?.modes ?? []).map(m => ({ id: m.id, label: m.label, description: m.description, stage: m.stage })),
    agentsLoaded: (agents?.agents ?? []).length, agentDomains,
    probedAt: new Date().toISOString(), probeDurationMs: Date.now() - t0,
    registeredAt: mermateRegisteredAt, lastHealthyAt: running ? new Date().toISOString() : null,
  };
}

// ── Ollama state ─────────────────────────────────────────────────
interface OllamaModel { name: string; size: number; family: string | null; isCloud: boolean }
interface OllamaState { available: boolean; models: OllamaModel[]; defaultModel: string; probedAt: string; probeDurationMs: number }

async function getOllamaState(): Promise<OllamaState> {
  if (!OLLAMA_URL) return { available: false, models: [], defaultModel: DEFAULT_OLLAMA_MODEL, probedAt: new Date().toISOString(), probeDurationMs: 0 };
  const t0 = Date.now();
  try {
    const d = await fetchJson<{ models: Array<{ name: string; size: number; remote_host?: string; details: { family?: string } }> }>(`${OLLAMA_URL}/api/tags`, { timeoutMs: 1500 });
    const models = (d.models ?? []).map(m => ({
      name: m.name, size: m.size, family: m.details?.family ?? null, isCloud: !!m.remote_host,
    }));
    return { available: models.length > 0, models, defaultModel: models.find(m => m.name === DEFAULT_OLLAMA_MODEL)?.name || models[0]?.name || DEFAULT_OLLAMA_MODEL, probedAt: new Date().toISOString(), probeDurationMs: Date.now() - t0 };
  } catch {
    return { available: false, models: [], defaultModel: DEFAULT_OLLAMA_MODEL, probedAt: new Date().toISOString(), probeDurationMs: Date.now() - t0 };
  }
}

async function chatWithOllama(messages: Array<{ role: string; content: string }>, model?: string) {
  if (!OLLAMA_URL) throw new Error('Ollama not configured (set OLLAMA_URL)');
  const m = model || DEFAULT_OLLAMA_MODEL;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: m, messages, stream: false }),
  });
  const raw = await res.json() as { model?: string; message?: { role: string; content: string; thinking?: string } };
  if (!res.ok || !raw.message?.content?.trim()) {
    return { ok: false, payload: { error: `Ollama chat failed: ${res.status}`, model: m, transport: 'ollama_local' } };
  }
  return {
    ok: true,
    payload: {
      message: { role: raw.message.role, content: raw.message.content.trim(), reasoning: raw.message.thinking?.trim() || null },
      model: raw.model || m, requestedModel: m, transport: 'ollama_local',
    },
  };
}

// ── Cached accessors ─────────────────────────────────────────────
const getCachedMermateState = timedCache(5_000, getMermateState);
const getCachedOllamaState = timedCache(10_000, getOllamaState);
const getCachedModels = timedCache(30_000, async () => listModels(config));

// ── Mermate background watch ─────────────────────────────────────
let mermateWatchRunning = false;
let mermateWatchLastHealthy: string | null = null;

async function pollMermate(): Promise<void> {
  try {
    const state = await getMermateState();
    const wasRunning = mermateWatchRunning;
    mermateWatchRunning = state.running;
    if (state.running) mermateWatchLastHealthy = new Date().toISOString();
    if (!wasRunning && state.running) console.log(`  [mermate-watch] Mermate came online at ${MERMATE_URL} (${state.probeDurationMs}ms)`);
    else if (wasRunning && !state.running) console.log(`  [mermate-watch] Mermate went offline`);
  } catch { mermateWatchRunning = false; }
}

// ══════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════

app.get('/health', (_req, res) => {
  if (isShuttingDown) { res.status(503).json({ status: 'shutting_down' }); return; }
  res.json({
    status: 'ok', version: VERSION,
    providers: config.providers.map(p => ({ name: p.name, models: p.models.length })),
    mcp: config.mcpEnabled, serverless: config.serverlessMode, uptime: process.uptime(),
  });
});

app.get('/health/ready', (_req, res) => {
  if (isShuttingDown) { res.status(503).json({ ready: false, reason: 'shutting_down' }); return; }
  res.json({ ready: true, uptime: process.uptime() });
});

app.get('/v1/health', (_req, res) => {
  if (isShuttingDown) { res.status(503).json({ status: 'shutting_down' }); return; }
  res.json({ status: 'ok' });
});

app.get('/v1/models', authenticate, async (_req, res) => {
  const models = await getCachedModels();
  res.json({ object: 'list', data: models.map(m => ({ id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.provider })) });
});

app.post('/v1/chat/completions', authenticate, async (req, res) => {
  try {
    const body = req.body as ChatCompletionRequest;
    if (!body.messages?.length) { res.status(400).json({ error: { message: 'messages required', type: 'invalid_request' } }); return; }
    body.model = body.model || config.defaultModel;
    if (body.stream) {
      try {
        const { stream, provider } = await routeInferenceStream(body, config);
        res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Opseeq-Provider', provider);
        const reader = stream.getReader(); const dec = new TextDecoder();
        const pump = async (): Promise<void> => { const { done, value } = await reader.read(); if (done) { res.end(); return; } res.write(dec.decode(value, { stream: true })); return pump(); };
        await pump();
      } catch { const fb = await routeInference({ ...body, stream: false }, config); res.json(fb); }
      return;
    }
    res.json(await routeInference(body, config));
  } catch (err) {
    res.status(502).json({ error: { message: err instanceof Error ? err.message : 'upstream error', type: 'upstream_error' } });
  }
});

app.post('/v1/embeddings', authenticate, async (req, res) => {
  const provider = config.providers.find(p => p.name !== 'ollama' && p.name !== 'anthropic');
  if (!provider) { res.status(503).json({ error: { message: 'No embedding provider' } }); return; }
  try {
    const up = await fetch(`${provider.baseUrl}/embeddings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify(req.body),
    });
    res.status(up.status).json(await up.json());
  } catch (err) { res.status(502).json({ error: { message: err instanceof Error ? err.message : 'error' } }); }
});

// ── MCP ───────────────────────────────────────────────────────────
if (config.mcpEnabled) {
  const mcpServer = createMcpServer(config);
  app.get('/mcp', authenticate, handleMcpSse(config, mcpServer));
  app.post('/mcp/messages', authenticate, handleMcpMessages(config, mcpServer));
}

// ══════════════════════════════════════════════════════════════════
//  Console-compatible /api/* routes
// ══════════════════════════════════════════════════════════════════

app.get('/api/status', authenticate, async (_req, res) => {
  const allModels = await getCachedModels();
  const [mermate, ollama] = await Promise.all([getCachedMermateState(), getCachedOllamaState()]);
  res.json({
    meta: { generatedAt: new Date().toISOString(), serverStartedAt, uptimeSeconds: process.uptime(), version: VERSION },
    controls: {
      urls: { opseeq: `http://127.0.0.1:${config.port}`, mermate: MERMATE_URL, synthesisTrade: SYNTH_URL, ollama: OLLAMA_URL || null },
      env: {
        MERMATE_URL: process.env.MERMATE_URL ?? `(default ${MERMATE_URL})`,
        SYNTHESIS_TRADE_URL: process.env.SYNTHESIS_TRADE_URL ?? `(default ${SYNTH_URL})`,
        OLLAMA_URL: process.env.OLLAMA_URL ?? '(not set)',
      },
    },
    sandbox: { available: true, mode: 'opseeq-gateway', name: 'opseeq' },
    inference: {
      available: config.providers.length > 0,
      models: allModels.map(m => m.id), defaultModel: config.defaultModel,
      providerCount: config.providers.length,
    },
    providers: config.providers.map(p => ({ name: p.name, type: p.name.includes('nim') ? 'nvidia' : 'openai-compat' })),
    ollama, mermate: { id: 'mermate', label: 'Mermate architecture copilot', role: 'diagram_tla_ts_pipeline', baseUrl: MERMATE_URL, ...mermate },
    synthesisTrade: {
      id: 'synthesis-trade', label: 'Synth trading desk', role: 'prediction_market_desk',
      baseUrl: SYNTH_URL, ...synthWatch,
      watch: { consecutiveSuccesses: synthWatch.consecutiveSuccesses, consecutiveFailures: synthWatch.consecutiveFailures, pollIntervalSeconds: 8 },
    },
    mcp: { enabled: config.mcpEnabled, endpoint: '/mcp', transport: 'sse' },
    transport: { primary: 'multi-provider (NIM > OpenAI > Anthropic > Ollama)', mode: 'opseeq-gateway' },
  });
});

app.get('/api/integrations', authenticate, async (_req, res) => {
  const mermate = await getCachedMermateState();
  res.json({
    meta: { generatedAt: new Date().toISOString(), serverStartedAt, uptimeSeconds: process.uptime(), version: VERSION },
    controls: { urls: { opseeq: `http://127.0.0.1:${config.port}`, mermate: MERMATE_URL, synthesisTrade: SYNTH_URL } },
    mermate: { id: 'mermate', baseUrl: MERMATE_URL, ...mermate },
    synthesisTrade: { id: 'synthesis-trade', baseUrl: SYNTH_URL, ...synthWatch },
  });
});

app.post('/api/chat', authenticate, async (req, res) => {
  try {
    const { messages, model: reqModel, transport } = req.body || {};
    if (!messages?.length) { res.status(400).json({ error: 'messages array required' }); return; }

    if (transport === 'ollama') {
      const result = await chatWithOllama(messages, reqModel);
      res.status(result.ok ? 200 : 502).json(result);
      return;
    }

    const model = reqModel || config.defaultModel;
    const result = await routeInference({ model, messages, temperature: 0 }, config);
    const content = result.choices?.[0]?.message?.content || '';
    res.json({
      ok: true,
      payload: {
        message: { role: 'assistant', content, reasoning: null },
        model: result.model || model, requestedModel: model,
        transport: result._opseeq?.provider || 'opseeq',
        warning: result.model && result.model !== model ? `Resolved ${result.model} instead of ${model}` : null,
        raw: result,
      },
    });
  } catch (err) {
    res.json({ ok: false, payload: { error: err instanceof Error ? err.message : String(err), transport: 'opseeq' } });
  }
});

app.get('/api/connectivity', authenticate, async (_req, res) => {
  const targets = [
    { label: 'NVIDIA NIM API', url: 'https://integrate.api.nvidia.com/v1/models', category: 'egress' as const },
    { label: 'OpenAI API', url: 'https://api.openai.com/v1/models', category: 'egress' as const },
    { label: 'Anthropic API', url: 'https://api.anthropic.com/v1/messages', category: 'egress' as const },
    { label: 'GitHub', url: 'https://github.com/', category: 'egress' as const },
    { label: 'npm Registry', url: 'https://registry.npmjs.org/', category: 'egress' as const },
    { label: 'Mermate', url: `${MERMATE_URL}/api/copilot/health`, category: 'local' as const },
    { label: 'Synthesis Trade', url: `${SYNTH_URL}/api/health`, category: 'local' as const },
    ...(OLLAMA_URL ? [{ label: 'Ollama', url: `${OLLAMA_URL}/api/tags`, category: 'local' as const }] : []),
  ];
  const probes = await Promise.all(targets.map(async (t) => {
    const start = Date.now();
    try {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(t.url, { signal: ctrl.signal, method: t.category === 'egress' ? 'HEAD' : 'GET' });
      clearTimeout(timer);
      return { label: t.label, url: t.url, category: t.category, reachable: true, httpStatus: r.status, latencyMs: Date.now() - start };
    } catch {
      return { label: t.label, url: t.url, category: t.category, reachable: false, httpStatus: null, latencyMs: Date.now() - start };
    }
  }));
  res.json({ generatedAt: new Date().toISOString(), probes });
});

app.post('/api/connectivity/probe', authenticate, async (req, res) => {
  const host = req.body?.host;
  if (!host) { res.status(400).json({ error: 'host required' }); return; }
  const url = `https://${host}/`;
  const start = Date.now();
  try {
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, method: 'HEAD' });
    res.json({ probe: { host, url, reachable: true, httpStatus: r.status, latencyMs: Date.now() - start } });
  } catch {
    res.json({ probe: { host, url, reachable: false, httpStatus: null, latencyMs: Date.now() - start } });
  }
});

app.get('/api/architect/status', authenticate, async (_req, res) => {
  const mermate = await getCachedMermateState();
  res.json({ architect: { available: mermate.running, mode: 'opseeq-gateway' }, mermate: { baseUrl: MERMATE_URL, ...mermate } });
});

app.post('/api/architect/pipeline', authenticate, async (req, res) => {
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 120_000);
    const up = await fetch(`${MERMATE_URL}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body), signal: ctrl.signal });
    clearTimeout(timer); res.status(up.status).json(await up.json());
  } catch (err) { res.status(502).json({ error: `Mermate pipeline unreachable: ${err instanceof Error ? err.message : err}` }); }
});

app.post('/api/builder/scaffold', authenticate, async (req, res) => {
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 30_000);
    const up = await fetch(`${MERMATE_URL}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...req.body, scaffold: true }), signal: ctrl.signal });
    clearTimeout(timer); res.status(up.status).json(await up.json());
  } catch (err) { res.status(502).json({ error: `Scaffold failed: ${err instanceof Error ? err.message : err}` }); }
});

// Mermate proxy routes (for TLA, TS, render)
for (const [method, path] of [['POST', '/api/render/tla'], ['POST', '/api/render/ts'], ['POST', '/api/render'], ['GET', '/api/render/tla/status'], ['GET', '/api/render/ts/status'], ['GET', '/api/agent/modes'], ['GET', '/api/agents'], ['GET', '/api/copilot/health']] as const) {
  const handler = async (req: express.Request, res: express.Response) => {
    try {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 60_000);
      const up = await fetch(`${MERMATE_URL}${path}`, {
        method, headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(req.body) } : {}),
        signal: ctrl.signal,
      });
      clearTimeout(timer); res.status(up.status).json(await up.json());
    } catch (err) { res.status(502).json({ error: `Mermate ${path} unreachable: ${err instanceof Error ? err.message : err}` }); }
  };
  if (method === 'GET') app.get(path, handler); else app.post(path, handler);
}

app.get('/', (_req, res) => {
  res.json({
    service: 'opseeq', version: VERSION,
    description: 'Opseeq AI Agent Gateway — full replacement for dylans_nemoclaw with multi-provider inference, MCP, and deep app integration',
    endpoints: {
      health: '/health', status: '/api/status', chat: '/api/chat',
      models: '/v1/models', completions: '/v1/chat/completions',
      embeddings: '/v1/embeddings', integrations: '/api/integrations',
      connectivity: '/api/connectivity', architect: '/api/architect/status',
      pipeline: '/api/architect/pipeline', scaffold: '/api/builder/scaffold',
      mcp: config.mcpEnabled ? '/mcp' : 'disabled',
      mermate_render: '/api/render', mermate_tla: '/api/render/tla', mermate_ts: '/api/render/ts',
    },
    providers: config.providers.map(p => p.name),
  });
});

// ── Kernel startup ────────────────────────────────────────────────
const kernel = new KernelClient();
kernel.start().then(() => {
  if (kernel.isReady()) setKernel(kernel);
}).catch(err => {
  console.log(`[kernel] start failed (running without kernel): ${err instanceof Error ? err.message : err}`);
});

// ── Start ─────────────────────────────────────────────────────────
httpServer = app.listen(config.port, config.host, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║    OPSEEQ RUNTIME KERNEL v3.0              ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Listening:    http://${config.host}:${config.port}`);
  console.log(`  MCP:          ${config.mcpEnabled ? 'enabled (/mcp)' : 'disabled'}`);
  console.log(`  Idle:         ${idleEnabled ? `yes (${Math.round(config.idleTimeoutMs / 1000)}s)` : 'no'}`);
  console.log(`  Providers:    ${config.providers.map(p => `${p.name} (${p.models.length})`).join(', ') || 'none'}`);
  console.log(`  Mermate:      ${MERMATE_URL}`);
  console.log(`  Synth:        ${SYNTH_URL}`);
  console.log(`  Ollama:       ${OLLAMA_URL || 'not configured'}`);
  console.log(`  Kernel:       ${kernel.isReady() ? 'opseeq-core (Rust)' : 'not available (Node.js fallback)'}`);
  console.log('');

  void pollSynth();
  const synthIv = setInterval(() => void pollSynth(), 8_000);
  watchIntervals.push(synthIv);
  console.log(`  [synth-watch] Polling ${SYNTH_URL}/health every 8s`);

  void pollMermate();
  const mermateIv = setInterval(() => void pollMermate(), 15_000);
  watchIntervals.push(mermateIv);
  console.log(`  [mermate-watch] Polling ${MERMATE_URL} every 15s`);
});

export { config, fetchJson, probeService, getMermateState, getOllamaState, chatWithOllama, synthWatch, MERMATE_URL, SYNTH_URL, OLLAMA_URL, VERSION };
export default app;
