# Opseeq v4 — Integration Manual

> How to connect a new application to the Opseeq runtime.

---

## Overview

Opseeq is a local-first inference and orchestration runtime. It routes AI inference requests across multiple providers (NVIDIA NIM, OpenAI, Anthropic, Ollama), exposes MCP tools for agentic workflows, and provides observability, tracing, and self-improvement feedback.

Any application that can make HTTP requests can use Opseeq as its inference backend.

---

## 1. API Surface

### Gateway (default `:9090`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check — returns `{ status, version, providers, uptime }` |
| `/health/ready` | GET | Readiness probe (for k8s / orchestrators) |
| `/v1/models` | GET | List available models (OpenAI-compatible) |
| `/v1/chat/completions` | POST | Chat completions (OpenAI-compatible, streaming supported) |
| `/v1/embeddings` | POST | Embedding proxy |
| `/api/status` | GET | Full system status (providers, integrations, feedback, tracing) |
| `/api/chat` | POST | Unified chat endpoint (supports `transport: 'ollama'` or `'opseeq'`) |
| `/api/artifacts` | GET | Recent inference artifacts (CELLAR hot-plane) |
| `/api/connectivity` | GET | Probe all configured providers + integrations |
| `/api/integrations` | GET | Status of connected apps (Mermate, Synth, Ollama) |
| `/mcp` | GET (SSE) | MCP server endpoint (Model Context Protocol) |
| `/mcp/messages` | POST | MCP message handler |

### Dashboard (default `:7070`)

The dashboard proxies `/api/*` and `/v1/*` to the gateway and serves a web UI.

---

## 2. Request / Response Patterns

### Chat Completions (OpenAI-compatible)

```bash
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello"}
    ],
    "temperature": 0.7,
    "max_tokens": 1024
  }'
```

**Response** includes standard OpenAI fields plus `_opseeq`:
```json
{
  "id": "chatcmpl-...",
  "model": "claude-sonnet-4-6",
  "choices": [{ "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 12, "completion_tokens": 45, "total_tokens": 57 },
  "_opseeq": { "provider": "anthropic", "latencyMs": 823 }
}
```

### Streaming

Set `"stream": true`. Response is server-sent events (SSE) in OpenAI format. Works with OpenAI-compatible providers (NIM, OpenAI). Anthropic and Ollama fall back to non-streaming automatically.

### Idempotency

Include `Idempotency-Key: <unique-string>` header to prevent duplicate inference on network retries. Cached for 1 hour.

---

## 3. Authentication

If `OPSEEQ_API_KEYS` is set, all requests must include:
```
Authorization: Bearer <key>
```

If unset (development mode), all requests are open.

---

## 4. Connecting a New App

### Step 1: Set Environment Variables

In your app's `.env`:
```bash
# Point OpenAI SDK at Opseeq
OPENAI_BASE_URL=http://localhost:9090/v1
OPENAI_API_KEY=your-opseeq-key

# Or use Opseeq directly
OPSEEQ_URL=http://localhost:9090
```

### Step 2: MCP Integration (optional)

Create `.mcp.json` in your project root:
```json
{
  "mcpServers": {
    "opseeq": {
      "url": "http://localhost:9090/mcp"
    }
  }
}
```

This exposes 24 MCP tools including inference, model listing, architecture pipelines, desktop scanning, and more.

### Step 3: Use Any OpenAI-Compatible SDK

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:9090/v1", api_key="your-key")
response = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello"}],
)
```

```typescript
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://localhost:9090/v1', apiKey: 'your-key' });
const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

---

## 5. Available Models

Models are determined by configured providers. Query at runtime:

```bash
curl http://localhost:9090/v1/models
```

Default providers and models (when API keys are set):

| Provider | Models |
|----------|--------|
| NVIDIA NIM | `nvidia/nemotron-3-super-120b-a12b`, `nvidia/llama-3.3-nemotron-super-49b-v1` |
| OpenAI | `gpt-5.4`, `gpt-5.2`, `gpt-4.1`, `gpt-4o`, `o3`, `o3-mini`, `o1` |
| Anthropic | `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` |
| Ollama | Any locally pulled model (e.g. `gpt-oss:20b`, `llama3.3:70b`) |

Opseeq routes to the best available provider. You can request any model — if it matches a configured provider, it routes there.

---

## 6. Tracing and Observability

### Request Tracing

