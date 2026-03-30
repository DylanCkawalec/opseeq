import express from 'express';
import cors from 'cors';
import { loadConfig } from './config.js';
import { routeInference, routeInferenceStream, listModels } from './router.js';
import { createMcpServer, handleMcpSse, handleMcpMessages } from './mcp-server.js';
import type { ChatCompletionRequest } from './router.js';

const config = loadConfig();
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

function authenticate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (config.apiKeys.length === 0) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { message: 'Missing Authorization header', type: 'auth_error' } });
    return;
  }

  const token = authHeader.slice(7);
  if (!config.apiKeys.includes(token)) {
    res.status(403).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
    return;
  }

  next();
}

// --- Serverless idle shutdown ---
let lastRequestAt = Date.now();
if (config.serverlessMode) {
  setInterval(() => {
    if (Date.now() - lastRequestAt > config.idleTimeoutMs) {
      console.log(`[opseeq] Idle for ${config.idleTimeoutMs}ms in serverless mode — shutting down`);
      process.exit(0);
    }
  }, 30_000);
}

app.use((_req, _res, next) => {
  lastRequestAt = Date.now();
  next();
});

// --- Health ---
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    providers: config.providers.map(p => ({ name: p.name, models: p.models.length })),
    mcp: config.mcpEnabled,
    serverless: config.serverlessMode,
    uptime: process.uptime(),
  });
});

app.get('/v1/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// --- OpenAI-compatible: List Models ---
app.get('/v1/models', authenticate, (_req, res) => {
  const models = listModels(config);
  res.json({
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: m.provider,
    })),
  });
});

// --- OpenAI-compatible: Chat Completions ---
app.post('/v1/chat/completions', authenticate, async (req, res) => {
  try {
    const body = req.body as ChatCompletionRequest;

    if (!body.messages || !Array.isArray(body.messages)) {
      res.status(400).json({ error: { message: 'messages array is required', type: 'invalid_request' } });
      return;
    }

    body.model = body.model || config.defaultModel;

    if (body.stream) {
      try {
        const { stream, provider } = await routeInferenceStream(body, config);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Opseeq-Provider', provider);

        const reader = stream.getReader();
        const decoder = new TextDecoder();

        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            return;
          }
          res.write(decoder.decode(value, { stream: true }));
          return pump();
        };

        await pump();
      } catch (streamErr) {
        const fallback = await routeInference({ ...body, stream: false }, config);
        res.json(fallback);
      }
      return;
    }

    const result = await routeInference(body, config);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[opseeq] inference error:', message);
    res.status(502).json({
      error: { message, type: 'upstream_error' },
    });
  }
});

