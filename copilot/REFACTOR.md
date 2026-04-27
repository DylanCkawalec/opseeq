# Refactor ledger (append-only, file:line + rationale)

Greppable: `grep -E '^- ' REFACTOR.md`

## Targets identified during scaffold

- agents/observer.ts:1 — drift uses placeholder cosine until embeddings adapter is wired (owner: agents)
- agents/coder.ts:1 — currently stubs out tool execution; integrate with QGoT code_sandbox.rs (owner: qgot-gateway)
- workflow/engine.ts:1 — pause/resume token uses in-memory channel; promote to Postgres advisory lock for durability (owner: workflow)
- mcp/server.ts:1 — stdio only at first; add HTTP/SSE transport mounted under api/ (owner: mcp)
- api/graph.go:1 — gqlgen schema is hand-written; switch to `go generate` workflow once stable (owner: api)
- store/schema.prisma:1 — events stored as JSONB; revisit indexed columns once query patterns settle (owner: store)
- ../../QGoT/gateway/executor.rs:1 — placeholder calls into ooda_orchestrator; should bind directly to a new ExecutorRole trait once carved out of OODA (owner: qgot-gateway)
- ../../QGoT/gateway/role_registry.rs:1 — duplicates `model_tiers.rs`; collapse once both repos can share via cargo workspace (owner: qgot-gateway)

## Cross-cutting

- "depth-check" must be wired into CI (owner: scaffold)
- single source of truth for role names: introduce `obs/schema.ts:Role` and re-export to Go via `api/role.go` generated stub (owner: obs)
