# Model configuration system

## Single source of truth

`models/registry.ts` is the runtime registry. It is mirrored to Postgres
(`model_bindings` + `model_bindings_audit`) so changes survive restarts and
leave an audit trail.

## Adapter shape

Every provider implements:

```ts
interface ChatCompletion {
  id: ProviderId;        // "nvidia" | "ollama" | "openai" | "kimi" | "qwen" | "mock"
  baseUrl: string;
  isReady(): boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed?(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}
```

## Providers

| ID | File | Source of credentials | Notes |
|---|---|---|---|
| `nvidia` | `models/nvidia.ts` | `QGoT/.env` (`NVIDIA_API_KEY`, `NVIDIA_BASE_URL`) | OpenAI-compatible NIM endpoint |
| `ollama` | `models/ollama.ts` | `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`) | Chat + embeddings |
| `openai` | `models/openai_compat.ts` | `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Used for GPT-5.x |
| `kimi`   | `models/openai_compat.ts` | `KIMI_API_KEY`, `KIMI_BASE_URL` | Moonshot |
| `qwen`   | `models/openai_compat.ts` | `QWEN_API_KEY`, `QWEN_BASE_URL` | DashScope |
| `mock`   | `models/mock.ts` | none | Deterministic; dev/QC fallback |

## Provider selection

`pickProviderFor(model)` is a small heuristic:

- `nvidia/...` → nvidia
- `gpt-5*`, `gpt-4*`, `o1*`, `o3*` → openai
- `kimi*`, `moonshot*` → kimi
- `qwen-*` (hosted DashScope) → qwen
- everything else → ollama (local Ollama tags like `qwen3.5:9b`, `gpt-oss:20b`, `nemotron-3-nano:4b`)
You can pin a provider explicitly via the GraphQL `setRoleModel` mutation or
`PUT /v1/copilot/models`.

## Per-role overrides (env)

| Role | Env var |
|---|---|
| Observer | `OPSEEQ_OBSERVER_MODEL`, `OPSEEQ_OBSERVER_PROVIDER` |
| Planner  | `OPSEEQ_PLANNER_MODEL`,  `OPSEEQ_PLANNER_PROVIDER`  |
| Coder    | `OPSEEQ_CODER_MODEL`,    `OPSEEQ_CODER_PROVIDER`    |
| Verifier | `OPSEEQ_VERIFIER_MODEL`, `OPSEEQ_VERIFIER_PROVIDER` |
| Executor | `OPSEEQ_EXECUTOR_MODEL`, `OPSEEQ_EXECUTOR_PROVIDER` |

## Failure semantics

If a configured provider is missing credentials (`isReady() === false`), the
registry transparently falls back to the `mock` provider so the workflow can
still complete in dev. A `provider_audit` field is recorded in the run
envelope for every adapter dispatch (see `obs/schema.ts:RunEvent.RoleEmitted`).
