# Opseeq v6 integration manual

This manual documents the Opseeq surfaces implemented in this repository. It does not describe planned services as if they are live.

Opseeq is a local-first orchestration dashboard and agentic operating layer. It coordinates:

- a Node.js HTTP gateway in `service/`
- a local dashboard in `dashboard/`
- MCP tools exposed by the gateway
- connected local apps such as Mermate, Synth, Lucidity, Ollama, NemoClaw, and OpenShell
- a separate QGoT-backed copilot stack in `copilot/`
- local artifacts, run logs, and human approval state

The gateway is not a hosted SaaS service. It assumes a trusted local operator unless you configure API keys and network binding carefully.

## Runtime surfaces

| Surface | Default | Implementation | Purpose |
|---|---:|---|---|
| Opseeq gateway | `http://127.0.0.1:9090` | `service/src/index.ts` | OpenAI-compatible API, MCP, status, OODA, graph, app, and execution control routes |
| Dashboard | `http://127.0.0.1:7070` | `dashboard/server.js` | Operator UI and local app launcher |
| Copilot API | `http://127.0.0.1:7100` | `copilot/api/` | REST, GraphQL, SSE, and MCP proxy for QGoT-backed copilot runs |
| Copilot MCP | `http://127.0.0.1:7102/rpc` | `copilot/mcp/server.ts` | JSON-RPC MCP tool bridge |
| Copilot web | `http://127.0.0.1:7101` | `copilot/web/` | Browser UI for prompts, runs, and model bindings |
| Copilot Postgres | `127.0.0.1:5433` | `copilot/store/` | Prisma schema and local database target; current API reads run state from `copilot/runs/` |

## Gateway HTTP API

Authentication: if `OPSEEQ_API_KEYS` or `OPSEEQ_API_KEY` is set, protected routes require `Authorization: Bearer <key>`. If unset, protected routes are open for development.

| Method | Path | Implemented behavior |
|---|---|---|
| `GET` | `/health` | Liveness, version, providers, MCP flag, serverless flag, uptime |
| `GET` | `/health/ready` | Readiness; returns `503` while shutting down |
| `GET` | `/v1/health` | OpenAI-style health check |
| `GET` | `/v1/models` | OpenAI-compatible model list from configured providers |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completion; non-streaming records inference artifacts |
| `POST` | `/v1/embeddings` | Embedding proxy through the selected embedding provider |
| `GET` | `/api/status` | Aggregated gateway, app, graph, artifact, model, MCP, and integration status |
| `GET` | `/api/artifacts` | Recent in-memory inference artifacts from `feedback.ts` |
| `GET` | `/api/integrations` | Mermate and Synth readiness summary |
| `POST` | `/api/chat` | Convenience chat wrapper over Ollama or Opseeq gateway routing |
| `GET` | `/api/connectivity` | Local and external connectivity probes |
| `POST` | `/api/connectivity/probe` | HTTPS HEAD probe for a supplied host |
| `POST` | `/api/repos/connect` | Analyze a local repo and merge Opseeq `.env` / `.mcp.json` wiring |
| `POST` | `/api/apps/open` | Open or launch a managed local app surface |
| `GET` | `/api/nemoclaw/status` | NemoClaw registry, gateway, sandbox, and app status |
| `POST` | `/api/nemoclaw/actions` | `connect`, `status`, or `logs` for a registered sandbox |
| `POST` | `/api/nemoclaw/default` | Set the default NemoClaw sandbox |
| `GET` | `/api/ooda/extensions` | Precision orchestration defaults and extension registry |
| `GET` | `/api/ooda/dashboard` | Living graph dashboard and recent immutable artifacts |
| `GET` | `/api/ooda/graph` | Full Living Architecture Graph plus query result |
| `GET` | `/api/ooda/graph/search` | Graph query by text, repo, task, kind, and limit |
| `GET` | `/api/ooda/graph/node/:nodeId` | Single graph node with backlinks |
| `POST` | `/api/ooda/graph/refresh` | Refresh graph index and optionally record a version artifact |
| `POST` | `/api/ooda/precision` | Plan or execute the Mermate/Lucidity precision workflow, gated by `approved` and `execute` |
| `GET` | `/api/architect/status` | Mermate availability |
| `POST` | `/api/architect/pipeline` | Proxy to Mermate render pipeline |
| `POST` | `/api/builder/scaffold` | Proxy to Mermate render with scaffold flag |
| `GET/POST` | `/api/render*`, `/api/agent/modes`, `/api/agents`, `/api/copilot/health` | Mermate proxy routes |
| `GET/POST` | `/api/execution/*`, `/api/pipeline/*`, `/api/subagents/*`, `/api/agent-os/*`, `/api/nemotron/*`, `/api/seeq/*` | Local execution, pipeline, subagent, AgentOS, alias, and residency surfaces |
| `GET` | `/mcp` | Gateway MCP over SSE when `OPSEEQ_MCP_ENABLED` is not `false` |
| `POST` | `/mcp/messages` | Gateway MCP message handler |

