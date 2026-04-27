// models/nvidia.ts — NVIDIA NIM (OpenAI-compatible) adapter.
// Reads NVIDIA_API_KEY / NVIDIA_BASE_URL from QGoT/.env via env.ts.
import { env } from "./env.ts";
import type {
  ChatCompletion,
  ChatRequest,
  ChatResponse,
  ProviderId,
} from "./types.ts";

export class NvidiaProvider implements ChatCompletion {
  readonly id: ProviderId = "nvidia";
  readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.baseUrl = env("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1");
    this.apiKey = env("NVIDIA_API_KEY", "");
  }

  isReady(): boolean {
    return Boolean(this.apiKey);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.isReady()) throw new Error("nvidia: NVIDIA_API_KEY missing");
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
      throw new Error(`nvidia: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      id: string;
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    return {
      id: data.id,
      model: req.model,
      provider: "nvidia",
      content: data.choices?.[0]?.message?.content ?? "",
      usage: data.usage,
      latency_ms,
      raw: data,
    };
  }
}
