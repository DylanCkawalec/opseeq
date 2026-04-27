# Opseeq Copilot

Opseeq Copilot is the QGoT-backed orchestration stack under `copilot/`. It is a separate runtime from the root Opseeq gateway in `service/`.

It accepts a prompt, sends production plan/verify/execute/status calls to the QGoT MCP gateway, records run artifacts, exposes run history, and reports QGoT readiness. The production Go API requires `QGOT_MCP_CMD`; missing or failing QGoT MCP is reported as an integration failure rather than recovered through a local fallback.

## Implemented surfaces

| Surface | Path | Role |
|---|---|---|
| Go API | `api/` | REST, GraphQL, SSE, metrics, and `/mcp/rpc`; production `qgot.*` calls go directly through `QGOT_MCP_CMD`. |
| TypeScript MCP server | `mcp/server.ts` | Development JSON-RPC tool server for `qgot.*`; not the production fallback path for the Go API. |
| QGoT bridge | `mcp/qgot_bridge.ts` | Development/legacy TypeScript bridge logic for QGoT HTTP/MCP/local workflows. |
| Workflow engine | `workflow/engine.ts` | Local development `Plan → Verify → Execute` loop with bounded verifier rejections. |
| Agents | `agents/` | Planner, verifier, executor, observer, and coder behavior. |
| Model registry | `models/registry.ts` | Runtime role-to-provider/model bindings and provider adapters. |
| Observability | `obs/` | Run event schema and file writer. |
| Web UI | `web/` | Prompt submission, QGoT readiness, protocol checks, role bindings, run history, and SSE timeline. |
| Prisma schema | `store/schema.prisma` | Database schema target. Current run reads are file-backed. |
| Run artifacts | `runs/<run_id>/` or `QGOT_RUN_DIR` | Prompt, state, trace, plans, verifications, task output, observer output, logs. |

## Quick start

```bash
cp .env.example .env
make install
make dev
```

`make dev` starts local Postgres through Docker Compose, the TypeScript MCP development server, the Go API, and the Vite web UI. The Go API still requires `QGOT_MCP_CMD` for production QGoT operations.

Default local addresses:

| Process | Default |
|---|---|
| Go API | `http://127.0.0.1:7100` |
| Web UI | `http://127.0.0.1:7101` |
| Go API MCP proxy | `http://127.0.0.1:7100/mcp/rpc` forwarded to `QGOT_MCP_CMD` |
| TypeScript MCP dev server | `http://127.0.0.1:7102/rpc` |
| QGoT HTTP service | `http://127.0.0.1:7300` when running separately |
| Postgres | `127.0.0.1:5433` from `store/docker-compose.yml` |

Stop the local stack:

```bash
make stop
```

Run the quality gate:

```bash
make qc
```

`make qc` runs lint, typecheck, depth check, smoke benchmark, and API integration scripts.

## API summary

REST routes are implemented in `api/rest.go`.

| Route | Method | Behavior |
|---|---:|---|
| `/healthz` | GET | Returns `{ "ok": true }`. |
| `/readyz` | GET | Returns `{ "ready": true }`. |
| `/v1/copilot/qgot/status` | GET | Calls `qgot.status`; returns an explicit unavailable envelope if QGoT MCP is unavailable. |
| `/v1/copilot/prompt` | POST | Calls `qgot.execute` with `{ prompt }` and returns a run envelope. |
| `/v1/copilot/runs` | GET | Lists file-backed run envelopes from `QGOT_RUN_DIR`. |
| `/v1/copilot/runs/{id}` | GET | Serves `state.json` for a safe run id. |
| `/v1/copilot/runs/{id}/events` | GET | Serves `trace.ndjson` for a safe run id. |
| `/v1/copilot/runs/sse/{id}` | GET | Streams `trace.ndjson` as SSE. |
| `/v1/copilot/models` | GET | Calls `qgot.models` with `action:list`. |
| `/v1/copilot/models` | PUT | Calls `qgot.models` with `action:set`. |
| `/v1/copilot/runs/control` | POST | Calls `qgot.observe` with pause, resume, or redirect arguments. |

GraphQL is implemented in `api/graph.go` at `POST /graphql`; SDL is served at `GET /graphql/schema`.

Supported operations are detected by query text:

- `submitPrompt(prompt: String!)`
- `setRoleModel(role, provider, model)`
- `models`
- `qgotStatus`
- `run(id: ID!)`
- `runs`

SSE run streaming is implemented in `api/sse.go` and tails `runs/<id>/trace.ndjson`.

## MCP tools

Production calls are served by the QGoT MCP stdio gateway configured by `QGOT_MCP_CMD`. The TypeScript `mcp/server.ts` implementation remains available as development tooling.

| Tool | Behavior |
|---|---|
| `qgot.plan` | Create a QGoT plan. |
| `qgot.verify` | Verify a QGoT plan. |
| `qgot.execute` | Execute a QGoT copilot request. |
| `qgot.observe` | Inspect or control QGoT run state. |
| `qgot.qal.simulate` | Run QGoT QAL simulation. |
| `qgot.models` | List or set QGoT role model bindings. |
| `qgot.status` | Report QGoT service and protocol readiness. |

## Production QGoT MCP command

