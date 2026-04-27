# Opseeq

Opseeq is a local-first orchestration workspace for operating AI gateway routes, protocol tools, connected local apps, and a QGoT-backed copilot from a developer workstation.

The repository currently contains four distinct surfaces:

| Surface | Path | Implemented role |
|---|---|---|
| Opseeq gateway | `service/` | Express service exposing OpenAI-compatible inference, `/api/*` control routes, MCP over SSE, status aggregation, app/repo actions, precision/OODA routes, Mermate/Synth proxies, AgentOS routes, and artifact/status APIs. |
| Opseeq dashboard | `dashboard/` | Local operator UI served by Express. It proxies gateway routes, renders status and readiness cards, exposes NemoClaw/app controls, and provides WebSocket-backed terminal profiles. |
| Opseeq Copilot | `copilot/` | Separate Go + TypeScript + Vite stack for QGoT-backed plan, verify, execute, observe, model-binding, run-history, GraphQL, SSE, and MCP workflows. |
| NemoClaw reference stack | `bin/`, `nemoclaw/`, `nemoclaw-blueprint/`, `docs/` | Inherited/reference stack for running OpenClaw in OpenShell sandboxes. These docs and commands are not the canonical Opseeq gateway or copilot API. |

## Product scope

Opseeq coordinates local and remote AI services through explicit gateway, dashboard, and copilot boundaries:

- Routes chat completions and embeddings through configured providers in `service/src/config.ts` and `service/src/router.ts`.
- Reports readiness for Ollama, configured model providers, Mermate, Synth, NemoClaw, the Living Architecture Graph, and precision orchestration assets through `GET /api/status`.
- Exposes MCP tools from `service/src/mcp-server.ts` for status, chat, connectivity probes, model listing, Mermate/Synth actions, repo organization, precision planning, graph queries, and browser-use helpers.
- Connects repositories and app surfaces through `POST /api/repos/connect` and `POST /api/apps/open`.
- Runs precision/OODA planning through `POST /api/ooda/precision`; effectful execution is controlled by request flags such as `approved`, `execute`, `allowRemoteAugmentation`, and artifact options.
- Runs QGoT copilot workflows through `copilot/`; the production Go API invokes the QGoT MCP stdio gateway configured by `QGOT_MCP_CMD` and fails closed when that command is missing or unavailable.

Not implemented as a single universal control plane today:

- A single database source of truth for all Opseeq state.
- A universal approval system that wraps every gateway route.
- A guaranteed running Mermate, Synth, Ollama, QGoT, or NemoClaw instance; those services are probed and reported as available/degraded/offline.
- Production authorization for the dashboard itself. Keep it on loopback unless you add external controls.

## Quick start

### Gateway

```bash
cp .env.example .env
npm --prefix service install
npm --prefix service run dev
```

Default gateway address: `http://127.0.0.1:9090` when `OPSEEQ_HOST=127.0.0.1` and `OPSEEQ_PORT=9090` are used.

Useful checks:

```bash
curl http://127.0.0.1:9090/health
curl http://127.0.0.1:9090/api/status
curl http://127.0.0.1:9090/v1/models
```

### Dashboard

```bash
npm --prefix dashboard install
OPSEEQ_GATEWAY_URL=http://127.0.0.1:9090 npm --prefix dashboard start
```

Default dashboard address: `http://127.0.0.1:7070`.

The dashboard server reads:

- `OPSEEQ_DASHBOARD_HOST` default `127.0.0.1`
- `OPSEEQ_DASHBOARD_PORT` default `7070`
- `OPSEEQ_GATEWAY_URL` default `http://127.0.0.1:9090`

### Copilot

```bash
cd copilot
cp .env.example .env
make install
make dev
```

Default copilot ports:

- Go API: `127.0.0.1:7100`
- Vite web UI: `127.0.0.1:7101`
- Go API MCP proxy: `127.0.0.1:7100/mcp/rpc`, forwarded to `QGOT_MCP_CMD`
- Optional TypeScript MCP dev server: `127.0.0.1:7102/rpc`
- Optional QGoT HTTP service/reference surface: `127.0.0.1:7300`
- QGoT MCP stdio command: `QGOT_MCP_CMD`

Run the copilot quality gate with:

```bash
make qc
```

## Main routes

### Gateway routes

Implemented in `service/src/index.ts`.

| Route | Purpose |
|---|---|
| `GET /health`, `GET /health/ready`, `GET /v1/health` | Gateway health/readiness. |
| `GET /v1/models` | OpenAI-compatible model list from configured providers. |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions, including streaming. |
| `POST /v1/embeddings` | Embedding proxy through the selected embedding provider. |
| `GET /api/status` | Aggregated gateway, provider, app, graph, artifact, and integration status. |
| `POST /api/chat` | Console-compatible chat wrapper over Opseeq or Ollama transport. |
| `GET /api/artifacts` | Recent in-memory inference artifacts from `service/src/feedback.ts`. |
| `GET /mcp`, `POST /mcp/messages` | Gateway MCP SSE transport when `OPSEEQ_MCP_ENABLED` is not `false`. |
| `POST /api/repos/connect` | Analyze/connect a local repo through `service/src/repo-connect.ts`. |
| `POST /api/apps/open` | Open a configured app surface through `service/src/app-launcher.ts`. |
| `GET/POST /api/ooda/*` | Precision orchestration and Living Architecture Graph routes. |
| `GET/POST /api/render*`, `/api/architect/*`, `/api/builder/scaffold` | Mermate proxy and pipeline routes. |
| `GET/POST /api/nemoclaw/*` | NemoClaw status/action/default controls. |
| `GET/POST /api/execution/*`, `/api/pipeline/*`, `/api/subagents/*`, `/api/agent-os/*` | Local execution, adaptive pipeline, subagent, and AgentOS surfaces. |
| `GET/POST /api/nemotron/*`, `/api/seeq/*` | Nemotron alias resolution and SeeQ model residency/role helpers. |

