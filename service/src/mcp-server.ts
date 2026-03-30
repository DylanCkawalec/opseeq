import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import type { ServiceConfig } from './config.js';
import { routeInference, listModels } from './router.js';
import type { Request, Response } from 'express';

// Re-export zod through the SDK since it bundles it
const { object: zObj, string: zStr, number: zNum, boolean: zBool, array: zArr, optional } = z;

export function createMcpServer(config: ServiceConfig): McpServer {
  const server = new McpServer({
    name: 'opseeq',
    version: '1.0.0',
  });

  server.tool(
    'inference',
    'Run LLM inference through the Opseeq gateway. Routes to the best available provider (NVIDIA NIM, OpenAI, Anthropic, Ollama) based on model name.',
    {
      model: zStr().describe('Model identifier (e.g. nvidia/nemotron-3-super-120b-a12b, gpt-4o, claude-4-sonnet)'),
      system_prompt: zStr().optional().describe('System prompt for the model'),
      user_prompt: zStr().describe('User message / prompt'),
      temperature: zNum().min(0).max(2).optional().describe('Sampling temperature (0-2)'),
      max_tokens: zNum().optional().describe('Maximum output tokens'),
    },
    async ({ model, system_prompt, user_prompt, temperature, max_tokens }) => {
      const messages = [];
      if (system_prompt) messages.push({ role: 'system', content: system_prompt });
      messages.push({ role: 'user', content: user_prompt });

      const result = await routeInference({
        model: model || config.defaultModel,
        messages,
        temperature: temperature ?? 0,
        max_tokens,
      }, config);

      const content = result.choices?.[0]?.message?.content || '';
      return {
        content: [
          {
            type: 'text' as const,
            text: content,
          },
        ],
      };
    },
  );

  server.tool(
    'list_models',
    'List all available models across configured inference providers',
    {},
    async () => {
      const models = listModels(config);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(models, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    'health_check',
    'Check health and availability of the Opseeq gateway and its configured providers',
    {},
    async () => {
      const providerStatus = await Promise.all(
        config.providers.map(async (p) => {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            let ok = false;
            if (p.name === 'ollama') {
              const res = await fetch(`${p.baseUrl}/api/tags`, { signal: controller.signal });
              ok = res.ok;
            } else if (p.name === 'anthropic') {
              ok = !!p.apiKey;
            } else {
              const res = await fetch(`${p.baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${p.apiKey}` },
                signal: controller.signal,
              });
              ok = res.ok;
            }
            clearTimeout(timer);
            return { name: p.name, status: ok ? 'healthy' : 'degraded', models: p.models.length };
          } catch {
            return { name: p.name, status: 'unreachable', models: p.models.length };
          }
        }),
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              service: 'opseeq',
              status: 'running',
              mcp: config.mcpEnabled,
              serverless: config.serverlessMode,
              providers: providerStatus,
            }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    'multi_inference',
    'Run the same prompt against multiple models in parallel for comparison or ensemble reasoning',
    {
      models: zArr(zStr()).describe('Array of model identifiers to query'),
      system_prompt: zStr().optional().describe('System prompt'),
      user_prompt: zStr().describe('User message'),
      temperature: zNum().min(0).max(2).optional().describe('Sampling temperature'),
    },
    async ({ models, system_prompt, user_prompt, temperature }) => {
      const results = await Promise.allSettled(
        models.map(async (model) => {
          const messages = [];
          if (system_prompt) messages.push({ role: 'system', content: system_prompt });
          messages.push({ role: 'user', content: user_prompt });

          const result = await routeInference({
            model,
            messages,
            temperature: temperature ?? 0,
          }, config);

          return {
            model,
            content: result.choices?.[0]?.message?.content || '',
            provider: result._opseeq?.provider,
            latencyMs: result._opseeq?.latencyMs,
          };
        }),
      );

      const output = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        return { model: models[i], error: (r.reason as Error).message };
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  return server;
}

const activeSessions = new Map<string, SSEServerTransport>();

export function handleMcpSse(config: ServiceConfig, server: McpServer) {
  return async (req: Request, res: Response) => {
    const transport = new SSEServerTransport('/mcp/messages', res);
    activeSessions.set(transport.sessionId, transport);

    res.on('close', () => {
      activeSessions.delete(transport.sessionId);
    });

    await server.connect(transport);
  };
}

export function handleMcpMessages(config: ServiceConfig, server: McpServer) {
  return async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const transport = activeSessions.get(sessionId);

    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await transport.handlePostMessage(req, res);
  };
}
