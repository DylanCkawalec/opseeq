# Quality-control & refactoring strategy

## Three flat root files

- `TODO.md` — `[role][priority] description (file:line)`
- `QC.md`   — checklist run by `make qc`
- `REFACTOR.md` — append-only file:line refactor targets
All three are plain markdown so `grep` is the only tool needed:

```bash
grep '\[planner\]\[P0\]'  TODO.md
grep '^QC: '              QC.md
grep -nE '^- ' REFACTOR.md
```

## Static gate

- Lint: `pnpm run lint` (eslint over `agents/ workflow/ models/ mcp/ obs/`).
- Typecheck: `pnpm run typecheck` (`tsc --noEmit` against `tsconfig.json`).
- Vet: `cd api && go vet ./...`.
- Hermetic build: `cd api && go build` produces a single binary into `bin/`.
- Depth check: `make depth-check` enforces ≤2 owned levels under `copilot/`.

## Behavioral gate

- MCP self-test (`mcp/selftest.ts`) — list-tools + qgot.plan with mock provider.
- Workflow fixture replay — `bench/fixtures/*.json` reproduce identical artifacts.
- Verifier-rejection loop — synthetic plan triggers re-plan; second plan recorded.
- Drift sentinel — synthetic off-topic task triggers `DriftDetected`.

## Performance gate

- `bench/smoke.sh` finishes in <30s on mock backend.
- First-token latency on `/v1/copilot/prompt` <500 ms with cached planner.

## Refactor targets (initial; see REFACTOR.md for live ledger)

- Replace hand-rolled GraphQL with `gqlgen` once the schema stabilizes.
- Move pause/resume signal from in-memory channel to Postgres advisory lock.
- Collapse `gateway/role_registry.rs` and `qgot::model_tiers` once both repos share a workspace.
- Add WebSocket transport on `mcp/server.ts` alongside stdio + HTTP/SSE.
- Carve a proper `ExecutorRole` trait inside QGoT once a second executor implementation exists.

## Cadence

- Every PR runs `make qc`.
- Every release tags both repos and writes a row to `QC.md` with results.
