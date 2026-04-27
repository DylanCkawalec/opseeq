/**
 * @module feedback — Self-improvement loop + TraceRank observability
 *
 * **Axiom A1 — EMA stability** — Latency and success-rate EMAs use fixed `EMA_ALPHA` for bounded
 * memory and smooth updates across requests.
 * **Axiom A2 — Tau gates** — `TAU.explore|production|deploy` thresholds are environment-overridable
 * but default to whitepaper HPC-GoT values.
 * **Postulate P1 — TraceRank concentration** — C(z) = 1 − H(z)/log(d) summarizes provider entropy;
 * exposed in `getFeedbackSnapshot` for dashboards.
 * **Postulate P2 — Adaptive ranking** — `getAdaptiveRanking` orders providers by `adaptiveScore`;
 * `getBestProvider` returns null unless the leader is separated and has minimum sample size.
 * **Corollary C1 — Optional routing** — `provider-resolution` may consult `getBestProvider` only when
 * `OPSEEQ_ADAPTIVE_ROUTING=true` and the leader can serve the requested model.
 * **Lemma L1 — Artifact ring** — Recent inference artifacts are stored in a fixed-size ring buffer
 * (`ARTIFACT_RING_SIZE`) for `/api/artifacts` and status; entries are appended from successful
 * **non-streaming** `routeInference` (kernel and Node provider paths). Streaming chat completions
 * do not enqueue artifacts.
 * **Behavioral contract** — `recordSuccess` / `recordFailure` are side-effecting; `getFeedbackSnapshot`
 * is read-only and safe to call from any route.
 * **Tracing invariant** — Provider keys are logical names (e.g. `openai`, `kernel`), not API base URLs.
 */

// ── Tau thresholds from whitepaper HPC-GoT specification ─────────
export const TAU = {
  explore: parseFloat(process.env.OPSEEQ_TAU_EXPLORE || '0.7'),
  production: parseFloat(process.env.OPSEEQ_TAU_PRODUCTION || '0.85'),
  deploy: parseFloat(process.env.OPSEEQ_TAU_DEPLOY || '0.9'),
};

// ── Per-provider adaptive metrics ────────────────────────────────
interface ProviderMetrics {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  latencyEma: number;
  successRateEma: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  adaptiveScore: number;
  // Token throughput tracking
  totalInputTokens: number;
  totalOutputTokens: number;
}

const EMA_ALPHA = 0.15;
const LATENCY_BASELINE_MS = 2000;

const providerMetrics = new Map<string, ProviderMetrics>();

function getOrCreate(provider: string): ProviderMetrics {
  let m = providerMetrics.get(provider);
  if (!m) {
    m = {
      totalRequests: 0, successCount: 0, failureCount: 0,
      latencyEma: LATENCY_BASELINE_MS, successRateEma: 1.0,
      lastError: null, lastErrorAt: null, lastSuccessAt: null,
      adaptiveScore: 0.5,
      totalInputTokens: 0, totalOutputTokens: 0,
    };
    providerMetrics.set(provider, m);
  }
  return m;
}

function recomputeScore(m: ProviderMetrics): void {
  const speedFactor = Math.min(1.0, LATENCY_BASELINE_MS / Math.max(m.latencyEma, 100));
  m.adaptiveScore = 0.6 * m.successRateEma + 0.4 * speedFactor;
}

export function recordSuccess(provider: string, latencyMs: number, usage?: { prompt_tokens: number; completion_tokens: number }): void {
  const m = getOrCreate(provider);
  m.totalRequests++;
  m.successCount++;
  m.latencyEma = EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * m.latencyEma;
  m.successRateEma = EMA_ALPHA * 1.0 + (1 - EMA_ALPHA) * m.successRateEma;
  m.lastSuccessAt = new Date().toISOString();
  if (usage) {
    m.totalInputTokens += usage.prompt_tokens;
    m.totalOutputTokens += usage.completion_tokens;
  }
  recomputeScore(m);
}

