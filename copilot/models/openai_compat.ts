// models/openai_compat.ts — OpenAI-compatible adapter.
// Configurable per-flavor (openai, kimi, qwen) with one shared client.
import { env } from "./env.ts";
import type {
  ChatCompletion,
  ChatRequest,
  ChatResponse,
  ProviderId,
} from "./types.ts";

interface Flavor {
  id: ProviderId;
  baseUrlEnv: string;
  apiKeyEnv: string;
  defaultBase: string;
}

const FLAVORS: Record<"openai" | "kimi" | "qwen", Flavor> = {
  openai: {
    id: "openai",
    baseUrlEnv: "OPENAI_BASE_URL",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultBase: "https://api.openai.com/v1",
  },
  kimi: {
    id: "kimi",
    baseUrlEnv: "KIMI_BASE_URL",
    apiKeyEnv: "KIMI_API_KEY",
    defaultBase: "https://api.moonshot.cn/v1",
  },
  qwen: {
    id: "qwen",
    baseUrlEnv: "QWEN_BASE_URL",
    apiKeyEnv: "QWEN_API_KEY",
    defaultBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
};

export class OpenAICompatProvider implements ChatCompletion {
  readonly id: ProviderId;
  readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(flavor: keyof typeof FLAVORS) {
    const f = FLAVORS[flavor];
    this.id = f.id;
    this.baseUrl = env(f.baseUrlEnv, f.defaultBase);
    this.apiKey = env(f.apiKeyEnv, "");
  }

  isReady(): boolean {
    return Boolean(this.apiKey);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.isReady()) throw new Error(`${this.id}: API key missing`);
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const t0 = performance.now();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.max_tokens ?? 2048,
        stream: false,
        ...(req.extra ?? {}),
      }),
    });
    const latency_ms = Math.round(performance.now() - t0);
    if (!res.ok) {
      throw new Error(`${this.id}: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      id: string;
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    return {
      id: data.id,
      model: req.model,
      provider: this.id,
      content: data.choices?.[0]?.message?.content ?? "",
      usage: data.usage,
      latency_ms,
      raw: data,
    };
  }
}
