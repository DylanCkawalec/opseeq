/**
 * @module provider-resolution — Static provider index + optional adaptive overlay
 *
 * **Axiom A1 — Deterministic routing** — Static resolution order matches legacy `router.ts`:
 * exact model id, then first matching prefix rule in `(provider order × model order)`, then fallback
 * to `config.providers[0]`.
 * **Axiom A2 — First-wins duplicates** — When the same model id appears in multiple providers,
 * the earlier provider in `config.providers` owns `modelExact` (legacy `includes` scan behavior).
 * **Postulate P1 — O(1) exact lookup** — `modelExact: Map<string, ProviderConfig>` replaces linear
 * scans for hot-path resolution.
 * **Postulate P2 — Prefix rules** — `prefixRules` lists `{ prefix, provider }` in legacy order; the
 * first `model.startsWith(prefix)` match wins.
 * **Postulate P3 — Model listing** — `modelListFlat` precomputes the nested-loop `listModels` output
 * when the kernel does not serve `models.list`.
 * **Corollary C1 — Adaptive overlay (opt-in)** — When `OPSEEQ_ADAPTIVE_ROUTING=true`, `getBestProvider()`
 * may replace the static pick only if that provider can serve the model (`canProviderServeModel`).
 * **Corollary C2 — Embeddings** — `getEmbeddingProvider` returns the first non-ollama, non-anthropic
 * provider (OpenAI-compat embeddings), preserving legacy selection order.
 * **Lemma L1 — Cache identity** — `WeakMap<ServiceConfig, ProviderRoutingTable>` keys off the
 * `loadConfig()` object; config reload creates a new table naturally.
 * **Behavioral contract** — `resolveProviderFor` returns `null` iff no providers exist.
 * **Tracing invariant** — Adaptive decisions log only through router metrics (`recordSuccess`); this
 * module has no I/O.
 */
import type { ProviderConfig, ServiceConfig } from './config.js';
import { getBestProvider } from './feedback.js';

export interface ProviderRoutingTable {
  modelExact: Map<string, ProviderConfig>;
  /** First match wins (legacy nested-loop order). */
  prefixRules: Array<{ prefix: string; provider: ProviderConfig }>;
  fallback: ProviderConfig | null;
  providersByName: Map<string, ProviderConfig>;
  modelListFlat: Array<{ id: string; provider: string }>;
}

const routingTableCache = new WeakMap<ServiceConfig, ProviderRoutingTable>();

function canProviderServeModel(provider: ProviderConfig, model: string): boolean {
  if (provider.models.includes(model)) return true;
  return provider.models.some(m => model.startsWith(m.split('/')[0] + '/'));
}

export function buildRoutingTable(config: ServiceConfig): ProviderRoutingTable {
  const modelExact = new Map<string, ProviderConfig>();
  const prefixRules: Array<{ prefix: string; provider: ProviderConfig }> = [];
  const modelListFlat: Array<{ id: string; provider: string }> = [];

  for (const provider of config.providers) {
    for (const m of provider.models) {
      modelListFlat.push({ id: m, provider: provider.name });
      if (!modelExact.has(m)) modelExact.set(m, provider);
      prefixRules.push({ prefix: m.split('/')[0] + '/', provider });
    }
  }

  const fallback = config.providers.length > 0 ? config.providers[0] : null;
  const providersByName = new Map(config.providers.map(p => [p.name, p]));

  return { modelExact, prefixRules, fallback, providersByName, modelListFlat };
}

export function getRoutingTable(config: ServiceConfig): ProviderRoutingTable {
  let t = routingTableCache.get(config);
  if (!t) {
    t = buildRoutingTable(config);
    routingTableCache.set(config, t);
  }
  return t;
}

export function resolveProviderFor(model: string, config: ServiceConfig): ProviderConfig | null {
  const t = getRoutingTable(config);
  let p: ProviderConfig | null = t.modelExact.get(model) ?? null;
  if (!p) {
    for (const rule of t.prefixRules) {
      if (model.startsWith(rule.prefix)) {
        p = rule.provider;
        break;
      }
    }
  }
  if (!p) p = t.fallback;

  if (process.env.OPSEEQ_ADAPTIVE_ROUTING === 'true' && p) {
    const bestName = getBestProvider();
    if (bestName) {
      const bp = t.providersByName.get(bestName);
      if (bp && canProviderServeModel(bp, model)) return bp;
    }
  }
  return p;
}