### Copilot routes

Implemented in `copilot/api/*.go`.

| Route | Purpose |
|---|---|
| `GET /healthz`, `GET /readyz` | Copilot API health/readiness. |
| `GET /v1/copilot/qgot/status` | QGoT readiness as seen by Opseeq. |
| `POST /v1/copilot/prompt` | Submit a prompt to `qgot.execute`. |
| `GET /v1/copilot/runs`, `GET /v1/copilot/runs/{id}` | Read file-backed run envelopes from `runs/`. |
| `GET /v1/copilot/runs/{id}/events` | Serve `trace.ndjson`. |
| `GET /v1/copilot/runs/sse/{id}` | Tail `trace.ndjson` as server-sent events. |
| `GET/PUT /v1/copilot/models` | List or update role-to-model bindings. |
| `POST /v1/copilot/runs/control` | Pause, resume, or record redirect intent through `qgot.observe`. |
| `POST /graphql`, `GET /graphql/schema` | Hand-written GraphQL endpoint and SDL. |
| `/mcp/rpc` | MCP JSON-RPC proxy to the required QGoT MCP stdio command configured by `QGOT_MCP_CMD`. |

## Data and artifacts

| Data | Location | Notes |
|---|---|---|
| Gateway inference feedback | In memory, exposed by `GET /api/artifacts` | Bounded ring buffer in `service/src/feedback.ts`; not durable storage. |
| Gateway immutable artifacts | `~/.opseeq-superior/artifacts/<task-id>/` | Written by `service/src/trace-sink.ts` for precision, graph, temporal, and related artifacts. |
| Gateway temporal events | `~/.opseeq-superior/logs/temporal-causality.jsonl` | Written by `service/src/temporal-causality.ts`; events are also mirrored as immutable artifacts. |
| Copilot runs | `copilot/runs/<run_id>/` or `QGOT_RUN_DIR` | Contains `prompt.txt`, `state.json`, `trace.ndjson`, `plan.json`, `verify.json`, `exec.jsonl`, and related files when produced. |
| Copilot Prisma schema | `copilot/store/schema.prisma` | Schema exists for Postgres, but current run reads are file-backed in the Go API. |

## Configuration

Gateway environment examples live in `.env.example`; copilot examples live in `copilot/.env.example`.

High-use gateway variables:

- `OPSEEQ_PORT`, `PORT`, `OPSEEQ_HOST`
- `OPSEEQ_API_KEYS`, `OPSEEQ_API_KEY`
- `OPSEEQ_DEFAULT_MODEL`, `OPSEEQ_MCP_ENABLED`
- `OLLAMA_URL`, `OLLAMA_MODELS`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`
- `NIM_LOCAL_URL`, `NIM_LOCAL_API_KEY`, `NIM_LOCAL_MODELS`
- `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NVIDIA_MODELS`
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODELS`
- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODELS`
- `MERMATE_URL`, `SYNTHESIS_TRADE_URL`

High-use copilot variables:

- `COPILOT_API_HOST`, `COPILOT_API_PORT`, `COPILOT_WEB_PORT`, `COPILOT_MCP_PORT`
- `DATABASE_URL`
- `QGOT_HTTP_BASE`, `QGOT_MCP_CMD`, `QGOT_RUN_DIR`
- `COPILOT_MCP_TIMEOUT_MS`, `COPILOT_MCP_EXECUTE_TIMEOUT_MS`
- `OPSEEQ_OBSERVER_MODEL`, `OPSEEQ_PLANNER_MODEL`, `OPSEEQ_CODER_MODEL`, `OPSEEQ_VERIFIER_MODEL`, `OPSEEQ_EXECUTOR_MODEL`

## Documentation map

Start here:

- `opseeq-architecture.md` — current Opseeq architecture and implemented boundaries.
- `docs/INTEGRATION.md` — broad integration reference; still being reduced into exact canonical references.
- `copilot/README.md` — copilot setup and operation.
- `copilot/docs/architecture.md` — copilot process, bridge, and persistence architecture.
- `copilot/docs/api.md` — copilot REST, GraphQL, SSE, and MCP reference.
- `copilot/docs/system-trace.md` — user-action trace for copilot workflows.

NemoClaw-specific docs remain under `docs/` and describe the inherited OpenShell/OpenClaw sandbox reference stack, not the Opseeq gateway API.

## Validation

Gateway:

```bash
npm --prefix service run build
```

Copilot:

```bash
cd copilot
make qc
```

Root `make docs` builds the inherited Sphinx documentation tree under `docs/`; it is not required for the gateway or copilot TypeScript/Go builds.

## License

This repository retains the existing project license in `LICENSE`.
