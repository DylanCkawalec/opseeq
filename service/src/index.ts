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

// --- Service info ---
app.get('/', (_req, res) => {
  res.json({
    service: 'opseeq',
    version: '1.0.0',
    description: 'Opseeq AI Agent Gateway — unified inference with MCP for agentic use',
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      embeddings: '/v1/embeddings',
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
