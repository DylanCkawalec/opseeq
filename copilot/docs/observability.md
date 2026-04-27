# Observability

**Scope:** This document describes artifacts under **`copilot/runs/`** only. The Opseeq **HTTP gateway** (`service/`) uses a different trace model: `~/.opseeq-superior/artifacts/`, temporal JSONL, and an in-memory inference ring buffer — see the **Tracing and observability** section in [`opseeq-architecture.md`](../../opseeq-architecture.md) at the repository root.

## Per-run artifact set (always two levels deep)

```text
runs/<run_id>/
  prompt.txt        # original user prompt (verbatim)
  plan.json         # latest approved plan (or last attempted plan if FAILED)
  plans.ndjson      # every plan iteration (re-plans)
  verify.json       # latest verification verdict
  verify.ndjson     # every verifier verdict
  exec.jsonl        # one record per executed task
  coder.jsonl       # one record per coder dispatch
  observer.jsonl    # heartbeats, drift probes, pause/resume/redirect
  trace.ndjson      # full event stream (RunEvent union)
  log.txt           # human-readable narrative
  state.json        # final RunEnvelope snapshot (always re-written on status change)
```

## Event types

Defined in `obs/schema.ts:RunEvent`:

- `RunStarted`, `RoleStarted`, `RoleEmitted`
- `PlanProposed`, `VerifierVerdict`, `TaskStarted`, `TaskExecuted`
- `DriftDetected`, `PausedByObserver`, `ResumedByObserver`, `RedirectedByObserver`
- `RunFinished`

## Drift

- `obs/drift.ts:CosineDriftScorer` — embeds prompt + candidate; cosine distance.
- Embedding provider: Ollama (`nomic-embed-text` by default); falls back to deterministic hash vector when Ollama is unreachable so the metric is always defined.
- Threshold: `DRIFT_THRESHOLD` env (default `0.42`).
- Each task triggers one `DRIFT_PROBE` observer entry; values exceeding threshold also emit a `DriftDetected` trace event.

## Metrics

`GET /v1/copilot/metrics/summary` aggregates `runs/<id>/state.json`:

- `total_runs`
- `by_status` ({PLANNING, VERIFYING, EXECUTING, PAUSED, DONE, FAILED}: count)
- `drift_max` (max across runs)
GraphQL surfaces the same data via `query { runs { … } }`.

## Source of truth

The current API source of truth is `copilot/runs/<id>/`. The Prisma schema in `copilot/store/` is present for the database-backed contract, but run reads in `api/rest.go`, `api/graph.go`, `api/sse.go`, and `api/metrics.go` are file-backed today.

## Greppability

```bash
grep -lE '"verdict":"REJECTED"' runs/*/verify.json
grep -lE '"DriftDetected"'      runs/*/trace.ndjson
grep -lE '"PausedByObserver"'   runs/*/trace.ndjson
grep -lE 'iteration":[1-9]'     runs/*/plans.ndjson    # re-plans
```
