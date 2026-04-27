# Copilot TODO ledger

Tag format: `[role][priority] description (file:line)`
Greppable: `grep '\[planner\]\[P0\]' TODO.md`

## P0 (blockers for v0.1)

- `[scaffold][P0]` verify all dirs ≤2 levels (Makefile depth-check)
- `[models][P0]` wire NVIDIA NIM client to QGoT/.env (models/nvidia.ts:1)
- `[agents][P0]` implement planner→verifier→executor loopback (workflow/engine.ts:1)
- `[obs][P0]` runs/<id>/ writer with full artifact set (obs/writer.ts:1)
- `[mcp][P0]` expose qgot.plan/verify/execute/observe as MCP tools (mcp/server.ts:1)
- `[api][P0]` Go GraphQL submitPrompt + run query + runEvents subscription (api/graph.go:1)

## P1 (v0.1 nice-to-have)

- `[agents][P1]` drift score uses real embeddings (agents/observer.ts)
- `[web][P1]` live timeline with role panels and drift gauge (web/main.ts)
- `[qgot-gateway][P1]` Rust executor.rs reuses ooda_orchestrator coder path (gateway/executor.rs)
- `[store][P1]` retention/compaction job for runs/ older than 30d

## P2 (post v0.1)

- `[models][P2]` add OpenRouter unified routing
- `[mcp][P2]` WebSocket transport in addition to stdio + SSE
- `[obs][P2]` OTLP exporter to Tempo/Jaeger
- `[api][P2]` auth + multi-tenant
