/**
 * @module index — Opseeq HTTP gateway (Express)
 *
 * **Axiom A1 — Compatibility** — Public routes, JSON shapes, and status codes remain stable across
 * releases unless explicitly versioned elsewhere.
 * **Axiom A2 — Rate limiting** — Per-IP sliding window with bounded bucket map; overflow eviction
 * uses random sampling (no full sort).
 * **Postulate P1 — Idempotency** — `Idempotency-Key` deduplicates non-streaming completions; LRU
 * bounds memory; optional body hash via `OPSEEQ_IDEMPOTENCY_BODY_HASH` for stricter keys.
 * **Postulate P2 — Status aggregation** — `/api/status` batches independent subsystems via
 * `Promise.all` (models, probes, graph snapshot, precision metadata, artifacts).
 * **Corollary C1 — Graph read path** — `getCachedLivingGraph` TTL-caches `getLivingArchitectureGraph`
 * to avoid redundant disk parse under bursty dashboard traffic.
 * **Lemma L1 — Shutdown** — SIGTERM/SIGINT drain HTTP; kernel child stopped; idle exit when enabled.
 * **Tracing invariant** — `x-request-id` (or generated UUID) attached per request for log correlation.
 */
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { loadConfig, type ServiceConfig } from './config.js';
import { routeInference, routeInferenceStream, listModels, setKernel } from './router.js';
import { getFeedbackSnapshot, getRecentArtifacts, TAU } from './feedback.js';
import { createMcpServer, handleMcpSse, handleMcpMessages } from './mcp-server.js';
import { KernelClient } from './kernel.js';
import { openAppSurface, AppLauncherError } from './app-launcher.js';
import { connectRepo, RepoConnectError } from './repo-connect.js';
import { getNemoClawOverview, NemoClawControlError, runNemoClawAction, setNemoClawDefaultSandbox } from './nemoclaw-control.js';
import { getExtensionRegistry, getPrecisionOrchestrationRoutingDefaults } from './extension-registry.js';
import { buildLivingArchitectureDashboard, getLivingArchitectureGraph, getLivingArchitectureNode, queryLivingArchitectureGraph, refreshLivingArchitectureGraphIndex, type LivingArchitectureQueryOptions } from './living-architecture-graph.js';
import { orchestratePrecisionPipeline } from './mermate-lucidity-ooda.js';
import { listImmutableArtifacts } from './trace-sink.js';
import { getAbsorptionStatus, bootstrapSession, routePrompt, assembleToolPool, listSessions, persistSession } from './execution-runtime.js';
import { createAdaptiveSession, executeInPane, getPipelineStatus, canExecuteStage, getMermateVendorStatus, verifyTlaPlus, PIPELINE_STAGES } from './iterm2-adaptive-plug.js';
import { delegateTask, assessCapabilities, getOrchestratorDashboard, buildCrossRepoOptimizationTask, getActiveTasks as getActiveSubagentTasks, getTask as getSubagentTask } from './windsurf-subagent-orchestrator.js';
import type { ChatCompletionRequest } from './router.js';
import { getEmbeddingProvider, resolveNemotronAlias, estimateComplexity, resolveRoleAlias } from './provider-resolution.js';
import { getResidencyState, ensureWarm } from './model-residency.js';
import { getAgentOsStatus, createAgentVm, createAgentSession, promptSession, stopVm, listVms, listSessions as listAgentOsSessions } from './agent-os.js';

const config = loadConfig();

const IDEMPOTENCY_CACHE_MAX = Math.max(1, parseInt(process.env.OPSEEQ_IDEMPOTENCY_CACHE_MAX || '500', 10));

/** LRU-ish: Map insertion order + delete-on-get refresh. Bounded by `IDEMPOTENCY_CACHE_MAX`. */
const idempotencyCache = new Map<string, { result: unknown; expiresAt: number }>();

function idempotencyStorageKey(idempotencyKey: string, body: unknown): string {
  if (process.env.OPSEEQ_IDEMPOTENCY_BODY_HASH === 'true') {
    const h = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
    return `${idempotencyKey}|${h}`;
  }
  return idempotencyKey;
}

function idempotencyGet(key: string): { result: unknown; expiresAt: number } | undefined {
  const v = idempotencyCache.get(key);
  if (!v || Date.now() >= v.expiresAt) {
    if (v) idempotencyCache.delete(key);
    return undefined;
  }
  idempotencyCache.delete(key);
  idempotencyCache.set(key, v);
  return v;
}

function idempotencySet(key: string, result: unknown): void {
  const expiresAt = Date.now() + 3600_000;
  if (idempotencyCache.has(key)) idempotencyCache.delete(key);
  idempotencyCache.set(key, { result, expiresAt });
  while (idempotencyCache.size > IDEMPOTENCY_CACHE_MAX) {
    const first = idempotencyCache.keys().next().value;
    if (first !== undefined) idempotencyCache.delete(first);
  }
}
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const VERSION = '6.0.0';

