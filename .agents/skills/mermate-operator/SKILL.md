---
name: mermate-operator
description: Use when operating, monitoring, or controlling the Mermate architecture pipeline through Opseeq. Covers MCP tools, REPL commands, browser automation, and pipeline stage orchestration.
---

# Mermate Operator

Opseeq acts as the stage governor for Mermate's architecture pipeline: idea -> Mermaid -> TLA+ -> TypeScript -> Rust -> desktop binary.

## MCP Tools (programmatic control)

Call these through the Opseeq MCP server at `http://localhost:9090/mcp`:

| Tool | Purpose |
|------|---------|
| `mermate_status` | Copilot health, TLA+, TS, agent availability |
| `mermate_render` | Send source for Mermaid compilation |
| `mermate_generate_tla` | Generate TLA+ from a render run |
| `mermate_generate_ts` | Generate TypeScript from TLA+ |
| `pipeline_orchestrate` | Full multi-stage pipeline with review gates |
| `artifact_verify` | Verify artifacts at each stage |
| `desktop_scan` | Scan ~/Desktop/developer/ for repos |
| `repo_organize` | Clean up a Mermate-built repo (.env, .mcp.json) |

## REPL Commands (operator console)

From `opseeq-core chat`:
- `/mermate` — status, agents, TLA+, TS availability
- `/mermate render <text>` — trigger render pipeline
- `/mermate tla <runId>` — generate TLA+ for a run
- `/mermate ts <runId>` — generate TypeScript for a run
- `/mermate agents` — list agent modes
- `/scan [path]` — scan desktop for repos
- `/verify <path>` — verify binary/app bundle
- `/organize <path>` — clean up repo for Opseeq connection

## Browser Automation (visual verification)

Use `browser_navigate` and `browser_interact` MCP tools to:
1. Navigate to `http://localhost:3333` to visually inspect Mermate UI
2. Verify rendered diagrams appear correctly
3. Check pipeline status in the web interface
4. Take screenshots for artifact verification

## Pipeline Orchestration Workflow

1. Call `pipeline_orchestrate` with source idea
2. Review render output (check diagram quality)
3. Verify TLA+ (SANY validation must pass)
4. Verify TypeScript (validation.success must be true)
5. If Rust stage included, verify binary exists
6. Call `desktop_scan` to confirm repo appeared
7. Call `repo_organize` to ensure .env and .mcp.json exist
8. Call `artifact_verify` for each stage

## Connection

Mermate runs at `http://localhost:3333`. Opseeq connects via `MERMATE_URL` env var.
Docker image: `mermate:v5`