Some read-only diagnostic routes are intentionally light-weight and do not all use gateway auth today. Treat the gateway and dashboard as local-control surfaces unless you harden the deployment.

## Chat completion contract

Minimal request:

```bash
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_OPSEEQ_KEY" \
  -d '{
    "model": "gpt-oss:20b",
    "messages": [{ "role": "user", "content": "Hello" }],
    "temperature": 0
  }'
```

Response shape is OpenAI-compatible and may include `_opseeq`:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1770000000,
  "model": "gpt-oss:20b",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ],
  "_opseeq": {
    "provider": "ollama",
    "latencyMs": 1200
  }
}
```

Streaming is supported for OpenAI-compatible providers. Anthropic and Ollama streaming are not implemented in the gateway stream path today; use non-streaming for those providers.

Idempotency: non-streaming `POST /v1/chat/completions` honors `Idempotency-Key` for one hour. Set `OPSEEQ_IDEMPOTENCY_BODY_HASH=true` to include a request body hash in the cache key.

Tracing: `x-request-id` is stored on the Express request and passed to the optional Rust kernel. Non-streaming inference artifacts store it as `traceId`. The gateway does not send the trace id to upstream model providers and does not currently echo it as a response header.

## Gateway MCP tools

The gateway MCP server is built in `service/src/mcp-server.ts`. Tool discovery is via MCP `tools/list`; tool invocation is via `tools/call`.

Important tool groups:

| Group | Examples | Notes |
|---|---|---|
| Gateway status and inference | `opseeq_status`, `opseeq_chat`, `inference`, `list_models`, `multi_inference`, `health_check` | Uses configured gateway providers |
| Connectivity | `opseeq_connectivity_probe` | Probes external host reachability |
| Mermate | `mermate_status`, `mermate_render`, `mermate_generate_tla`, `mermate_generate_ts`, `pipeline_orchestrate`, `artifact_verify` | Proxies local Mermate endpoints |
| Synth | `synth_status`, `synth_predict`, `synth_predictions`, `synth_markets`, `synth_portfolio` | Uses Synth local API; external effects depend on Synth configuration |
| Precision orchestration | `precision_status`, `precision_plan`, `precision_dashboard`, `living_architecture_graph`, `living_architecture_search`, `living_architecture_node`, `living_architecture_refresh` | Mirrors the REST OODA and graph surfaces |
| Desktop and repos | `desktop_scan`, `repo_organize`, `browser_navigate`, `browser_interact` | Local-resource tools; treat as operator-controlled |

Read tools return structured JSON or an MCP error envelope. Write/effectful tools should be driven from an explicit plan and approval path.

## Copilot REST, GraphQL, and MCP

The `copilot/` directory is separate from the `service/` gateway. It has its own API, MCP bridge, web UI, and run artifacts.

REST:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Copilot API liveness |
| `GET` | `/readyz` | Copilot API readiness |
| `POST` | `/v1/copilot/prompt` | Submit prompt through `qgot.execute` |
| `GET` | `/v1/copilot/runs` | List `copilot/runs/*/state.json` |
| `GET` | `/v1/copilot/runs/<id>` | Serve one run `state.json` |
| `GET` | `/v1/copilot/runs/<id>/events` | Serve one run `trace.ndjson` |
| `GET` | `/v1/copilot/runs/sse/<id>` | Tail run events over SSE |
| `POST` | `/v1/copilot/runs/control` | Pause, resume, or redirect through `qgot.observe` |
| `GET/PUT` | `/v1/copilot/models` | List or update role model bindings |
| `GET` | `/v1/copilot/qgot/status` | QGoT bridge readiness |
| `GET` | `/v1/copilot/metrics/summary` | Aggregate run count, status counts, and max drift |
| `POST` | `/mcp/rpc` | Proxy JSON-RPC to the TypeScript MCP bridge |

GraphQL is implemented by a small hand-written endpoint in `copilot/api/graph.go`. `GET /graphql/schema` serves the SDL. `POST /graphql` recognizes `submitPrompt`, `setRoleModel`, `run`, `runs`, `models`, and `qgotStatus`.

Copilot MCP tools are implemented in `copilot/mcp/server.ts`: `qgot.plan`, `qgot.verify`, `qgot.execute`, `qgot.observe`, `qgot.qal.simulate`, `qgot.models`, and `qgot.status`.

Persistence note: the Prisma schema exists under `copilot/store/schema.prisma`, but the current Go API reads run envelopes and traces from `copilot/runs/<id>/`. Do not assume Postgres is the source of truth for run state until the code path is implemented.

## System trace

| User action | UI component | Route | Handler/client | Storage/artifact | Human approval |
|---|---|---|---|---|---|
| Inspect readiness | Dashboard overview cards | `/api/status`, `/api/nemoclaw/status`, `/api/apps/registry` | Express gateway plus dashboard local control | In-memory status, local registries | Not required |
| Connect local repo | `Connect a New App` panel | `/api/repos/connect` | `service/src/repo-connect.ts` | Target repo `.env` and `.mcp.json` | Should be reviewed because files are modified |
| Open local app | App cards or connected surfaces | `/api/apps/open` | `dashboard/lib/local-control.js` or `service/src/app-launcher.ts` | No Opseeq artifact; may launch local process | Operator action |
| Plan precision workflow | Precision tab | `/api/ooda/precision` | `orchestratePrecisionPipeline` | `~/.opseeq-superior/artifacts/*`, temporal JSONL, graph version | Required before `execute=true` |
| Refresh graph | Living Graph tab | `/api/ooda/dashboard?refresh=true` or `/api/ooda/graph/refresh` | `living-architecture-graph.ts` | Graph index and optional immutable graph artifact | Not required unless writing a version is treated as persistent state |
| Sandbox inspect/connect/logs | NemoClaw tab | `/api/nemoclaw/actions` | `nemoclaw-control.ts` or dashboard terminal bridge | Terminal output only | Operator action; destructive sandbox commands are not exposed here |
| Submit copilot task | Copilot web prompt | `/v1/copilot/prompt` | Go API -> TS MCP `qgot.execute` -> workflow engine or QGoT bridge | `copilot/runs/<id>/` | Current copilot execution path has pause/resume/redirect, but no file-diff approval UI |
| Change copilot model binding | Copilot web models | `/v1/copilot/models` or GraphQL `setRoleModel` | TS MCP `qgot.models` | Runtime registry; Prisma schema exists for future persistence | Operator action |

## Human-in-the-loop semantics

Effectful workflows must make these fields visible to users:

- requested action
- reason
- tool or service
- affected files or resources
- reversibility
- required approval state
- what happens on approval
- what happens on rejection
- artifact or result location

Implemented approval signals:

- `service/src/mermate-lucidity-ooda.ts` returns `executionEnvelope.approved`, `commands`, `fileScope`, `networkScope`, and `stageResults`.
- Temporal events include `approvalState`.
- Stage status can be `pending_approval`, `ready`, `executed`, `blocked`, or `unavailable`.

Not fully implemented:

- a general diff viewer for all effectful actions
- a universal approval queue shared by dashboard, gateway MCP, and copilot
- durable copilot pause/resume state outside the in-memory engine

## Environment variables

Gateway:

| Variable | Purpose |
|---|---|
| `OPSEEQ_PORT`, `PORT` | Gateway port |
| `OPSEEQ_HOST` | Gateway host bind |
| `OPSEEQ_API_KEYS`, `OPSEEQ_API_KEY` | Bearer tokens for protected gateway routes |
| `OPSEEQ_DEFAULT_MODEL` | Default model when request omits one |
| `OPSEEQ_MCP_ENABLED` | Enables `/mcp` and `/mcp/messages` unless set to `false` |
| `OPSEEQ_SERVERLESS`, `OPSEEQ_IDLE_TIMEOUT_MS`, `OPSEEQ_IDLE_SHUTDOWN` | Idle shutdown behavior |
| `OPSEEQ_LOG_LEVEL` | Log level hint |
| `OPSEEQ_IDEMPOTENCY_CACHE_MAX`, `OPSEEQ_IDEMPOTENCY_BODY_HASH` | Non-streaming completion idempotency behavior |
| `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NVIDIA_MODELS` | NVIDIA NIM provider |
| `NIM_LOCAL_URL`, `NIM_LOCAL_API_KEY`, `NIM_LOCAL_MODELS` | Local NIM provider |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODELS` | OpenAI-compatible provider |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODELS` | Anthropic provider |
| `CORE_THINK_AI_API_KEY`, `CORE_THINK_AI_BASE_URL`, `CORE_THINK_AI_MODELS` | CoreThink provider |
| `OLLAMA_URL`, `OLLAMA_MODELS`, `OLLAMA_MODEL`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL` | Local Ollama provider |
| `MERMATE_URL`, `SYNTHESIS_TRADE_URL`, `LUCIDITY_URL` | Connected local app URLs |
| `SEEQ_WARM_WINDOW_MS`, `SEEQ_ESCALATION_CODE_THRESHOLD`, `SEEQ_ESCALATION_REASON_THRESHOLD` | SeeQ model residency heuristics |

Dashboard:

| Variable | Purpose |
|---|---|
| `OPSEEQ_DASHBOARD_PORT` | Dashboard port |
| `OPSEEQ_DASHBOARD_HOST` | Dashboard host bind |
| `OPSEEQ_GATEWAY_URL` | Gateway URL proxied by dashboard |
| `OPSEEQ_SESSION_SHUTDOWN`, `OPSEEQ_SHUTDOWN_GRACE_MS` | Launcher-session shutdown behavior |
| `OPSEEQ_TERMINAL_APP` | Preferred macOS terminal app for spawned terminal commands |
| `MERMATE_REPO`, `SYNTH_REPO`, `LUCIDITY_REPO` | Local repo discovery |
| `MERMATE_LAUNCH_CMD`, `SYNTHESIS_TRADE_LAUNCH_CMD`, `LUCIDITY_LAUNCH_CMD` | Optional launch commands |

Copilot:

| Variable | Purpose |
|---|---|
| `COPILOT_API_HOST`, `COPILOT_API_PORT` | Copilot API bind |
| `COPILOT_WEB_PORT` | Vite web port |
| `COPILOT_MCP_PORT`, `COPILOT_MCP_RPC` | MCP HTTP bridge |
| `DATABASE_URL` | Prisma/Postgres target |
| `QGOT_ENV_PATH` | Optional upstream QGoT `.env` path |
| `QGOT_HTTP_BASE`, `QGOT_MCP_CMD`, `QGOT_BRIDGE_MODE`, `QGOT_BRIDGE_TIMEOUT_MS`, `QGOT_BRIDGE_EXECUTE_TIMEOUT_MS` | QGoT bridge behavior |
| `QGOT_RUN_DIR` | Run artifact directory |
| `OPSEEQ_OBSERVER_MODEL`, `OPSEEQ_PLANNER_MODEL`, `OPSEEQ_CODER_MODEL`, `OPSEEQ_VERIFIER_MODEL`, `OPSEEQ_EXECUTOR_MODEL` | Role model defaults |
| `OPSEEQ_OBSERVER_PROVIDER`, `OPSEEQ_PLANNER_PROVIDER`, `OPSEEQ_CODER_PROVIDER`, `OPSEEQ_VERIFIER_PROVIDER`, `OPSEEQ_EXECUTOR_PROVIDER` | Role provider overrides |
| `DRIFT_THRESHOLD`, `TRACE_ENABLED`, `EMBEDDING_MODEL`, `EMBEDDING_PROVIDER` | Observability settings |

## Production-readiness notes

- Set gateway API keys before exposing the gateway beyond localhost.
- Keep dashboard and copilot API bound to loopback unless you add authentication and network controls.
- Treat local app launch, repo connection, terminal, and runtime redeploy routes as privileged operations.
- Verify connected app status from `/api/status` or the dashboard before assuming Mermate, Synth, Lucidity, Ollama, QGoT, or Postgres are available.
- Do not present in-memory inference artifacts as durable audit logs. Durable gateway artifacts live under `~/.opseeq-superior/artifacts/`; copilot run artifacts live under `copilot/runs/<id>/`.