// ── Request ID + structured logging ──────────────────────────────
app.use((req, _res, next) => {
  const provided = (req.headers['x-request-id'] as string) || '';
  (req as any).id = (provided.length > 0 && provided.length <= 64) ? provided : crypto.randomUUID();
  next();
});

function log(level: string, msg: string, meta?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ── Per-IP rate limiter (sliding window, bounded) ───────────────
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;
const MAX_RATE_BUCKETS = 10_000;

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  // Evict expired + cap size to prevent memory exhaustion
  if (rateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [k, b] of rateBuckets) { if (now >= b.resetAt) rateBuckets.delete(k); }
    // If still over limit after expiry sweep, drop ~25% at random (O(1) per eviction vs full sort)
    if (rateBuckets.size > MAX_RATE_BUCKETS) {
      const drop = Math.ceil(rateBuckets.size * 0.25);
      for (let i = 0; i < drop; i++) {
        const keys = [...rateBuckets.keys()];
        if (keys.length === 0) break;
        rateBuckets.delete(keys[Math.floor(Math.random() * keys.length)]);
      }
    }
  }
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
const PRECISION_PROMPT_PATH = path.resolve(process.cwd(), '..', 'config', 'nemoclaw-precision-orchestration.system-prompt.md');
const PRECISION_POLICY_PATH = path.resolve(process.cwd(), '..', 'config', 'nemoclaw-precision-orchestration-policy.yaml');

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
    // Clear stale data from last successful probe
    synthWatch.version = null;
    synthWatch.simulationMode = null;
    synthWatch.approvalRequired = null;
    synthWatch.aiEngineAvailable = null;
    synthWatch.predictionsAvailable = null;
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
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: m, messages, stream: false }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    log('warn', 'ollama_chat_failed', { model: m, status: res.status, latencyMs: Date.now() - t0 });
    return { ok: false, payload: { error: `Ollama HTTP ${res.status}: ${errText}`, model: m, transport: 'ollama_local' } };
  }
  const raw = await res.json() as { model?: string; message?: { role: string; content: string; thinking?: string } };
  if (!raw.message?.content?.trim()) {
    log('warn', 'ollama_empty_response', { model: m, latencyMs: Date.now() - t0 });
    return { ok: false, payload: { error: 'Ollama returned empty content', model: m, transport: 'ollama_local' } };
  }
  return {
    ok: true,
    payload: {
      message: { role: raw.message.role, content: raw.message.content.trim(), reasoning: raw.message.thinking?.trim() || null },
      model: raw.model || m, requestedModel: m, transport: 'ollama_local', latencyMs: Date.now() - t0,
    },
  };
}

// ── Cached accessors ─────────────────────────────────────────────
const getCachedMermateState = timedCache(5_000, getMermateState);
const getCachedOllamaState = timedCache(10_000, getOllamaState);
const getCachedModels = timedCache(30_000, async () => listModels(config));
const getCachedLivingGraph = timedCache(2_000, async () => getLivingArchitectureGraph());

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
    // Resolve Nemotron virtual aliases (nemotron:small, nemotron:large, nemotron:auto)
    if (body.model.startsWith('nemotron:')) {
      const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user');
      const resolved = resolveNemotronAlias(body.model, config, lastUserMsg?.content as string || '');
      body.model = resolved.model;
    }
    // Resolve role-based virtual aliases (role:code, role:reason, role:utility, role:reference)
    if (body.model.startsWith('role:')) {
      const resolved = resolveRoleAlias(body.model, config);
      if (resolved) body.model = resolved.model;
    }
    // Idempotency: return cached result if same key
    const idemHeader = req.headers['idempotency-key'] as string | undefined;
    const idempotencyKey = idemHeader ? idempotencyStorageKey(idemHeader, body) : undefined;
    if (idempotencyKey) {
      const cached = idempotencyGet(idempotencyKey);
      if (cached) {
        res.setHeader('X-Opseeq-Idempotent', 'hit');
        res.json(cached.result);
        return;
      }
    }
    if (body.stream) {
      let headersCommitted = false;
      try {
        const { stream, provider } = await routeInferenceStream(body, config);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Opseeq-Provider', provider);
        headersCommitted = true;
        const reader = stream.getReader();
        const dec = new TextDecoder();
        const pump = async (): Promise<void> => {
          try {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            res.write(dec.decode(value, { stream: true }));
            return pump();
          } catch (chunkErr) {
            log('error', 'stream_chunk_error', { trace_id: (req as any).id, error: chunkErr instanceof Error ? chunkErr.message : String(chunkErr) });
            res.write(`data: ${JSON.stringify({ error: { message: 'stream interrupted', type: 'stream_error' } })}\n\n`);
            res.end();
          }
        };
        await pump();
      } catch (err) {
        if (headersCommitted) {
          // Headers already sent as SSE — can't switch to JSON, close gracefully
          res.write(`data: ${JSON.stringify({ error: { message: err instanceof Error ? err.message : 'upstream error', type: 'stream_error' } })}\n\n`);
          res.end();
        } else {
          // Headers not sent yet — fall back to non-streaming
          try {
            const fb = await routeInference({ ...body, stream: false }, config, (req as any).id);
            res.json(fb);
          } catch (fbErr) {
            res.status(502).json({ error: { message: fbErr instanceof Error ? fbErr.message : 'upstream error', type: 'upstream_error' } });
          }
        }
      }
      return;
    }
    const result = await routeInference(body, config, (req as any).id);
    if (idempotencyKey) idempotencySet(idempotencyKey, result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: { message: err instanceof Error ? err.message : 'upstream error', type: 'upstream_error' } });
  }
});