The Go API loads `QGOT_MCP_CMD` from `copilot/.env`, the process environment, or the optional QGoT env file selected by `QGOT_ENV_PATH`. It invokes the command through the local shell, writes one JSON-RPC request to stdin, and reads the first JSON response line from stdout.

Production rules:

- `QGOT_MCP_CMD` is mandatory for all Go API `qgot.*` calls.
- `/mcp/rpc` forwards raw JSON-RPC directly to `QGOT_MCP_CMD`.
- `COPILOT_MCP_TIMEOUT_MS` controls status/model/plan/observe calls.
- `COPILOT_MCP_EXECUTE_TIMEOUT_MS` controls `qgot.execute` and `qgot.qal.simulate`.
- The Go API does not fall back to the TypeScript MCP server, QGoT HTTP, or local workflow execution.

The sibling QGoT Rust implementation currently lives under `../../QGoT/rust/qgot/src/` with relevant files such as `copilot_contracts.rs`, `gateway.rs`, and `bin/qgot_copilot.rs`.

## TypeScript bridge development modes

`mcp/qgot_bridge.ts` still contains development bridge logic for the optional TypeScript MCP server. That path is useful for local experiments and compatibility checks, but it is not the production Go API fallback path.

Primary HTTP paths used by the TypeScript bridge when it is run directly:

- `/v1/qgot/copilot/status`
- `/v1/qgot/copilot/models`
- `/v1/qgot/copilot/plan`
- `/v1/qgot/copilot/verify`
- `/v1/qgot/copilot/execute`
- `/v1/qgot/copilot/runs/{run_id}`

Compatibility paths used by the TypeScript bridge when available:

- `/v1/qgot/pipelines`
- `/v1/qgot/qal/simulate`
- `/v1/qgot/observability/status`
- `/v1/qgot/runs/{run_id}`

## Workflow behavior

Implemented in `workflow/engine.ts`.

1. Create a run id and `RunWriter`.
2. Emit `RunStarted` and set status to `PLANNING`.
3. Call planner and write `plan.json` plus `plans.ndjson`.
4. Move to `VERIFYING` and call verifier.
5. If verifier returns `APPROVED`, execute the approved plan.
6. If verifier rejects, re-plan until `maxRejections` is exceeded.
7. Write task events and finish as `DONE` when all tasks are `DONE`, otherwise `FAILED`.

Observer controls:

- `pause(run_id, reason)` emits pause state for an active local run.
- `resume(run_id)` resumes an active local run.
- `redirect(run_id, new_prompt)` records a redirect event and observer entry. The current local submit loop is linear, so a follow-up submit is required to execute the redirected prompt.

## Run artifacts

Written by `obs/writer.ts`.

| File | Purpose |
|---|---|
| `prompt.txt` | Original prompt. |
| `state.json` | Current run envelope. |
| `trace.ndjson` | Event stream consumed by SSE and UI. |
| `plan.json` | Latest plan. |
| `plans.ndjson` | All plans emitted during the run. |
| `verify.json` | Latest verification. |
| `verify.ndjson` | All verifier outputs. |
| `exec.jsonl` | Task execution records. |
| `coder.jsonl` | Coder output entries when produced. |
| `observer.jsonl` | Observer, drift, pause, resume, and redirect records. |
| `log.txt` | Engine log lines. |

## Model bindings

`models/registry.ts` registers providers for `nvidia`, `ollama`, `openai`, `kimi`, `qwen`, and `mock`.

Default role bindings come from environment variables:

- `OPSEEQ_OBSERVER_PROVIDER`, `OPSEEQ_OBSERVER_MODEL`
- `OPSEEQ_PLANNER_PROVIDER`, `OPSEEQ_PLANNER_MODEL`
- `OPSEEQ_CODER_PROVIDER`, `OPSEEQ_CODER_MODEL`
- `OPSEEQ_VERIFIER_PROVIDER`, `OPSEEQ_VERIFIER_MODEL`
- `OPSEEQ_EXECUTOR_PROVIDER`, `OPSEEQ_EXECUTOR_MODEL`

Runtime `setRole` changes update the in-memory registry. The Prisma schema contains `ModelBinding` and `ModelBindingAudit`, but current model updates are not documented as database-authoritative unless code is added to persist them.

## Development commands

| Command | Purpose |
|---|---|
| `make install` | Install pnpm deps, tidy Go module, generate Prisma client. |
| `make dev` | Start Postgres, MCP, API, and web UI. |
| `make api-build` | Build the Go gateway binary. |
| `make api-run` | Run the built Go gateway. |
| `make mcp-run` | Run the TypeScript MCP server. |
| `make web-run` | Run the Vite web UI. |
| `make test` | Run TypeScript tests and Go tests when Go is available. |
| `make lint` | Run ESLint and Go vet when Go is available. |
| `make typecheck` | Run TypeScript typecheck. |
| `make depth-check` | Enforce the copilot directory depth rule. |
| `make bench-smoke` | Run `bench/smoke.sh`. |
| `make api-integration` | Run `bench/api_integration.sh`. |
| `make qc` | Run lint, typecheck, depth check, smoke, and API integration. |

## Documentation

- `docs/architecture.md` — implemented process, bridge, API, and persistence boundaries.
- `docs/api.md` — REST, GraphQL, SSE, and MCP reference.
- `docs/workflow.md` — temporal workflow and failure states.
- `docs/observability.md` — run event and artifact reference.
- `docs/system-trace.md` — user action to code trace.
