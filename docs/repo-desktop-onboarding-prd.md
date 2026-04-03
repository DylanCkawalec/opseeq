# Repo Desktop Onboarding PRD

## Problem

Opseeq currently presents a `Connect a New App` action in the dashboard, but the implementation is only a frontend text generator. It does not:

- analyze the referenced repository
- write `.env` and `.mcp.json`
- determine whether the repo is web-only or desktop-capable
- register launcher metadata for one-click open/start
- provide a terminal bridge for supervised agentic edits
- integrate a secondary code assistant runtime such as General-Clawd

This creates a mismatch between the dashboard promise and actual system behavior.

## Current Findings

### Opseeq

- Backend already had partial repo setup logic in `repo_organize`, but it only existed as an MCP tool.
- Dashboard `Generate` was not calling the backend at all.
- `Open Mermate` and `Open Synth` were static links, not launcher actions.
- There is no persistent connected-app registry or launcher manifest.
- There is no PTY/WebSocket terminal layer in the dashboard.

### Lucidity

- Lucidity is a local Node-served SPA, not a packaged desktop application.
- Current `.env` only contains `OPENAI_BASE_URL` and `OPSEEQ_URL`.
- `.mcp.json` was added manually and correctly points to Opseeq.
- A realistic onboarding outcome for Lucidity today is: `Opseeq-ready web app`, not `desktop-ready app`.

### General-Clawd

- The checked-out `General-Clawd` repository is still scaffold-level.
- The Python layer is primarily inventory/manifest logic.
- The Rust layer is explicitly a compatibility-first foundation, not a finished interactive harness runtime.
- Conclusion: General-Clawd is not yet a reliable drop-in execution backend for Opseeq. It should be integrated as a managed experimental worker, not treated as production control-plane infrastructure.

## Goals

1. Make `Connect a New App` actually analyze and prepare a repo.
2. Distinguish between:
   - Opseeq-connected repo
   - one-click launchable local app
   - packaged desktop app
3. Create a safe path toward a two-pane supervision model:
   - Opseeq reasoning/orchestration pane
   - terminal/worker pane backed by a PTY session
4. Add a pluggable worker interface so General-Clawd can later be used as one execution engine.

## Non-Goals For Phase 1

- Automatic desktop packaging for arbitrary repos.
- Blind autonomous code changes across unknown repos.
- Treating General-Clawd as trusted production infrastructure.
- Starting every app without an explicit launcher contract.

## Solution Options

### Option 1: Minimal

- Replace fake dashboard generator with backend repo connect API.
- Write `.env` and `.mcp.json`.
- Return analysis summary to the UI.
- Add backend `open` action for known surfaces.

Pros:
- Fast.
- Low risk.
- Immediately fixes the broken dashboard promise.

Cons:
- No persistent connected-app registry.
- No terminal bridge.
- No automatic desktop packaging.

### Option 2: Medium

- Implement Option 1.
- Add `~/.opseeq/apps.json` registry.
- Store per-app metadata:
  - repo path
  - repo kind
  - start command
  - health URL
  - app URL
  - desktop wrapper status
  - optional launcher command
- Add a launcher service that can start/open registered apps.
- Add a PTY/WebSocket terminal panel in the dashboard.

Pros:
- Matches the product direction.
- Gives a clean contract for future app onboarding.
- Supports human-in-the-loop supervision.

Cons:
- Requires backend session/process management.
- More surface area for failure and cleanup.

### Option 3: Comprehensive

- Implement Option 2.
- Add repo transformation pipeline:
  - analyze repo
  - recommend wrapper strategy (Electron/Tauri/Wails)
  - generate launcher metadata
  - optionally scaffold desktop wrapper
  - build image/tag (`{repo}:v5`)
  - register with dashboard
- Add worker engine abstraction:
  - Opseeq native executor
  - General-Clawd executor
  - future NemoClaw/OpenClaw executor
- Add approval checkpoints before edits/build/deploy.

Pros:
- Full platform story.

Cons:
- Substantially larger system.
- Higher risk of breaking repos without explicit constraints.
- Requires a formal launcher/build manifest and safety policy.

## Recommended Direction

Choose **Option 2** as the target architecture, with **Option 1** implemented first.

Reasoning:

- Option 1 fixes the broken behavior immediately.
- Option 2 is the smallest architecture that can honestly support “connect repo, open app, supervise terminal, optimize safely”.
- Option 3 should only happen after the registry, launcher, and PTY layers are stable.

## Target Architecture

### 1. Repo Onboarding Service

Input: absolute repo path.

Outputs:

- repo analysis
- `.env` merge
- `.mcp.json` merge
- detected runtime metadata
- launcher recommendation
- desktop-wrapper recommendation

### 2. Connected App Registry

Store outside app repos in `~/.opseeq/apps.json`.

Each app record should include:

- `id`
- `name`
- `repoPath`
- `kinds`
- `startCommand`
- `healthUrl`
- `openUrl`
- `desktopWrapper`
- `launcherCommand`
- `dockerImage`
- `status`

### 3. Launcher Layer

The dashboard should never rely on raw `href` links for managed apps.

Instead:

- dashboard calls Opseeq backend
- backend optionally starts the app via configured launcher command
- backend probes health URL
- backend opens app URL
- dashboard reports success/failure state

### 4. Terminal Bridge

Use PTY sessions, not direct command text injection.

Requirements:

- one PTY per managed worker session
- WebSocket stream to browser
- explicit working directory
- bounded allowed commands
- approval gate for destructive actions
- transcript persistence

### 5. Worker Engine Abstraction

Define a worker interface:

- `prepare(context)`
- `plan(task)`
- `execute(task, ptySession)`
- `awaitCompletion()`
- `emitArtifacts()`

Initial engines:

- `opseeq-native`
- `general-clawd-experimental`

### 6. General-Clawd Integration Rules

General-Clawd should not directly mutate repos from a hidden background loop.

Instead:

- Opseeq builds task context
- Opseeq sends task to the worker engine
- worker operates inside a dedicated PTY session
- dashboard shows live terminal output
- Opseeq reviews result before follow-up steps

## Phase Plan

### Phase 1

- Real repo connect API
- `.env` and `.mcp.json` generation
- dashboard integration
- backend-driven open actions for built-in apps

### Phase 2

- persistent app registry
- launcher manifest schema
- health/open/start workflow
- dashboard connected-app cards sourced from registry

### Phase 3

- PTY/WebSocket terminal panel
- human approval checkpoints
- session transcript storage

### Phase 4

- experimental General-Clawd worker adapter
- prompt handoff from Opseeq orchestrator to worker
- completion detection and review loop

### Phase 5

- desktop wrapper recommendation/scaffolding
- image build/tag flow
- deployment registration for local hosted apps

## Risks

- Arbitrary repos do not share one universal desktop packaging path.
- Auto-writing secrets into repo `.env` files expands secret footprint.
- Blind launcher inference is unreliable without explicit metadata.
- PTY exposure without policy controls becomes a security and UX problem.
- General-Clawd is not mature enough to be the only execution path.

## Immediate Implementation Standard

A repo may be labeled:

- `Opseeq-connected` only if `.env` and `.mcp.json` are valid.
- `launchable` only if a start command and open URL are known.
- `desktop-ready` only if a desktop wrapper exists or has been scaffolded.

Anything else is misleading.