app.post('/v1/embeddings', authenticate, async (req, res) => {
  const provider = getEmbeddingProvider(config);
  if (!provider) { res.status(503).json({ error: { message: 'No embedding provider' } }); return; }
  try {
    const up = await fetch(`${provider.baseUrl}/embeddings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify(req.body),
    });
    res.status(up.status).json(await up.json());
  } catch (err) { res.status(502).json({ error: { message: err instanceof Error ? err.message : 'error' } }); }
});

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of idempotencyCache) { if (now >= v.expiresAt) idempotencyCache.delete(k); }
}, 120_000);

// ── Inference artifacts API ─────────────────────────────────────
app.get('/api/artifacts', authenticate, (_req, res) => {
  const limit = Math.min(100, parseInt((_req.query as Record<string, string>).limit || '20', 10));
  res.json({ artifacts: getRecentArtifacts(limit), tau: TAU });
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
  const [
    allModels,
    mermate,
    ollama,
    nemoclaw,
    livingArchitectureGraph,
    precisionDefaults,
    extensionRegistry,
    recentPrecisionArtifacts,
  ] = await Promise.all([
    getCachedModels(),
    getCachedMermateState(),
    getCachedOllamaState(),
    getNemoClawOverview(process.env),
    getCachedLivingGraph(),
    Promise.resolve(getPrecisionOrchestrationRoutingDefaults('all')),
    Promise.resolve(getExtensionRegistry()),
    Promise.resolve(listImmutableArtifacts(undefined, 5)),
  ]);
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
    nemoclaw: {
      available: nemoclaw.cliAvailable || nemoclaw.gateway.available || nemoclaw.stats.total > 0,
      defaultSandbox: nemoclaw.defaultSandbox,
      sandboxes: nemoclaw.stats.total,
      reachableSandboxes: nemoclaw.stats.reachable,
      gateway: {
        state: nemoclaw.gateway.state,
        summary: nemoclaw.gateway.summary,
        activeGateway: nemoclaw.gateway.activeGateway,
      },
    },
    inference: {
      available: config.providers.length > 0,
      models: allModels.map(m => m.id), defaultModel: config.defaultModel,
      providerCount: config.providers.length,
    },
    precisionOrchestration: {
      plannerModel: precisionDefaults.plannerModel,
      executionModel: precisionDefaults.executionModel,
      extensionPacks: extensionRegistry.map((pack) => ({ id: pack.id, label: pack.label, targets: pack.targets })),
      assets: {
        prompt: PRECISION_PROMPT_PATH,
        policy: PRECISION_POLICY_PATH,
      },
      livingArchitectureGraph: {
        versions: livingArchitectureGraph.versions.length,
        nodes: livingArchitectureGraph.nodes.length,
        edges: livingArchitectureGraph.edges.length,
      },
      immutableArtifacts: recentPrecisionArtifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        taskId: artifact.taskId,
        createdAt: artifact.createdAt,
      })),
      canonicalPath: 'idea -> performance assessment -> Mermate MAX -> Lucidity polish -> approval -> TLA+ -> TypeScript -> Rust -> macOS app',
    },
    providers: config.providers.map(p => ({ name: p.name, type: p.name.includes('nim') ? 'nvidia' : 'openai-compat' })),
    ollama, mermate: { id: 'mermate', label: 'Mermate architecture copilot', role: 'diagram_tla_ts_pipeline', baseUrl: MERMATE_URL, ...mermate },
    synthesisTrade: {
      id: 'synthesis-trade', label: 'Synth trading desk', role: 'prediction_market_desk',
      baseUrl: SYNTH_URL, ...synthWatch,
      watch: { consecutiveSuccesses: synthWatch.consecutiveSuccesses, consecutiveFailures: synthWatch.consecutiveFailures, pollIntervalSeconds: 8 },
    },
    mcp: { enabled: config.mcpEnabled, endpoint: '/mcp', transport: 'sse' },
    selfImprovement: getFeedbackSnapshot(),
    transport: { primary: 'hybrid (SeeQ-managed local [hot+active-large] + NIM [reference] + OpenAI/Anthropic [assistant]) + residency + stickiness', mode: 'opseeq-gateway' },
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
    const result = await routeInference({ model, messages, temperature: 0 }, config, (req as any).id);
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(t.url, { signal: ctrl.signal, method: t.category === 'egress' ? 'HEAD' : 'GET' });
      return { label: t.label, url: t.url, category: t.category, reachable: true, httpStatus: r.status, latencyMs: Date.now() - start };
    } catch {
      return { label: t.label, url: t.url, category: t.category, reachable: false, httpStatus: null, latencyMs: Date.now() - start };
    } finally { clearTimeout(timer); }
  }));
  res.json({ generatedAt: new Date().toISOString(), probes });
});

app.post('/api/connectivity/probe', authenticate, async (req, res) => {
  const host = req.body?.host;
  if (!host) { res.status(400).json({ error: 'host required' }); return; }
  const url = `https://${host}/`;
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, method: 'HEAD' });
    res.json({ probe: { host, url, reachable: true, httpStatus: r.status, latencyMs: Date.now() - start } });
  } catch {
    res.json({ probe: { host, url, reachable: false, httpStatus: null, latencyMs: Date.now() - start } });
  } finally { clearTimeout(timer); }
});

