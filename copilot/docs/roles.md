# Agent role definitions

## 1. Expert Observer

- **Mission:** monitor every workflow event; track browser, logs, traces, decisions, drift; can pause/resume/redirect; can ask the Verifier when in doubt.
- **Inputs:** event bus from `RunWriter` (every role event), original prompt.
- **Outputs:** `runs/<id>/observer.jsonl` (HEARTBEAT, DRIFT_PROBE, PLAN_SEEN, VERDICT_SEEN, PAUSE/RESUME/REDIRECT).
- **Drift score:** cosine distance between embeddings of *original prompt* and *current task output*. Threshold from `DRIFT_THRESHOLD` (default `0.42`).

## 2. Expert Planner

- **Mission:** convert any prompt into an ordered task DAG; uses rule-based memory in `agents/planner_memory.json` to improve over time.
- **Inputs:** prompt, optional verifier feedback.
- **Outputs:** `runs/<id>/plan.json` (Plan with iteration counter, summary, tasks with `id|kind|description|depends_on`).
- **Memory update:** when re-planning after rejection, the verifier feedback is appended as a new rule.

## 3. Expert Coder

- **Mission:** implement a single PlannedTask. Diffs in ```diff fences, shell in```bash fences, otherwise plain text. Concludes with `DONE` or `BLOCKED: <reason>`.
- **Inputs:** prompt, task, dependency outputs.
- **Outputs:** `runs/<id>/coder.jsonl` (one entry per task with `task_id`, `diff?`, `output`, `model`).

## 4. Expert Verifier

- **Mission:** decides `APPROVED | REJECTED | NEEDS_REVISION` for a `(prompt, plan)` pair.
- **Inputs:** prompt + plan.
- **Outputs:** `runs/<id>/verify.json` (and an audit ledger in `verify.ndjson`).
- **Loopback:** REJECTED/NEEDS_REVISION returns the workflow to PLANNING with the reason as feedback.

## 5. Expert Executor

- **Mission:** runs only verified plans; topologically orders tasks; passes context from prior outputs; halts on first failure.
- **Inputs:** approved plan + RunWriter.
- **Outputs:** `runs/<id>/exec.jsonl` (TaskRun records).

## Role → model defaults

| Role | Default | Override env |
|---|---|---|
| Observer | `nvidia/nemotron-3-super-120b-a12b` | `OPSEEQ_OBSERVER_MODEL` |
| Planner  | `qwen3.5:9b` | `OPSEEQ_PLANNER_MODEL` |
| Coder    | `qwen3.5:35b-a3b-coding-mxfp8` | `OPSEEQ_CODER_MODEL` |
| Verifier | `gpt-oss:20b` | `OPSEEQ_VERIFIER_MODEL` |
| Executor | `gpt-oss:20b` | `OPSEEQ_EXECUTOR_MODEL` |

Each role independently dispatches via `models/registry.ts`. Bindings are runtime-mutable through GraphQL `setRoleModel` and persisted in `model_bindings` (with audit log).
