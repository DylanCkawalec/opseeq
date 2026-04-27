# API

This file documents the implemented Opseeq Copilot API. Copilot is separate from the root Opseeq gateway in `service/`.

## REST (Go gateway)

The API binds to `COPILOT_API_HOST:COPILOT_API_PORT` and should stay loopback-only unless another access-control layer is added.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/v1/copilot/prompt` | `{prompt}` | `RunEnvelope` |
| GET  | `/v1/copilot/runs` | — | `RunEnvelope[]` |
| GET  | `/v1/copilot/runs/<id>` | — | `RunEnvelope` (state.json) |
| GET  | `/v1/copilot/runs/<id>/events` | — | trace.ndjson |
| GET  | `/v1/copilot/runs/sse/<id>` | — | SSE stream of events |
| POST | `/v1/copilot/runs/control` | `{RunID, Action, Reason?, NewPrompt?}` | `{ok}` |
| GET  | `/v1/copilot/models` | — | `{bindings:[{role,provider,model}]}` |
| PUT  | `/v1/copilot/models` | `{Role, Provider, Model}` | updated binding |
| GET  | `/v1/copilot/qgot/status` | — | QGoT HTTP/MCP readiness as seen by Opseeq |
| GET  | `/v1/copilot/metrics/summary` | — | `{total_runs, by_status, drift_max}` from `runs/*/state.json` |
| GET  | `/healthz`, `/readyz` | — | `{ok}` / `{ready}` |
| POST | `/mcp/rpc` | JSON-RPC | forwards one request to `QGOT_MCP_CMD` |

## GraphQL (`POST /graphql`)

SDL is served at `GET /graphql/schema`. Operations recognized in v0.1:

```graphql
mutation { submitPrompt(prompt: $prompt) { id status driftMax } }
mutation { setRoleModel(role: $role, provider: $provider, model: $model) { role provider model } }
query    { run(id: $id) { id status driftMax } }
query    { runs { id status } }
query    { models { bindings { role provider model } } }
query    { qgotStatus }
```

The GraphQL handler is intentionally hand-written in `api/graph.go`. Unsupported operations return a hint instead of executing arbitrary GraphQL.

## MCP tools (stdio + HTTP/SSE)

| Tool | Args | Returns |
|---|---|---|
| `qgot.plan` | `{prompt}` | `Plan` |
| `qgot.verify` | `{prompt, plan}` | `Verification` |
| `qgot.execute` | `{prompt}` | `RunEnvelope` |
| `qgot.observe` | `{run_id, action, reason?, new_prompt?}` | `{ok}` |
| `qgot.qal.simulate` | passthrough | passthrough JSON |
| `qgot.models` | `{action: list\|set, role?, provider?, model?}` | bindings |
| `qgot.status` | `{}` | QGoT MCP readiness |

Production transport URL: `http://127.0.0.1:7100/mcp/rpc`. The Go API forwards this raw JSON-RPC body to the command configured by `QGOT_MCP_CMD`.

The optional TypeScript development MCP server can still expose `http://127.0.0.1:7102/rpc`, but that server is not the production fallback path for the Go API.

## QGoT production MCP command

The Go API requires `QGOT_MCP_CMD` for all QGoT tool calls. Configure `QGOT_MCP_CMD`, `COPILOT_MCP_TIMEOUT_MS`, `COPILOT_MCP_EXECUTE_TIMEOUT_MS`, and `QGOT_RUN_DIR`. Missing or failing QGoT MCP returns explicit API errors; there is no production fallback to TypeScript, QGoT HTTP, or local workflow execution.

## Storage and safety notes

- Run IDs are opaque local run directory names. REST, SSE, and GraphQL file-backed run reads accept only `A-Z`, `a-z`, `0-9`, `_`, and `-` to avoid path traversal.
- Run state and traces are currently read from `copilot/runs/<id>/`, not Postgres.
- The TypeScript development workflow has local verifier behavior for tests and experiments, but the production Go API does not use it as fallback execution.
- Mock providers are for tests and smoke benches only.

## Event types (over SSE)

`RunStarted`, `RoleStarted`, `RoleEmitted`, `PlanProposed`, `VerifierVerdict`, `TaskStarted`, `TaskExecuted`, `DriftDetected`, `PausedByObserver`, `ResumedByObserver`, `RedirectedByObserver`, `RunFinished`.
