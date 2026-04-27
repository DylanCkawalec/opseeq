# Quality-control gate (`make qc`)

Greppable: `grep '^QC:' QC.md`

## Static

- QC: TS lint via eslint passes (`pnpm run lint`)
- QC: TS typecheck passes (`pnpm run typecheck`)
- QC: Go vet passes (`go vet ./...`)
- QC: Go build is hermetic (`go build` produces a single binary)
- QC: Depth check (`make depth-check`) — no dirs deeper than 2 levels under copilot/

## Behavioral

- QC: MCP self-test — list-tools + call qgot.plan with mock provider returns valid `Plan`
- QC: Workflow fixture replay — recorded fixture in `bench/fixtures/` produces identical artifact tree
- QC: Verifier rejection path — synthetic bad plan loops back to Planner; second plan recorded
- QC: Drift sentinel — synthetic off-topic task triggers `DriftDetected` event

## Performance / drift

- QC: `bench/smoke.sh` (mock backend, no Ollama) finishes in <30s
- QC: First-token latency on `/v1/copilot/prompt` < 500 ms with cached planner

## Observability

- QC: every `runs/<id>/` contains `prompt.txt`, `plan.json`, `verify.json`, `exec.jsonl`, `coder.jsonl`, `observer.jsonl`, `trace.ndjson`, `log.txt`, `state.json`
- QC: `trace.ndjson` validates against `obs/schema.ts` event union

## Provenance

- QC: provider audit — each role event records `model`, `provider`, `latency_ms`, `tokens_in`, `tokens_out`
- QC: role registry change is durable (Postgres row + audit log line)
