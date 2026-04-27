// models/types.ts — Provider-agnostic chat completion contract.
// Every adapter (nvidia, ollama, openai-compat) implements ChatCompletion.

export type Role = "observer" | "planner" | "coder" | "verifier" | "executor";

export type ProviderId = "nvidia" | "ollama" | "openai" | "kimi" | "qwen" | "mock";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** Free-form provider hints (e.g. {"top_p": 0.9}). */
  extra?: Record<string, unknown>;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  provider: ProviderId;
  content: string;
  usage?: ChatUsage;
  latency_ms: number;
  raw?: unknown;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
}

export interface EmbeddingResponse {
  model: string;
  provider: ProviderId;
  vectors: number[][];
}

export interface ChatCompletion {
  readonly id: ProviderId;
  readonly baseUrl: string;
  /** Returns true when this provider has the credentials it needs. */
  isReady(): boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed?(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export interface RoleBinding {
  role: Role;
  provider: ProviderId;
  model: string;
}
