# Slim down PI agent session memory (~100 MB overhead)

A full `createSession("pi")` costs ~117 MB per VM (vs 17 MB for an empty V8 isolate). The ~100 MB delta is the PI coding agent dependency tree loaded into the V8 isolate.

## Unnecessary deps loaded in headless SDK mode

From `@mariozechner/pi-coding-agent` direct deps:
- `@mariozechner/pi-tui` — terminal UI (SDK adapter skips the CLI, shouldn't need TUI)
- `@silvia-odwyer/photon-node` — image processing
- `cli-highlight`, `chalk`, `strip-ansi` — terminal formatting
- `marked` — markdown rendering

From `@mariozechner/pi-ai` deps:
- `@aws-sdk/client-bedrock-runtime` — Bedrock provider (not needed if using Anthropic direct)
- `@google/genai` — Google provider
- `@mistralai/mistralai` — Mistral provider
- `openai` — OpenAI provider
- `proxy-agent` — proxy support (VM networking doesn't use proxies)

## Options

1. **Ask PI maintainer for a headless/slim entrypoint** that strips TUI, image processing, and unused LLM providers. Could save ~40-60 MB.
2. **Lazy-load LLM providers** so only `@anthropic-ai/sdk` loads at startup, others on demand when a different provider is configured.
3. **Share V8 compiled module cache** across isolates in the secure-exec Rust runtime so the same bytecode isn't duplicated per session. This is a secure-exec optimization.
4. **Single-isolate adapter** — if the pi-acp adapter could run in the same V8 isolate as the agent (instead of the agent spawning a child process), save the base 17 MB per extra isolate.

## Benchmark reference

Measured on i7-12700KF, Node v24.13.0:
- Empty V8 isolate: 17 MB
- PI session (createSession): 117 MB incremental
- Delta: ~100 MB for dependency tree