// --- OpenAI-compatible: Embeddings (passthrough) ---
app.post('/v1/embeddings', authenticate, async (req, res) => {
  try {
    const provider = config.providers.find(p => p.name !== 'ollama' && p.name !== 'anthropic');
    if (!provider) {
      res.status(503).json({ error: { message: 'No embedding-capable provider configured' } });
      return;
    }

    const upstream = await fetch(`${provider.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(req.body),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(upstream.status).json({ error: { message: errText } });
      return;
    }

    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Embedding error';
    res.status(502).json({ error: { message } });
  }
});

// --- MCP Server (SSE transport) ---
if (config.mcpEnabled) {
  const mcpServer = createMcpServer(config);

  app.get('/mcp', handleMcpSse(config, mcpServer));
  app.post('/mcp/messages', handleMcpMessages(config, mcpServer));

  console.log('[opseeq] MCP server enabled at /mcp');
}

// ==========================================================================
// Console-compatible /api/* routes
// Both Mermate (openclaw.js) and Synth (opseeq proxy) forward to these.
// This makes opseeq a drop-in replacement for the dylans_nemoclaw console.
// ==========================================================================

const MERMATE_URL = (process.env.MERMATE_URL || 'http://127.0.0.1:3333').replace(/\/+$/, '');
const SYNTH_URL = (process.env.SYNTHESIS_TRADE_URL || 'http://127.0.0.1:8420').replace(/\/+$/, '');
const serverStartedAt = new Date().toISOString();

async function probeService(baseUrl: string, path: string, timeoutMs = 2500): Promise<{ ok: boolean; data?: unknown; ms: number }> {
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}${path}`, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = res.ok ? await res.json().catch(() => null) : null;
    return { ok: res.ok, data, ms: Date.now() - start };
  } catch {
    return { ok: false, ms: Date.now() - start };
  }
}

app.get('/api/status', async (_req, res) => {
  const models = listModels(config);
  const [mermate, synth] = await Promise.all([
    probeService(MERMATE_URL, '/api/copilot/health'),
    probeService(SYNTH_URL, '/api/health'),
  ]);

  res.json({
    console: { version: '1.0.0', startedAt: serverStartedAt, mode: 'opseeq-gateway' },
    sandbox: { available: true, mode: 'opseeq', name: 'opseeq' },
    providers: config.providers.map(p => ({ name: p.name, type: p.name.includes('nim') ? 'nvidia' : 'openai-compat' })),
    inference: {
      available: config.providers.length > 0,
      models: models.map(m => m.id),
      defaultModel: config.defaultModel,
      providerCount: config.providers.length,
    },
    mcp: { enabled: config.mcpEnabled, endpoint: '/mcp' },
    mermate: {
      id: 'mermate',
      label: 'Mermate architecture copilot',
      baseUrl: MERMATE_URL,
      running: mermate.ok,
      copilotAvailable: mermate.ok,
      probedAt: new Date().toISOString(),
      probeDurationMs: mermate.ms,
    },
    synthesisTrade: {
      id: 'synthesis-trade',
      label: 'Synthesis prediction desk',
      baseUrl: SYNTH_URL,
      reachable: synth.ok,
      verified: synth.ok,
      probedAt: new Date().toISOString(),
      probeDurationMs: synth.ms,
    },
    uptime: process.uptime(),
  });
});

app.get('/api/integrations', async (_req, res) => {
  const [mermate, synth] = await Promise.all([
    probeService(MERMATE_URL, '/api/copilot/health'),
    probeService(SYNTH_URL, '/api/health'),
  ]);

  res.json({
    meta: { console: 'opseeq-gateway', version: '1.0.0', startedAt: serverStartedAt },
    controls: { inferenceAvailable: config.providers.length > 0, mcpEnabled: config.mcpEnabled },
    mermate: { running: mermate.ok, baseUrl: MERMATE_URL },
    synthesisTrade: { reachable: synth.ok, baseUrl: SYNTH_URL },
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, model: reqModel, transport } = req.body || {};
    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: 'messages array required' });
      return;
    }

    const model = reqModel || config.defaultModel;
    const result = await routeInference({ model, messages, temperature: 0 }, config);
    const content = result.choices?.[0]?.message?.content || '';

    res.json({
      ok: true,
      payload: {
        message: { role: 'assistant', content, reasoning: null },
        model: result.model || model,
        requestedModel: model,
        transport: result._opseeq?.provider || transport || 'opseeq',
        raw: result,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({
      ok: false,
      payload: { error: message, transport: 'opseeq' },
    });
  }
});

app.get('/api/connectivity', async (_req, res) => {
  const targets = [
    { label: 'NVIDIA NIM API', host: 'integrate.api.nvidia.com', path: '/v1/models' },
    { label: 'OpenAI API', host: 'api.openai.com', path: '/v1/models' },
    { label: 'Anthropic API', host: 'api.anthropic.com', path: '/v1/messages' },
    { label: 'Mermate', host: new URL(MERMATE_URL).hostname, path: '/api/copilot/health' },
    { label: 'Synthesis Trade', host: new URL(SYNTH_URL).hostname, path: '/api/health' },
  ];

  const probes = await Promise.all(targets.map(async (t) => {
    const url = t.host.includes('localhost') || t.host.includes('127.0.0.1')
      ? `http://${t.host}${new URL(t.host.includes('://') ? t.host : `http://${t.host}`).port ? '' : ':' + (t.label.includes('Mermate') ? '3333' : '8420')}${t.path}`
      : `https://${t.host}${t.path}`;
    const probe = await probeService(url.startsWith('http') ? url.split(t.path)[0] : `https://${t.host}`, t.path);
    return {
      label: t.label,
      host: t.host,
      url: `https://${t.host}${t.path}`,
      reachable: probe.ok,
      latencyMs: probe.ms,
      category: t.host.includes('localhost') || t.host.includes('127.0.0.1') ? 'local' : 'egress',
    };
  }));

  res.json({ targets: probes, probedAt: new Date().toISOString() });
});

app.get('/api/architect/status', async (_req, res) => {
  const probe = await probeService(MERMATE_URL, '/api/copilot/health');
  res.json({
    available: probe.ok,
    mermate: { baseUrl: MERMATE_URL, running: probe.ok },
    mode: 'opseeq-gateway',
  });
});

app.post('/api/architect/pipeline', async (req, res) => {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    const upstream = await fetch(`${MERMATE_URL}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Mermate pipeline unreachable: ${err instanceof Error ? err.message : err}` });
  }
});

app.post('/api/builder/scaffold', async (req, res) => {
  res.status(501).json({ error: 'Scaffold not available in opseeq gateway mode — use dylans_nemoclaw console directly' });
});

// --- Service info ---
app.get('/', (_req, res) => {
  res.json({
    service: 'opseeq',
    version: '1.0.0',
    description: 'Opseeq AI Agent Gateway — unified inference with MCP for agentic use',
    endpoints: {
      health: '/health',
      status: '/api/status',
      chat: '/api/chat',
      models: '/v1/models',
      completions: '/v1/chat/completions',
      embeddings: '/v1/embeddings',
      integrations: '/api/integrations',
      connectivity: '/api/connectivity',
      architect: '/api/architect/status',
      mcp: config.mcpEnabled ? '/mcp' : 'disabled',
    },
    providers: config.providers.map(p => p.name),
  });
});

app.listen(config.port, config.host, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║         OPSEEQ AI AGENT GATEWAY          ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Listening:    http://${config.host}:${config.port}`);
  console.log(`  MCP:          ${config.mcpEnabled ? 'enabled' : 'disabled'}`);
  console.log(`  Serverless:   ${config.serverlessMode ? `yes (idle: ${config.idleTimeoutMs}ms)` : 'no'}`);
  console.log(`  Providers:    ${config.providers.map(p => `${p.name} (${p.models.length} models)`).join(', ') || 'none configured'}`);
  console.log(`  Auth:         ${config.apiKeys.length > 0 ? `${config.apiKeys.length} key(s)` : 'open (no API keys set)'}`);
  console.log('');
});

export default app;
