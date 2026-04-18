---
name: synth-operator
description: Use when operating, monitoring, or controlling the Synth prediction market trading desk through Opseeq. Covers MCP tools, REPL commands, browser automation, and trade management.
---

# Synth Operator

Opseeq acts as the intelligent operator for the Synth prediction market desk, managing predictions, portfolio, risk, and trade approvals.

## MCP Tools (programmatic control)

Call these through the Opseeq MCP server at `http://localhost:9090/mcp`:

| Tool | Purpose |
|------|---------|
| `synth_status` | Deep health: simulation mode, approval gate, AI availability |
| `synth_predict` | Generate a market prediction |
| `synth_predictions` | List recent predictions |
| `synth_markets` | Search available markets |
| `synth_portfolio` | Portfolio summary |

## REPL Commands (operator console)

From `opseeq-core chat`:
- `/synth` — deep status (simulation, approval, AI, predictions)
- `/synth predict <question>` — generate prediction
- `/synth history` — recent predictions
- `/synth markets <query>` — search markets

## Browser Automation (visual verification)

Use `browser_navigate` and `browser_interact` MCP tools to:
1. Navigate to `http://localhost:8420` to inspect the Synth trading UI
2. Review prediction cards and confidence scores visually
3. Check portfolio positions in the web interface
4. Verify approval gate status in the UI
5. Take screenshots for audit records

## Trade Workflow

1. Call `synth_markets` to find relevant markets
2. Call `synth_predict` with market question
3. Review prediction thesis, confidence, suggested execution
4. If `REQUIRE_APPROVAL=true`, trade enters approval queue
5. Operator approves via Synth admin API or MCP tool
6. Monitor portfolio via `synth_portfolio`

## Risk Management

- `SIMULATION_MODE=true` — all trades are paper (safe)
- `MAX_POSITION_USDC` — max position size
- `MAX_DAILY_LOSS_USDC` — daily loss limit
- `REQUIRE_APPROVAL=true` — human-in-the-loop gate

## Connection

Synth runs at `http://localhost:8420`. Opseeq connects via `SYNTHESIS_TRADE_URL` env var.
Docker image: `synth:v5`