export function recordFailure(provider: string, error: string): void {
  const m = getOrCreate(provider);
  m.totalRequests++;
  m.failureCount++;
  m.successRateEma = EMA_ALPHA * 0.0 + (1 - EMA_ALPHA) * m.successRateEma;
  m.lastError = error;
  m.lastErrorAt = new Date().toISOString();
  recomputeScore(m);
}

export function getAdaptiveRanking(): Array<{ provider: string; score: number; metrics: ProviderMetrics }> {
  return [...providerMetrics.entries()]
    .map(([provider, metrics]) => ({ provider, score: metrics.adaptiveScore, metrics }))
    .sort((a, b) => b.score - a.score);
}

/** When `OPSEEQ_ADAPTIVE_ROUTING=true`, `provider-resolution` may prefer this provider if it can serve the model. */
export function getBestProvider(): string | null {
  const ranking = getAdaptiveRanking();
  if (ranking.length === 0) return null;
  if (ranking.length >= 2 && ranking[0].score - ranking[1].score < 0.05) return null;
  if (ranking[0].metrics.totalRequests < 5) return null;
  return ranking[0].provider;
}

// ── TraceRank: Concentration Score ───────────────────────────────
// C(z) = 1 - H(z)/log(d) — measures how concentrated routing is
// High C = most traffic goes to one provider (risk of over-reliance)
function computeConcentration(): { score: number; entropy: number; providers: number } {
  const entries = [...providerMetrics.values()];
  const total = entries.reduce((s, m) => s + m.totalRequests, 0);
  if (total === 0 || entries.length <= 1) return { score: 0, entropy: 0, providers: entries.length };

  const d = entries.length;
  let H = 0;
  for (const m of entries) {
    const p = m.totalRequests / total;
    if (p > 0) H -= p * Math.log(p);
  }
  const maxH = Math.log(d);
  const C = maxH > 0 ? 1 - H / maxH : 0;
  return { score: Math.round(C * 1000) / 1000, entropy: Math.round(H * 1000) / 1000, providers: d };
}

// ── CELLAR-style Inference Artifact Ring Buffer ──────────────────
// Hot-plane: last N inference artifacts for rapid retrieval
interface InferenceArtifact {
  id: string;
  model: string;
  provider: string;
  latencyMs: number;
  tokens: { input: number; output: number } | null;
  success: boolean;
  timestamp: string;
  traceId: string | null;
}

const ARTIFACT_RING_SIZE = 500;
const artifactRing: InferenceArtifact[] = [];

export function recordArtifact(a: InferenceArtifact): void {
  artifactRing.push(a);
  if (artifactRing.length > ARTIFACT_RING_SIZE) artifactRing.shift();
}

export function getRecentArtifacts(limit = 20): InferenceArtifact[] {
  return artifactRing.slice(-limit);
}

// ── Full snapshot for /api/status ────────────────────────────────
export function getFeedbackSnapshot(): Record<string, unknown> {
  const ranking = getAdaptiveRanking();
  const concentration = computeConcentration();
  const totalTracked = [...providerMetrics.values()].reduce((s, m) => s + m.totalRequests, 0);
  const totalTokens = [...providerMetrics.values()].reduce((s, m) => s + m.totalInputTokens + m.totalOutputTokens, 0);

  return {
    version: '5.0',
    tau: TAU,
    providers: Object.fromEntries(
      [...providerMetrics.entries()].map(([k, v]) => [k, {
        requests: v.totalRequests,
        successRate: Math.round(v.successRateEma * 1000) / 1000,
        latencyEma: Math.round(v.latencyEma),
        score: Math.round(v.adaptiveScore * 1000) / 1000,
        tokens: { input: v.totalInputTokens, output: v.totalOutputTokens },
        lastError: v.lastError,
        lastErrorAt: v.lastErrorAt,
      }]),
    ),
    ranking: ranking.map(r => ({ provider: r.provider, score: Math.round(r.score * 1000) / 1000 })),
    bestProvider: getBestProvider(),
    concentration,
    totalTracked,
    totalTokens,
    recentArtifacts: getRecentArtifacts(10).length,
  };
}
