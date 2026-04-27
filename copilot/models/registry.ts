// models/registry.ts — Role → (provider, model) bindings.
// Single source of truth at runtime. Mirrored to Postgres `model_bindings`.
import { env } from "./env.ts";
import { MockProvider } from "./mock.ts";
import { NvidiaProvider } from "./nvidia.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAICompatProvider } from "./openai_compat.ts";
import type {
  ChatCompletion,
  ChatRequest,
  ChatResponse,
  ProviderId,
  Role,
  RoleBinding,
} from "./types.ts";

export class ModelRegistry {
  private readonly providers: Map<ProviderId, ChatCompletion> = new Map();
  private bindings: Map<Role, RoleBinding> = new Map();

  constructor() {
    // Register every adapter; fallback to mock for tests.
    this.providers.set("nvidia", new NvidiaProvider());
    this.providers.set("ollama", new OllamaProvider());
    this.providers.set("openai", new OpenAICompatProvider("openai"));
    this.providers.set("kimi", new OpenAICompatProvider("kimi"));
    this.providers.set("qwen", new OpenAICompatProvider("qwen"));
    this.providers.set("mock", new MockProvider());

    // Defaults pulled from env, can be overridden via setRole().
    const def = (role: Role, providerEnv: string, modelEnv: string, fallback: string): RoleBinding => {
      const model = env(modelEnv, fallback);
      const provider = env(providerEnv, pickProviderFor(model)) as ProviderId;
      return { role, provider, model };
    };
    this.bindings.set("observer", def("observer", "OPSEEQ_OBSERVER_PROVIDER", "OPSEEQ_OBSERVER_MODEL", "nvidia/nemotron-3-super-120b-a12b"));
    this.bindings.set("planner",  def("planner",  "OPSEEQ_PLANNER_PROVIDER",  "OPSEEQ_PLANNER_MODEL",  "qwen3.5:9b"));
    this.bindings.set("coder",    def("coder",    "OPSEEQ_CODER_PROVIDER",    "OPSEEQ_CODER_MODEL",    "qwen3.5:35b-a3b-coding-mxfp8"));
    this.bindings.set("verifier", def("verifier", "OPSEEQ_VERIFIER_PROVIDER", "OPSEEQ_VERIFIER_MODEL", "gpt-oss:20b"));
    this.bindings.set("executor", def("executor", "OPSEEQ_EXECUTOR_PROVIDER", "OPSEEQ_EXECUTOR_MODEL", "gpt-oss:20b"));
  }

  list(): RoleBinding[] {
    return Array.from(this.bindings.values());
  }

  get(role: Role): RoleBinding {
    const b = this.bindings.get(role);
    if (!b) throw new Error(`no binding for role: ${role}`);
    return b;
  }

  setRole(role: Role, provider: ProviderId, model: string): RoleBinding {
    const b: RoleBinding = { role, provider, model };
    this.bindings.set(role, b);
    return b;
  }

  provider(id: ProviderId): ChatCompletion {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider: ${id}`);
    return p;
  }

  /** Convenience: invoke the configured chat for a role. */
  async invoke(role: Role, req: Omit<ChatRequest, "model"> & { model?: string }): Promise<ChatResponse> {
    const b = this.get(role);
    const provider = this.provider(b.provider);
    if (!provider.isReady()) {
      // Fall back to mock so the workflow can still complete in dev.
      return this.provider("mock").chat({ ...req, model: req.model ?? b.model });
    }
    return provider.chat({ ...req, model: req.model ?? b.model });
  }
}

/** Heuristic: pick a provider id from a model string. */
export function pickProviderFor(model: string): ProviderId {
  if (model.startsWith("nvidia/")) return "nvidia";
  if (/^gpt-(5|4|3)/i.test(model) || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  if (model.startsWith("kimi") || model.startsWith("moonshot")) return "kimi";
  if (model.startsWith("qwen-")) return "qwen"; // hosted Qwen
  // Local Ollama models: gpt-oss, nemotron-3-nano, qwen3.5:*, llama*, mistral*, deepseek*
  return "ollama";
}

// Singleton accessor (kept lazy for tests).
let _instance: ModelRegistry | null = null;
export function registry(): ModelRegistry {
  if (!_instance) _instance = new ModelRegistry();
  return _instance;
}
