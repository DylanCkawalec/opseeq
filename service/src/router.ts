import type { ProviderConfig, ServiceConfig } from './config.js';

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 2,
  baseDelay = 500,
): Promise<Response> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && attempt < retries) {
        await new Promise(r => setTimeout(r, baseDelay * 2 ** attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) await new Promise(r => setTimeout(r, baseDelay * 2 ** attempt));
    }
  }
  throw lastErr ?? new Error('fetch failed after retries');
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
  for (const provider of config.providers) {
    if (provider.models.includes(model)) return provider;
  }

  for (const provider of config.providers) {
    if (provider.models.some(m => model.startsWith(m.split('/')[0] + '/'))) return provider;
  }

  if (config.providers.length > 0) return config.providers[0];
  return null;
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

  const data = await res.json() as { message?: { content: string }; eval_count?: number; prompt_eval_count?: number };

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: data.message?.content || '' },
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

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
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
): Promise<ChatCompletionResponse> {
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

export function listModels(config: ServiceConfig): { id: string; provider: string }[] {
  const models: { id: string; provider: string }[] = [];
  for (const provider of config.providers) {
    for (const model of provider.models) {
      models.push({ id: model, provider: provider.name });
    }
  }
  return models;
}
