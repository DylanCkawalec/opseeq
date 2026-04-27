// models/ollama.ts — Local Ollama adapter (chat + embeddings).
import { env } from "./env.ts";
import type {
  ChatCompletion,
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderId,
} from "./types.ts";

export class OllamaProvider implements ChatCompletion {
  readonly id: ProviderId = "ollama";
  readonly baseUrl: string;

  constructor() {
    this.baseUrl = env("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
  }

  isReady(): boolean {
    return true; // Local server presence is checked at request time.
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/api/chat`;
    const t0 = performance.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: false,
        options: {
          temperature: req.temperature ?? 0.2,
          num_predict: req.max_tokens ?? 2048,
          ...(req.extra ?? {}),
        },
      }),
    });
    const latency_ms = Math.round(performance.now() - t0);
    if (!res.ok) {
      throw new Error(`ollama: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      message?: { content: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };
    const completion_tokens = data.eval_count ?? 0;
    const prompt_tokens = data.prompt_eval_count ?? 0;
    return {
      id: `ollama-${Date.now()}`,
      model: req.model,
      provider: "ollama",
      content: data.message?.content ?? "",
      usage: {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
      },
      latency_ms,
      raw: data,
    };
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const url = `${this.baseUrl}/api/embed`;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: req.model, input: inputs }),
    });
    if (!res.ok) {
      throw new Error(`ollama embed: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    return {
      model: req.model,
      provider: "ollama",
      vectors: data.embeddings ?? [],
    };
  }
}