Pass `X-Request-Id: <your-trace-id>` to correlate logs. Opseeq propagates this through all provider calls and structured logs.

### Self-Improvement Feedback

`GET /api/status` returns the `selfImprovement` section:
- Per-provider success rate, latency EMA, adaptive score
- Concentration score (routing diversity)
- Tau thresholds (τ_e=0.7, τ_p=0.85, τ_d=0.9)
- Best provider recommendation

### Inference Artifacts

`GET /api/artifacts?limit=20` returns the last N inference artifacts from the CELLAR hot-plane ring buffer:
```json
{
  "artifacts": [
    {
      "id": "chatcmpl-abc123",
      "model": "claude-sonnet-4-6",
      "provider": "anthropic",
      "latencyMs": 823,
      "tokens": { "input": 12, "output": 45 },
      "success": true,
      "timestamp": "2026-03-30T12:00:00.000Z",
      "traceId": "req-abc"
    }
  ],
  "tau": { "explore": 0.7, "production": 0.85, "deploy": 0.9 }
}
```

---

## 7. OpenClaw Remote Access

Opseeq serves as the inference backend for OpenClaw sandboxes:

1. **Sandbox → Opseeq**: The sandbox makes inference calls via the OpenAI-compatible API
2. **Network Policy**: Sandbox egress is restricted to the Opseeq gateway URL
3. **Auth**: Each sandbox build generates a unique bearer token
4. **MCP**: The sandbox can consume Opseeq MCP tools for agentic control

To configure a sandbox:
```yaml
# In openclaw.json or nemoclaw-blueprint
inference:
  base_url: http://opseeq:9090/v1
  api_key: ${SANDBOX_TOKEN}
```

---

## 8. Architecture Pipeline (Mermate Integration)

Opseeq proxies the Mermate architecture pipeline:

```bash
# Run idea → Mermaid → TLA+ → TypeScript
curl -X POST http://localhost:9090/api/architect/pipeline \
  -H "Content-Type: application/json" \
  -d '{"mermaid_source": "Your idea here", "input_mode": "idea", "max_mode": true}'
```

Available architect endpoints:
- `GET /api/architect/status` — Check Mermate availability
- `POST /api/architect/pipeline` — Full render pipeline
- `POST /api/builder/scaffold` — Generate starter repo from pipeline output
- `POST /api/render/tla` — Generate TLA+ spec
- `POST /api/render/ts` — Generate TypeScript runtime

---

## 9. Rate Limits

Default: 120 requests per minute per IP. Headers returned:
- `X-RateLimit-Limit: 120`
- `X-RateLimit-Remaining: <n>`

Returns `429 Too Many Requests` when exceeded.

---

## 10. Health Monitoring

For orchestrators and load balancers:

```bash
# Liveness
curl http://localhost:9090/health

# Readiness
curl http://localhost:9090/health/ready

# Deep status
curl http://localhost:9090/api/status
```

The `/health/ready` endpoint returns `503` during shutdown for graceful drain.

---

## 11. Docker Deployment

```bash
docker run -d --name opseeq \
  -p 9090:9090 \
  --restart unless-stopped \
  --env-file .env \
  --memory 512m \
  opseeq:v5
```

**Canonical image name:** use **`opseeq:v5`** — strict version tag, no `:latest`.

**Synth + Mermate — always run the current Opseeq build**

- **Synth (`synthesis-trade`):** `docker-compose.yml` builds Opseeq from **`../opseeq`** (`Dockerfile.service`) and tags **`opseeq:v5`**. Run **`docker compose up --build -d`**.
- **Mermate:** points at `http://localhost:9090`; rebuild the container with `npm run opseeq:docker:build` or `docker compose up --build` from Synth.
- **Shell (`run.sh`):** with a checkout at **`../opseeq`**, starting Opseeq when the gateway is down builds from source first. Force rebuild: **`OPSEEQ_FORCE_REBUILD=1 ./run.sh app`**.

Push to DockerHub: `docker tag opseeq:v5 dylanckawalec/opseeq:v5 && docker push dylanckawalec/opseeq:v5`

Or with docker-compose (standalone opseeq only):
```yaml
services:
  opseeq:
    image: opseeq:v5
    ports: ["${OPSEEQ_PORT:-9090}:9090"]
    env_file: .env
    restart: unless-stopped
    deploy:
      resources:
        limits: { memory: 512M }
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:9090/health/ready"]
      interval: 15s
      timeout: 5s
      retries: 3
```
