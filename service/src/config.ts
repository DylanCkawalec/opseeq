export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  priority: number;
}

export interface ServiceConfig {
  port: number;
  host: string;
  apiKeys: string[];
  providers: ProviderConfig[];
  defaultModel: string;
  mcpEnabled: boolean;
  serverlessMode: boolean;
  idleTimeoutMs: number;
  logLevel: string;
}

function parseProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  const ollamaUrl = process.env.OLLAMA_URL || process.env.LOCAL_LLM_BASE_URL;
  if (ollamaUrl) {
    providers.push({
      name: 'ollama',
      baseUrl: ollamaUrl.replace(/\/+$/, ''),
      apiKey: 'ollama',
      models: (process.env.OLLAMA_MODELS || process.env.OLLAMA_MODEL || process.env.LOCAL_LLM_MODEL || 'gpt-oss:20b').split(',').map(s => s.trim()),
      priority: -10,
    });
  }

  const nimLocalUrl = process.env.NIM_LOCAL_URL;
  if (nimLocalUrl) {
    providers.push({
      name: 'nim-local',
      baseUrl: nimLocalUrl,
      apiKey: process.env.NIM_LOCAL_API_KEY || 'unused',
      models: (process.env.NIM_LOCAL_MODELS || 'nvidia/nemotron-3-super-120b-a12b').split(',').map(s => s.trim()),
      priority: -5,
    });
  }

  if (process.env.NVIDIA_API_KEY) {
    providers.push({
      name: 'nvidia-nim',
      baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      apiKey: process.env.NVIDIA_API_KEY,
      models: (process.env.NVIDIA_MODELS || 'nvidia/nemotron-3-super-120b-a12b,nvidia/llama-3.3-nemotron-super-49b-v1').split(',').map(s => s.trim()),
      priority: 10,
    });
  }

  if (process.env.CORE_THINK_AI_API_KEY) {
    providers.push({
      name: 'corethink',
      baseUrl: process.env.CORE_THINK_AI_BASE_URL || 'https://api.corethink.ai/v1',
      apiKey: process.env.CORE_THINK_AI_API_KEY,
      models: (process.env.CORE_THINK_AI_MODELS || 'corethink/corethink-ai-1.0').split(',').map(s => s.trim()),
      priority: 15,
    });
  }

  if (process.env.OPENAI_API_KEY) {
    providers.push({
      name: 'openai',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      models: (process.env.OPENAI_MODELS || 'gpt-5.4,gpt-5.2,gpt-4.1,gpt-4.1-mini,gpt-4.1-nano,gpt-4o,gpt-4o-mini,o3,o3-mini,o1,gpt-image-1').split(',').map(s => s.trim()),
      priority: 20,
    });
  }

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push({
      name: 'anthropic',
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
      apiKey: process.env.ANTHROPIC_API_KEY,
      models: (process.env.ANTHROPIC_MODELS || 'claude-opus-4-6,claude-sonnet-4-6,claude-haiku-4-5-20251001').split(',').map(s => s.trim()),
      priority: 30,
    });
  }

  return providers.sort((a, b) => a.priority - b.priority);
}

export function loadConfig(): ServiceConfig {
  const apiKeysRaw = process.env.OPSEEQ_API_KEYS || process.env.OPSEEQ_API_KEY || '';
  const apiKeys = apiKeysRaw ? apiKeysRaw.split(',').map(k => k.trim()).filter(Boolean) : [];

  const providers = parseProviders();
  const ollamaProvider = providers.find(p => p.name === 'ollama');
  const nimLocalProvider = providers.find(p => p.name === 'nim-local');
  const hasNvidia = providers.some(p => p.name.includes('nim'));
  const fallbackDefaultModel = ollamaProvider?.models[0]
    || process.env.OLLAMA_MODEL
    || process.env.LOCAL_LLM_MODEL
    || nimLocalProvider?.models[0]
    || (hasNvidia ? 'nvidia/nemotron-3-super-120b-a12b' : providers.some(p => p.name === 'anthropic') ? 'claude-sonnet-4-6' : 'gpt-4o');

  return {
    port: parseInt(process.env.OPSEEQ_PORT || process.env.PORT || '9090', 10),
    host: process.env.OPSEEQ_HOST || '0.0.0.0',
    apiKeys,
    providers,
    defaultModel: process.env.OPSEEQ_DEFAULT_MODEL || fallbackDefaultModel,
    mcpEnabled: process.env.OPSEEQ_MCP_ENABLED !== 'false',
    serverlessMode: process.env.OPSEEQ_SERVERLESS === 'true',
    idleTimeoutMs: parseInt(process.env.OPSEEQ_IDLE_TIMEOUT_MS || '300000', 10),
    logLevel: process.env.OPSEEQ_LOG_LEVEL || 'info',
  };
}
