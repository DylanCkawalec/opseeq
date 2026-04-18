# Opseeq Replacement Plan

## Goal
Turn Opseeq into the local-first control plane for:

- NemoClaw sandbox control
- app onboarding and deployment
- embedded execution terminals
- guided repo adaptation into Opseeq-connected desktop apps
- future General-Clawd-backed code execution

The objective is not to clone OpenClaw feature-for-feature. The objective is to absorb the parts that matter for Opseeq, then stop depending on OpenClaw as a product reference.

## Product Rule
Keep the current Opseeq interface mostly intact.

- Minimal visual churn
- stronger action buttons
- clearer system state
- more guided sequences
- more control surfaces behind the existing dashboard

## What To Take From OpenClaw

### Keep
- Control-plane thinking from [/Users/dylanckawalec/Desktop/developer/openclaw/README.md:169](/Users/dylanckawalec/Desktop/developer/openclaw/README.md:169)
- WebSocket session/control patterns from [/Users/dylanckawalec/Desktop/developer/openclaw/README.md:186](/Users/dylanckawalec/Desktop/developer/openclaw/README.md:186)
- Guided setup/session flow from [/Users/dylanckawalec/Desktop/developer/openclaw/src/wizard/session.ts:1](/Users/dylanckawalec/Desktop/developer/openclaw/src/wizard/session.ts:1)
- Fast operator status summaries from [/Users/dylanckawalec/Desktop/developer/openclaw/src/commands/status.command.ts:172](/Users/dylanckawalec/Desktop/developer/openclaw/src/commands/status.command.ts:172)
- Doctor-style health checks from [/Users/dylanckawalec/Desktop/developer/openclaw/src/commands/doctor-gateway-health.ts:15](/Users/dylanckawalec/Desktop/developer/openclaw/src/commands/doctor-gateway-health.ts:15)
- Lightweight WebSocket server structure from [/Users/dylanckawalec/Desktop/developer/openclaw/src/canvas-host/server.ts:1](/Users/dylanckawalec/Desktop/developer/openclaw/src/canvas-host/server.ts:1)

### Ignore
- channel sprawl
- multi-messenger product surface
- consumer chat product assumptions
- everything that does not improve local app control, repo onboarding, or execution quality inside Opseeq

## What To Take From General-Clawd

### Keep
- CLI entry shape from [/Users/dylanckawalec/Desktop/developer/General-Clawd/src/main.py:1](/Users/dylanckawalec/Desktop/developer/General-Clawd/src/main.py:1)
- runtime/bootstrap structure from [/Users/dylanckawalec/Desktop/developer/General-Clawd/src/runtime.py:1](/Users/dylanckawalec/Desktop/developer/General-Clawd/src/runtime.py:1)
- execution registry abstraction from [/Users/dylanckawalec/Desktop/developer/General-Clawd/src/execution_registry.py:1](/Users/dylanckawalec/Desktop/developer/General-Clawd/src/execution_registry.py:1)
- tool-pool selection pattern from [/Users/dylanckawalec/Desktop/developer/General-Clawd/src/tool_pool.py:1](/Users/dylanckawalec/Desktop/developer/General-Clawd/src/tool_pool.py:1)
- session persistence concept from [/Users/dylanckawalec/Desktop/developer/General-Clawd/src/session_store.py:1](/Users/dylanckawalec/Desktop/developer/General-Clawd/src/session_store.py:1)

### Current Limitation
General-Clawd is not yet a production execution engine.

- remote modes are placeholders
- REPL is not interactive yet
- it is better treated as a supervised workspace runtime than as the primary operator UI today

## Architecture Direction

### Layer 1: Opseeq Dashboard
This remains the operator surface.

- overview cards
- NemoClaw tab
- app connection wizard
- terminal panel
- doctor panel

Host-local controls belong here or in host-side helpers, not in the containerized inference gateway.

- NemoClaw / OpenShell control
- local app launch
- browser terminal bridging
- iTerm2 / Terminal integration
- local repo writeback for model assignment and onboarding

### Layer 2: Opseeq Control Services
This becomes the source of truth.

- sandbox registry
- gateway health
- app registry
- onboarding state machine
- execution session registry

### Layer 3: Execution Backends
These are replaceable.

- NemoClaw CLI / OpenShell
- embedded PTY terminal bridge
- future General-Clawd worker adapter

## Phased Plan

### Phase 1: Control Plane Foundation
Status: in progress

- NemoClaw dashboard tab
- sandbox presence/status
- default sandbox control
- embedded terminal
- quick-launch app buttons

### Phase 2: Next Best Upgrade
Build a guided `Connect New App` execution pipeline.

Why this is next:

- it is the shortest path from control surface to real value
- it directly supports your repo-to-desktop-app workflow
- it creates the operator sequence General-Clawd will later execute

Deliverables:

- repo onboarding state machine
- action buttons: `Analyze`, `Prepare`, `Build`, `Run`, `Attach`, `Optimize`
- visible step log in dashboard
- per-app action history
- one-click recovery when a step fails

### Phase 3: General-Clawd Adapter
Wrap General-Clawd as a supervised execution worker.

Deliverables:

- `general-clawd-runner` service contract
- workspace-bound session creation
- structured prompt handoff from NemoClaw
- session transcript persistence
- task completion callback into Opseeq

### Phase 4: Doctor + Policy Layer
Bring OpenClaw-style health discipline into Opseeq.

Deliverables:

- gateway doctor
- sandbox doctor
- app doctor
- deployment doctor
- policy and permission review screen

### Phase 5: App Graph + Presence
Move from static cards to live control-plane state.

Deliverables:

- connected-app registry
- running/stopped/building/degraded states
- app capability manifest
- action availability based on runtime state
- live event stream instead of polling-only updates

## Action Model For New Apps
For each connected repo, Opseeq should own this sequence:

1. Analyze repo
2. Detect runtime, ports, start/build commands, desktop wrapper status, MCP needs
3. Prepare `.env`, `.mcp.json`, and app manifest
4. Open embedded terminal session for supervised changes
5. Run build/start validation
6. Attach app to Opseeq registry
7. Offer `Open`, `Doctor`, and `Optimize`

## UI Principle
Simple buttons, deep behavior.

Buttons should stay shallow:

- `Open`
- `Connect`
- `Logs`
- `Analyze`
- `Prepare`
- `Build`
- `Run`
- `Attach`
- `Doctor`
- `Optimize`

The sequencing logic belongs behind those buttons, not in the user’s head.

## Immediate Follow-Up After Terminal Embedding
Build the guided app onboarding pipeline in Phase 2.

That is the highest-leverage next move because it connects:

- repo analysis
- environment preparation
- embedded terminal execution
- General-Clawd future orchestration
- desktop-app readiness