app.post('/api/repos/connect', authenticate, async (req, res) => {
  const repoPath = req.body?.repoPath || req.body?.repo_path;
  if (!repoPath || typeof repoPath !== 'string') {
    res.status(400).json({ error: 'repoPath is required' });
    return;
  }
  try {
    const result = await connectRepo(repoPath, { env: process.env });
    res.json(result);
  } catch (err) {
    if (err instanceof RepoConnectError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/apps/open', authenticate, async (req, res) => {
  const appId = req.body?.appId || req.body?.id;
  if (!appId || typeof appId !== 'string') {
    res.status(400).json({ error: 'appId is required' });
    return;
  }
  try {
    const result = await openAppSurface(appId, process.env);
    res.json(result);
  } catch (err) {
    if (err instanceof AppLauncherError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/nemoclaw/status', authenticate, async (_req, res) => {
  try {
    const overview = await getNemoClawOverview(process.env);
    res.json(overview);
  } catch (err) {
    if (err instanceof NemoClawControlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/nemoclaw/actions', authenticate, async (req, res) => {
  const action = req.body?.action;
  const sandboxName = req.body?.sandboxName || req.body?.name;
  if (!sandboxName || typeof sandboxName !== 'string') {
    res.status(400).json({ error: 'sandboxName is required' });
    return;
  }
  if (action !== 'connect' && action !== 'status' && action !== 'logs') {
    res.status(400).json({ error: 'action must be one of connect, status, or logs' });
    return;
  }
  try {
    const result = await runNemoClawAction(action, sandboxName, process.env);
    res.json(result);
  } catch (err) {
    if (err instanceof NemoClawControlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/nemoclaw/default', authenticate, async (req, res) => {
  const sandboxName = req.body?.sandboxName || req.body?.name;
  if (!sandboxName || typeof sandboxName !== 'string') {
    res.status(400).json({ error: 'sandboxName is required' });
    return;
  }
  try {
    const result = setNemoClawDefaultSandbox(sandboxName);
    res.json(result);
  } catch (err) {
    if (err instanceof NemoClawControlError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/ooda/extensions', authenticate, (_req, res) => {
  const defaults = getPrecisionOrchestrationRoutingDefaults('all');
  res.json({
    defaults,
    assets: {
      prompt: PRECISION_PROMPT_PATH,
      policy: PRECISION_POLICY_PATH,
    },
    extensions: getExtensionRegistry(),
  });
});

app.get('/api/ooda/dashboard', authenticate, (req, res) => {
  if (req.query.refresh === 'true') {
    refreshLivingArchitectureGraphIndex({
      taskId: `dashboard-${Date.now().toString(36)}`,
      recordVersion: false,
    });
  }
  const query = typeof req.query.q === 'string' ? req.query.q : undefined;
  res.json({
    generatedAt: new Date().toISOString(),
    defaults: getPrecisionOrchestrationRoutingDefaults('all'),
    assets: {
      prompt: PRECISION_PROMPT_PATH,
      policy: PRECISION_POLICY_PATH,
    },
    dashboard: buildLivingArchitectureDashboard(),
    query: query ? queryLivingArchitectureGraph({ query, limit: 12 }) : null,
    recentArtifacts: listImmutableArtifacts(undefined, 10).map((artifact) => ({
      id: artifact.id,
      taskId: artifact.taskId,
      kind: artifact.kind,
      createdAt: artifact.createdAt,
      hash: artifact.hash,
      path: artifact.path,
    })),
  });
});

app.get('/api/ooda/graph', authenticate, (req, res) => {
  if (req.query.refresh === 'true') {
    refreshLivingArchitectureGraphIndex({
      taskId: `graph-${Date.now().toString(36)}`,
      recordVersion: req.query.recordVersion === 'true',
    });
  }
  const graph = getLivingArchitectureGraph();
  const query = queryLivingArchitectureGraph({
    query: typeof req.query.q === 'string' ? req.query.q : undefined,
    repoId: typeof req.query.repoId === 'string' ? req.query.repoId : undefined,
    taskId: typeof req.query.taskId === 'string' ? req.query.taskId : undefined,
    kind: typeof req.query.kind === 'string' ? req.query.kind as LivingArchitectureQueryOptions['kind'] : undefined,
    limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
    includeBacklinks: req.query.backlinks === 'false' ? false : undefined,
  });
  res.json({
    generatedAt: new Date().toISOString(),
    graph,
    query,
    dashboard: buildLivingArchitectureDashboard(),
    recentArtifacts: listImmutableArtifacts(undefined, 10).map((artifact) => ({
      id: artifact.id,
      taskId: artifact.taskId,
      kind: artifact.kind,
      createdAt: artifact.createdAt,
      hash: artifact.hash,
      path: artifact.path,
    })),
  });
});

app.get('/api/ooda/graph/search', authenticate, (req, res) => {
  res.json({
    generatedAt: new Date().toISOString(),
    result: queryLivingArchitectureGraph({
      query: typeof req.query.q === 'string' ? req.query.q : undefined,
      repoId: typeof req.query.repoId === 'string' ? req.query.repoId : undefined,
      taskId: typeof req.query.taskId === 'string' ? req.query.taskId : undefined,
      kind: typeof req.query.kind === 'string' ? req.query.kind as LivingArchitectureQueryOptions['kind'] : undefined,
      limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
      includeBacklinks: req.query.backlinks === 'false' ? false : undefined,
    }),
  });
});

app.get('/api/ooda/graph/node/:nodeId', authenticate, (req, res) => {
  res.json({
    generatedAt: new Date().toISOString(),
    snapshot: getLivingArchitectureNode(String(req.params.nodeId)),
  });
});

app.post('/api/ooda/graph/refresh', authenticate, (req, res) => {
  const refreshed = refreshLivingArchitectureGraphIndex({
    taskId: typeof req.body?.taskId === 'string' ? req.body.taskId : `refresh-${Date.now().toString(36)}`,
    recordVersion: req.body?.recordVersion !== false,
  });
  res.json({
    generatedAt: new Date().toISOString(),
    version: refreshed.version,
    diagram: refreshed.diagram,
    dashboard: buildLivingArchitectureDashboard(),
  });
});

app.post('/api/ooda/precision', authenticate, async (req, res) => {
  const intent = req.body?.intent;
  if (!intent || typeof intent !== 'string') {
    res.status(400).json({ error: 'intent is required' });
    return;
  }
  try {
    const result = await orchestratePrecisionPipeline({
      intent,
      repoPath: typeof req.body?.repoPath === 'string' ? req.body.repoPath : undefined,
      appId: typeof req.body?.appId === 'string' ? req.body.appId : undefined,
      inputMode: req.body?.inputMode,
      maxMode: req.body?.maxMode,
      approved: req.body?.approved,
      execute: req.body?.execute,
      includeTla: req.body?.includeTla,
      includeTs: req.body?.includeTs,
      includeRust: req.body?.includeRust,
      localModel: typeof req.body?.localModel === 'string' ? req.body.localModel : undefined,
      allowRemoteAugmentation: req.body?.allowRemoteAugmentation,
      allowModelCritique: req.body?.allowModelCritique,
    }, config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/architect/status', authenticate, async (_req, res) => {
  const mermate = await getCachedMermateState();
  res.json({ architect: { available: mermate.running, mode: 'opseeq-gateway' }, mermate: { baseUrl: MERMATE_URL, ...mermate } });
});

app.post('/api/architect/pipeline', authenticate, async (req, res) => {
  const pipelineStart = Date.now();
  const reqId = (req as any).id || '';
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 120_000);
    const up = await fetch(`${MERMATE_URL}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body), signal: ctrl.signal });
    clearTimeout(timer);
    const data = await up.json() as Record<string, unknown>;
    const durationMs = Date.now() - pipelineStart;
    log('info', 'mermate_pipeline_completed', {
      trace_id: reqId, purpose: 'mermate_pipeline',
      duration_ms: durationMs, http_status: up.status,
      run_id: data.run_id ?? data.runId ?? null,
      diagram_type: data.diagram_type ?? data.diagramType ?? null,
      stage: data.stage ?? null,
      validation_passed: data.validation_passed ?? data.validationPassed ?? null,
    });
    res.status(up.status).json(data);
  } catch (err) {
    log('error', 'mermate_pipeline_failed', { trace_id: reqId, purpose: 'mermate_pipeline', duration_ms: Date.now() - pipelineStart, error: err instanceof Error ? err.message : String(err) });
    res.status(502).json({ error: `Mermate pipeline unreachable: ${err instanceof Error ? err.message : err}` });
  }
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

// ── v2.4 General-Clawd Absorption + Execution Runtime ────────────────
app.get('/api/absorption/status', (_req, res) => { res.json(getAbsorptionStatus()); });
app.post('/api/execution/bootstrap', authenticate, (req, res) => {
  const { prompt, taskId } = req.body || {};
  if (!prompt) { res.status(400).json({ error: 'prompt required' }); return; }
  res.json(bootstrapSession(prompt, taskId || crypto.randomUUID()));
});
app.post('/api/execution/route', authenticate, (req, res) => {
  const { prompt, limit } = req.body || {};
  if (!prompt) { res.status(400).json({ error: 'prompt required' }); return; }
  res.json(routePrompt(prompt, limit));
});
app.get('/api/execution/tools', (_req, res) => { res.json(assembleToolPool()); });
app.get('/api/execution/sessions', (_req, res) => { res.json(listSessions()); });

// ── v2.4 iTerm2 Adaptive Plug + Pipeline ─────────────────────────────
app.get('/api/pipeline/stages', (_req, res) => { res.json(PIPELINE_STAGES); });
app.get('/api/pipeline/mermate-vendor', (_req, res) => { res.json(getMermateVendorStatus()); });
const adaptiveSessions = new Map<string, Awaited<ReturnType<typeof createAdaptiveSession>>>();
app.post('/api/pipeline/session', authenticate, async (req, res) => {
  try { const s = await createAdaptiveSession(req.body?.taskId || crypto.randomUUID()); adaptiveSessions.set(s.sessionId, s); res.json({ sessionId: s.sessionId, stages: getPipelineStatus(s) }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/pipeline/execute', authenticate, async (req, res) => {
  const { sessionId, stageId, command, cwd } = req.body || {};
  const s = adaptiveSessions.get(sessionId);
  if (!s) { res.status(404).json({ error: 'session not found' }); return; }
  if (!canExecuteStage(s, stageId)) { res.status(409).json({ error: 'dependencies not met' }); return; }
  try { res.json({ stage: await executeInPane(s, stageId, command, cwd), pipeline: getPipelineStatus(s) }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/pipeline/status/:sid', (req, res) => {
  const s = adaptiveSessions.get(req.params.sid);
  if (!s) { res.status(404).json({ error: 'not found' }); return; }
  res.json(getPipelineStatus(s));
});

// ── v2.4 Windsurf Subagent Orchestration ─────────────────────────────
app.get('/api/subagents/dashboard', (_req, res) => { res.json(getOrchestratorDashboard()); });
app.post('/api/subagents/delegate', authenticate, (req, res) => {
  const { parentTaskId, mandate } = req.body || {};
  if (!parentTaskId || !mandate) { res.status(400).json({ error: 'parentTaskId+mandate required' }); return; }
  res.json(delegateTask(parentTaskId, req.body.delegatorId || 'precision', mandate));
});
app.post('/api/subagents/assess', (req, res) => {
  if (!req.body?.description) { res.status(400).json({ error: 'description required' }); return; }
  res.json(assessCapabilities(req.body.description));
});
app.post('/api/subagents/cross-repo', authenticate, (req, res) => {
  const { parentTaskId, description } = req.body || {};
  if (!parentTaskId || !description) { res.status(400).json({ error: 'required fields missing' }); return; }
  res.json(buildCrossRepoOptimizationTask(parentTaskId, 'windsurf', req.body.targetRepos || ['opseeq'], description));
});
app.get('/api/subagents/active', (_req, res) => { res.json(getActiveSubagentTasks()); });
app.get('/api/subagents/task/:tid', (req, res) => {
  const t = getSubagentTask(req.params.tid);
  if (!t) { res.status(404).json({ error: 'not found' }); return; }
  res.json(t);
});

// ── v2.5 AgentOS (SeeQ) Orchestration ─────────────────────────────
app.get('/api/agent-os/status', (_req, res) => { res.json(getAgentOsStatus()); });
app.post('/api/agent-os/vm', authenticate, async (req, res) => {
  try { res.json(await createAgentVm(req.body || {})); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/agent-os/session', authenticate, async (req, res) => {
  const { vmId, agentType } = req.body || {};
  if (!vmId) { res.status(400).json({ error: 'vmId required' }); return; }
  try { res.json(await createAgentSession(vmId, agentType)); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/agent-os/prompt', authenticate, async (req, res) => {
  const { sessionId, prompt } = req.body || {};
  if (!sessionId || !prompt) { res.status(400).json({ error: 'sessionId+prompt required' }); return; }
  try { res.json(await promptSession(sessionId, prompt)); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/agent-os/vm/:vmId/stop', authenticate, async (req, res) => {
  try { await stopVm(String(req.params.vmId)); res.json({ stopped: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/agent-os/vms', (_req, res) => { res.json(listVms()); });
app.get('/api/agent-os/sessions', (_req, res) => { res.json(listAgentOsSessions()); });

// ── v2.5 Nemotron Routing ─────────────────────────────────────────
app.post('/api/nemotron/resolve', (req, res) => {
  const { model, prompt } = req.body || {};
  if (!model) { res.status(400).json({ error: 'model required (nemotron:small|large|auto|fast|local|cloud)' }); return; }
  const resolved = resolveNemotronAlias(model, config, prompt);
  const complexity = prompt ? estimateComplexity(prompt) : null;
  res.json({ requested: model, resolved: resolved.model, provider: resolved.provider?.name || null, complexity });
});
app.get('/api/nemotron/aliases', (_req, res) => {
  res.json({
    aliases: {
      'nemotron:small': { model: 'nemotron-3-nano:4b', provider: 'ollama', description: 'Fast local inference (~8s, 2.8GB RAM)' },
      'nemotron:fast': { model: 'nemotron-3-nano:4b', provider: 'ollama', description: 'Alias for nemotron:small' },
      'nemotron:local': { model: 'nemotron-3-nano:4b', provider: 'ollama', description: 'Alias for nemotron:small' },
      'nemotron:large': { model: 'nvidia/nemotron-3-super-120b-a12b', provider: 'nvidia-nim', description: 'Cloud inference via NVIDIA NIM (~650ms)' },
      'nemotron:cloud': { model: 'nvidia/nemotron-3-super-120b-a12b', provider: 'nvidia-nim', description: 'Alias for nemotron:large' },
      'nemotron:auto': { model: 'dynamic', provider: 'auto', description: 'Routes based on prompt complexity (threshold: NEMOTRON_AUTO_THRESHOLD, default 0.5)' },
    },
  });
});

// ── SeeQ Model Residency ──────────────────────────────────────────
app.get('/api/seeq/residency', (_req, res) => { res.json(getResidencyState()); });
app.post('/api/seeq/warmup', authenticate, async (req, res) => {
  const { model } = req.body || {};
  if (!model) { res.status(400).json({ error: 'model required' }); return; }
  try { await ensureWarm(model); res.json({ warmed: model, state: getResidencyState() }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/seeq/roles', (_req, res) => {
  res.json({
    aliases: {
      'role:code': { model: 'qwen3-coder:30b', provider: 'ollama', description: 'Main local coding model (TS/Rust implementation, code review)' },
      'role:reason': { model: 'deepseek-r1:32b', provider: 'ollama', description: 'Heavy local reasoning (decomposition, synthesis, formal reasoning)' },
      'role:utility': { model: 'nemotron-3-nano:4b', provider: 'ollama', description: 'Fast local utility (quick completions, wrappers, transforms)' },
      'role:reference': { model: 'nvidia/nemotron-3-super-120b-a12b', provider: 'nvidia-nim', description: 'High-capacity architecture/history/formal-spec reference' },
    },
  });
});

app.get('/', (_req, res) => {
  res.json({
    service: 'opseeq', version: VERSION,
    description: 'Opseeq v6.0 — SeeQ Residency + Role Routing + Multi-Provider Edition',
    endpoints: {
      health: '/health', status: '/api/status', chat: '/api/chat',
      models: '/v1/models', completions: '/v1/chat/completions',
      embeddings: '/v1/embeddings', integrations: '/api/integrations',
      connectivity: '/api/connectivity', architect: '/api/architect/status',
      pipeline: '/api/architect/pipeline', scaffold: '/api/builder/scaffold',
      repo_connect: '/api/repos/connect', app_open: '/api/apps/open',
      nemoclaw_status: '/api/nemoclaw/status', nemoclaw_action: '/api/nemoclaw/actions', nemoclaw_default: '/api/nemoclaw/default',
      ooda_extensions: '/api/ooda/extensions', ooda_dashboard: '/api/ooda/dashboard', ooda_graph: '/api/ooda/graph', ooda_graph_search: '/api/ooda/graph/search', ooda_graph_refresh: '/api/ooda/graph/refresh', ooda_precision: '/api/ooda/precision',
      mcp: config.mcpEnabled ? '/mcp' : 'disabled',
      mermate_render: '/api/render', mermate_tla: '/api/render/tla', mermate_ts: '/api/render/ts',
      absorption_status: '/api/absorption/status', execution_bootstrap: '/api/execution/bootstrap',
      execution_route: '/api/execution/route', execution_tools: '/api/execution/tools', execution_sessions: '/api/execution/sessions',
      pipeline_stages: '/api/pipeline/stages', pipeline_session: '/api/pipeline/session', pipeline_execute: '/api/pipeline/execute',
      pipeline_mermate_vendor: '/api/pipeline/mermate-vendor',
      subagents_dashboard: '/api/subagents/dashboard', subagents_delegate: '/api/subagents/delegate',
      subagents_assess: '/api/subagents/assess', subagents_cross_repo: '/api/subagents/cross-repo',
      agent_os_status: '/api/agent-os/status', agent_os_vm: '/api/agent-os/vm', agent_os_session: '/api/agent-os/session',
      agent_os_prompt: '/api/agent-os/prompt', agent_os_vms: '/api/agent-os/vms', agent_os_sessions: '/api/agent-os/sessions',
      nemotron_resolve: '/api/nemotron/resolve', nemotron_aliases: '/api/nemotron/aliases',
      seeq_residency: '/api/seeq/residency', seeq_warmup: '/api/seeq/warmup', seeq_roles: '/api/seeq/roles',
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
  console.log('  ║    OPSEEQ RUNTIME KERNEL v6.0              ║');
  console.log('  ║    SeeQ Residency + Role Routing            ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Listening:    http://${config.host}:${config.port}`);
  console.log(`  MCP:          ${config.mcpEnabled ? 'enabled (/mcp)' : 'disabled'}`);
  console.log(`  Idle:         ${idleEnabled ? `yes (${Math.round(config.idleTimeoutMs / 1000)}s)` : 'no'}`);
  console.log(`  Providers:    ${config.providers.map(p => `${p.name} (${p.models.length})`).join(', ') || 'none'}`);
  console.log(`  AgentOS:      SeeQ absorbed (WASM+V8 isolate VMs)`);
  console.log(`  SeeQ:         hot=[gpt-oss:20b,nano:4b] | active-large=dynamic | warm=15m`);
  console.log(`  Roles:        code=qwen3-coder:30b | reason=deepseek-r1:32b | utility=nano:4b | ref=120b`);
  console.log(`  Mermate:      ${MERMATE_URL}`);
  console.log(`  Synth:        ${SYNTH_URL}`);
  console.log(`  Ollama:       ${OLLAMA_URL || 'not configured'}`);
  console.log(`  Kernel:       ${kernel.isReady() ? 'opseeq-core (Rust)' : 'not available (Node.js fallback)'}`);
  console.log('');

  // Adaptive polling: back off on failures, speed up on recovery
  let synthPollMs = 10_000;
  void pollSynth().then(() => { if (synthWatch.reachable) synthPollMs = 15_000; });
  const synthIv = setInterval(() => {
    void pollSynth().then(() => {
      synthPollMs = synthWatch.reachable ? 15_000 : Math.min(120_000, synthPollMs * 1.5);
    });
  }, 10_000);
  watchIntervals.push(synthIv);
  console.log(`  [synth-watch] Polling ${SYNTH_URL}/health (adaptive 10-120s)`);

  let mermatePollMs = 15_000;
  void pollMermate();
  const mermateIv = setInterval(() => {
    void pollMermate().then(() => {
      mermatePollMs = mermateWatchRunning ? 20_000 : Math.min(120_000, mermatePollMs * 1.5);
    });
  }, 15_000);
  watchIntervals.push(mermateIv);
  console.log(`  [mermate-watch] Polling ${MERMATE_URL} (adaptive 15-120s)`);

  // SeeQ hot-tier model warmup (keep gpt-oss:20b and nemotron-3-nano:4b permanently loaded)
  if (OLLAMA_URL) {
    ensureWarm('gpt-oss:20b').catch(() => {});
    ensureWarm('nemotron-3-nano:4b').catch(() => {});
    console.log('  [seeq-residency] Warming hot-tier models: gpt-oss:20b, nemotron-3-nano:4b');
  }
});

export { config, fetchJson, probeService, getMermateState, getOllamaState, chatWithOllama, synthWatch, MERMATE_URL, SYNTH_URL, OLLAMA_URL, VERSION };
export default app;
