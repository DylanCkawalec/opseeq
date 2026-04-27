// models/mock.ts — Deterministic mock used in tests, smoke benches, and fixtures.
import type {
  ChatCompletion,
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderId,
} from "./types.ts";

export class MockProvider implements ChatCompletion {
  readonly id: ProviderId = "mock";
  readonly baseUrl = "mock://local";

  constructor(private readonly canned: (req: ChatRequest) => string = defaultResponder) {}

  isReady(): boolean {
    return true;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const content = this.canned(req);
    return {
      id: `mock-${Date.now()}`,
      model: req.model,
      provider: "mock",
      content,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      latency_ms: 1,
      raw: { mock: true },
    };
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return {
      model: req.model,
      provider: "mock",
      vectors: inputs.map((s) => hashVec(s, 8)),
    };
  }
}

function hashVec(s: string, n: number): number[] {
  const v = new Array(n).fill(0);
  for (let i = 0; i < s.length; i++) v[i % n] += s.charCodeAt(i);
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

function defaultResponder(req: ChatRequest): string {
  const last = req.messages.at(-1)?.content ?? "";
  return `mock(${req.model}) → echo: ${last.slice(0, 120)}`;
}
