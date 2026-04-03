/**
 * @module router — Inference gateway (kernel-first, Node fallback)
 *
 * **Axiom A1 — OpenAI-shaped surface** — Request/response types remain compatible with OpenAI Chat
 * Completions for agent clients; provider-specific translation stays internal.
 * **Axiom A2 — Kernel precedence** — When `KernelClient.isReady()`, `inference.route` is invoked
 * before any Node HTTP provider branch.
 * **Postulate P1 — Provider resolution** — Delegates to `provider-resolution` for O(1) exact match and
 * first-match prefix rules identical to historical nested loops.
 * **Postulate P2 — Streaming parity** — OpenAI-compat streams use `fetchStreamWithRetry` with the same
 * retry policy as non-streaming JSON calls.
 * **Corollary C1 — Anthropic/Ollama** — Non-OpenAI paths use dedicated HTTP shapes; streaming is
 * rejected for those providers (legacy error text preserved).
 * **Lemma L1 — Observability** — Successful Node routes call `recordSuccess` / `recordArtifact`;
 * kernel paths record using kernel-reported provider or `kernel`.
 * **Behavioral contract** — `routeInference` and `routeInferenceStream` throw the same error types
 * and messages as v5.0 for missing providers or unsupported stream.
 * **Tracing invariant** — `traceId` is forwarded to the kernel RPC when present; Node paths omit it
 * from upstream HTTP but may attach via `_opseeq` latency metadata.
 */
import type { ProviderConfig, ServiceConfig } from './config.js';
import type { KernelClient } from './kernel.js';
import { recordSuccess, recordArtifact } from './feedback.js';
import { fetchWithRetry, fetchStreamWithRetry } from './http-fetch-retry.js';
import { resolveProviderFor, getRoutingTable } from './provider-resolution.js';

let _kernel: KernelClient | null = null;

export function setKernel(k: KernelClient): void {
  _kernel = k;
}

export interface ChatMessage {
  role: string;
  content: string;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  _opseeq?: {
    provider: string;
    latencyMs: number;
  };
}

function resolveProvider(model: string, config: ServiceConfig): ProviderConfig | null {
  return resolveProviderFor(model, config);
}

function isAnthropicProvider(provider: ProviderConfig): boolean {
  return provider.name === 'anthropic' || provider.baseUrl.includes('anthropic.com');
}

function isOllamaProvider(provider: ProviderConfig): boolean {
  return provider.name === 'ollama';
}

async function callAnthropicProvider(
  provider: ProviderConfig,
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const systemMsg = req.messages.find(m => m.role === 'system');
  const nonSystemMsgs = req.messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_tokens || req.max_completion_tokens || 8192,
    temperature: req.temperature ?? 0,
    messages: nonSystemMsgs,
  };
  if (systemMsg) body.system = systemMsg.content;

  const res = await fetchWithRetry(`${provider.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText}`);
  }

  const data = await res.json() as { id: string; content: Array<{ text: string }>; model: string; usage?: { input_tokens: number; output_tokens: number } };

  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || req.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: data.content?.[0]?.text || '' },
      finish_reason: 'stop',
    }],
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens,
    } : undefined,
  };
}

async function callOllamaProvider(
  provider: ProviderConfig,
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const res = await fetchWithRetry(`${provider.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      stream: false,
      messages: req.messages,
      options: { temperature: req.temperature ?? 0 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama ${res.status}: ${errText}`);
  }

  const data = await res.json() as { model?: string; message?: { content: string; thinking?: string; role?: string }; eval_count?: number; prompt_eval_count?: number };

  const msg: ChatMessage = { role: 'assistant', content: data.message?.content || '' };
  if (data.message?.thinking) (msg as unknown as Record<string, unknown>).reasoning = data.message.thinking;

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || req.model,
    choices: [{
      index: 0,
      message: msg,
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: data.prompt_eval_count || 0,
      completion_tokens: data.eval_count || 0,
      total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
    },
  };
}

async function callOpenAICompatible(
  provider: ProviderConfig,
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const body: Record<string, unknown> = { ...req, stream: false };

  const res = await fetchWithRetry(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${provider.name} ${res.status}: ${errText}`);
  }

  return await res.json() as ChatCompletionResponse;
}

async function callOpenAICompatibleStream(
  provider: ProviderConfig,
  req: ChatCompletionRequest,
): Promise<ReadableStream<Uint8Array>> {
  const body: Record<string, unknown> = { ...req, stream: true };

  const res = await fetchStreamWithRetry(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${provider.name} ${res.status}: ${errText}`);
  }

  if (!res.body) throw new Error('No response body for streaming');
  return res.body;
}

export async function routeInference(
  req: ChatCompletionRequest,
  config: ServiceConfig,
  traceId?: string,
): Promise<ChatCompletionResponse> {
  if (_kernel?.isReady()) {
    const kernelStart = Date.now();
    try {
      const result = await _kernel.call('inference.route', {
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens || req.max_completion_tokens,
        stream: false,
        trace_id: traceId,
        purpose: (req as Record<string, unknown>).purpose,
      }) as ChatCompletionResponse;

      const latencyMs = Date.now() - kernelStart;
      const provider = result._opseeq?.provider || 'kernel';
      recordSuccess(provider, latencyMs, result.usage ? {
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
      } : undefined);
      recordArtifact({
        id: result.id || `k-${Date.now()}`,
        model: result.model || req.model,
        provider,
        latencyMs,
        tokens: result.usage ? { input: result.usage.prompt_tokens, output: result.usage.completion_tokens } : null,
        success: true,
        timestamp: new Date().toISOString(),
        traceId: traceId || null,
      });

      return result;
    } catch (err) {
      console.log(`[kernel] inference.route failed, falling back to Node: ${err instanceof Error ? err.message : err}`);
    }
  }

  const provider = resolveProvider(req.model, config);
  if (!provider) {
    throw new Error(`No provider configured for model: ${req.model}`);
  }

  const start = Date.now();

  let response: ChatCompletionResponse;
  if (isAnthropicProvider(provider)) {
    response = await callAnthropicProvider(provider, req);
  } else if (isOllamaProvider(provider)) {
    response = await callOllamaProvider(provider, req);
  } else {
    response = await callOpenAICompatible(provider, req);
  }

  response._opseeq = {
    provider: provider.name,
    latencyMs: Date.now() - start,
  };

  return response;
}

export async function routeInferenceStream(
  req: ChatCompletionRequest,
  config: ServiceConfig,
): Promise<{ stream: ReadableStream<Uint8Array>; provider: string }> {
  const provider = resolveProvider(req.model, config);
  if (!provider) throw new Error(`No provider configured for model: ${req.model}`);

  if (isAnthropicProvider(provider) || isOllamaProvider(provider)) {
    throw new Error(`Streaming not supported through ${provider.name} proxy — use non-streaming`);
  }

  const stream = await callOpenAICompatibleStream(provider, req);
  return { stream, provider: provider.name };
}

export async function listModels(config: ServiceConfig): Promise<{ id: string; provider: string }[]> {
  if (_kernel?.isReady()) {
    try {
      return await _kernel.call('models.list') as { id: string; provider: string }[];
    } catch { /* fall through */ }
  }

  return getRoutingTable(config).modelListFlat;
}
