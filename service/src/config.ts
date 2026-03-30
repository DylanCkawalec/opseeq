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

  if (process.env.NVIDIA_API_KEY) {
    providers.push({
      name: 'nvidia-nim',
      baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      apiKey: process.env.NVIDIA_API_KEY,
      models: (process.env.NVIDIA_MODELS || 'nvidia/nemotron-3-super-120b-a12b,nvidia/llama-3.3-nemotron-super-49b-v1').split(',').map(s => s.trim()),
      priority: 1,
    });
  }

  if (process.env.OPENAI_API_KEY) {
    providers.push({
      name: 'openai',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      models: (process.env.OPENAI_MODELS || 'gpt-5.4,gpt-5.2,gpt-4.1,gpt-4.1-mini,gpt-4.1-nano,gpt-4o,gpt-4o-mini,o3,o3-mini,o1,gpt-image-1').split(',').map(s => s.trim()),
      priority: 2,
    });
  }

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push({
      name: 'anthropic',
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
      apiKey: process.env.ANTHROPIC_API_KEY,
      models: (process.env.ANTHROPIC_MODELS || 'claude-4-opus,claude-4-sonnet,claude-3.5-sonnet').split(',').map(s => s.trim()),
      priority: 3,
    });
  }

  const ollamaUrl = process.env.OLLAMA_URL || process.env.LOCAL_LLM_BASE_URL;
  if (ollamaUrl) {
    providers.push({
      name: 'ollama',
      baseUrl: ollamaUrl.replace(/\/+$/, ''),
      apiKey: 'ollama',
      models: (process.env.OLLAMA_MODELS || 'gpt-oss:20b').split(',').map(s => s.trim()),
      priority: 10,
    });
  }

  const nimLocalUrl = process.env.NIM_LOCAL_URL;
  if (nimLocalUrl) {
    providers.push({
      name: 'nim-local',
      baseUrl: nimLocalUrl,
      apiKey: process.env.NIM_LOCAL_API_KEY || 'unused',
      models: (process.env.NIM_LOCAL_MODELS || 'nvidia/nemotron-3-super-120b-a12b').split(',').map(s => s.trim()),
      priority: 0,
    });
  }

  return providers.sort((a, b) => a.priority - b.priority);
}

export function loadConfig(): ServiceConfig {
  const apiKeysRaw = process.env.OPSEEQ_API_KEYS || process.env.OPSEEQ_API_KEY || '';
  const apiKeys = apiKeysRaw ? apiKeysRaw.split(',').map(k => k.trim()).filter(Boolean) : [];

  return {
    port: parseInt(process.env.OPSEEQ_PORT || process.env.PORT || '9090', 10),
    host: process.env.OPSEEQ_HOST || '0.0.0.0',
    apiKeys,
    providers: parseProviders(),
    defaultModel: process.env.OPSEEQ_DEFAULT_MODEL || 'nvidia/nemotron-3-super-120b-a12b',
    mcpEnabled: process.env.OPSEEQ_MCP_ENABLED !== 'false',
    serverlessMode: process.env.OPSEEQ_SERVERLESS === 'true',
    idleTimeoutMs: parseInt(process.env.OPSEEQ_IDLE_TIMEOUT_MS || '300000', 10),
    logLevel: process.env.OPSEEQ_LOG_LEVEL || 'info',
  };
}
