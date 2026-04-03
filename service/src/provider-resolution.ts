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

/** First non-ollama, non-anthropic provider (OpenAI-compat embeddings), legacy order. */
export function getEmbeddingProvider(config: ServiceConfig): ProviderConfig | undefined {
  return config.providers.find(p => p.name !== 'ollama' && p.name !== 'anthropic');
}