// ── Nemotron Small/Large Routing ──────────────────────────────────────

/** Virtual model aliases for Nemotron tier selection. */
const NEMOTRON_ALIASES: Record<string, { model: string; preferProvider: string }> = {
  'nemotron:small':  { model: 'nemotron-3-nano:4b',               preferProvider: 'ollama' },
  'nemotron:fast':   { model: 'nemotron-3-nano:4b',               preferProvider: 'ollama' },
  'nemotron:local':  { model: 'nemotron-3-nano:4b',               preferProvider: 'ollama' },
  'nemotron:large':  { model: 'nvidia/nemotron-3-super-120b-a12b', preferProvider: 'nvidia-nim' },
  'nemotron:cloud':  { model: 'nvidia/nemotron-3-super-120b-a12b', preferProvider: 'nvidia-nim' },
  'nemotron:auto':   { model: '',                                  preferProvider: '' }, // resolved dynamically
};

/** Estimate prompt complexity (0-1) for auto-routing between small/large Nemotron. */
export function estimateComplexity(prompt: string): number {
  let score = 0;
  const len = prompt.length;
  // Length factor: >2000 chars starts pushing toward large
  score += Math.min(0.3, len / 8000);
  // Multi-turn / system prompt indicators
  if (prompt.includes('```')) score += 0.15;
  if (prompt.includes('function') || prompt.includes('class ') || prompt.includes('import ')) score += 0.1;
  if (prompt.includes('analyze') || prompt.includes('compare') || prompt.includes('explain in detail')) score += 0.15;
  // Reasoning indicators
  if (prompt.includes('step by step') || prompt.includes('chain of thought') || prompt.includes('reason')) score += 0.2;
  if (prompt.includes('architecture') || prompt.includes('design') || prompt.includes('optimize')) score += 0.1;
  return Math.min(1, score);
}

/** Resolve Nemotron virtual aliases (nemotron:small, nemotron:large, nemotron:auto). */
export function resolveNemotronAlias(model: string, config: ServiceConfig, prompt?: string): { model: string; provider: ProviderConfig | null } {
  const alias = NEMOTRON_ALIASES[model];
  if (!alias) return { model, provider: null };

  const t = getRoutingTable(config);

  if (model === 'nemotron:auto') {
    const complexity = estimateComplexity(prompt || '');
    const threshold = parseFloat(process.env.NEMOTRON_AUTO_THRESHOLD || '0.5');
    const target = complexity >= threshold
      ? NEMOTRON_ALIASES['nemotron:large']
      : NEMOTRON_ALIASES['nemotron:small'];
    const p = t.providersByName.get(target.preferProvider) ?? null;
    return { model: target.model, provider: p };
  }

  const p = t.providersByName.get(alias.preferProvider) ?? null;
  return { model: alias.model, provider: p };
}

// ── Role-Based Model Aliases ─────────────────────────────────────────

/** Virtual model aliases for explicit task-role routing. */
const ROLE_ALIASES: Record<string, { model: string; preferProvider: string }> = {
  'role:code':      { model: 'qwen3-coder:30b',                   preferProvider: 'ollama' },
  'role:reason':    { model: 'deepseek-r1:32b',                   preferProvider: 'ollama' },
  'role:utility':   { model: 'nemotron-3-nano:4b',                preferProvider: 'ollama' },
  'role:reference': { model: 'nvidia/nemotron-3-super-120b-a12b', preferProvider: 'nvidia-nim' },
};

/** Resolve role-based virtual aliases (role:code, role:reason, etc.). */
export function resolveRoleAlias(model: string, config: ServiceConfig): { model: string; provider: ProviderConfig | null } | null {
  const alias = ROLE_ALIASES[model];
  if (!alias) return null;
  const t = getRoutingTable(config);
  const p = t.providersByName.get(alias.preferProvider) ?? null;
  return { model: alias.model, provider: p };
}

export { ROLE_ALIASES };

/** First non-ollama, non-anthropic provider (OpenAI-compat embeddings), legacy order. */
export function getEmbeddingProvider(config: ServiceConfig): ProviderConfig | undefined {
  return config.providers.find(p => p.name !== 'ollama' && p.name !== 'anthropic');
}
