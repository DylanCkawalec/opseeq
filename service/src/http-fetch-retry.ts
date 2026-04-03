/**
 * @module http-fetch-retry — Shared upstream HTTP retry policy
 *
 * **Axiom A1 — Retry parity** — `fetchWithRetry` and `fetchStreamWithRetry` share identical attempt
 * counts, exponential backoff (`baseDelay * 2^attempt`), and 5xx retry semantics.
 * **Axiom A2 — Non-idempotent safety** — Retries apply only before the response body is consumed;
 * streaming callers must not read `body` until the returned `Response` is final.
 * **Postulate P1 — Network errors** — Thrown `fetch` errors trigger retry until attempts exhausted;
 * the last error is rethrown (legacy behavior).
 * **Postulate P2 — HTTP 5xx** — Status ≥ 500 triggers backoff and retry; 4xx is returned immediately.
 * **Corollary C1 — Defaults** — `retries = 2`, `baseDelay = 500` match historical router constants.
 * **Lemma L1 — Stream alias** — `fetchStreamWithRetry` delegates to `fetchWithRetry` (same code path).
 * **Behavioral contract** — Callers must `await res.text()` or equivalent on failure paths to avoid
 * socket leaks on some runtimes (unchanged from direct `fetch`).
 * **Tracing invariant** — No logging here; router and index own observability.
 */
export async function fetchWithRetry(
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

/**
 * Same retry policy as `fetchWithRetry`, but returns the full `Response` so callers can
 * stream `response.body` without consuming it during retries.
 */
export async function fetchStreamWithRetry(
  url: string,
  init: RequestInit,
  retries = 2,
  baseDelay = 500,
): Promise<Response> {
  return fetchWithRetry(url, init, retries, baseDelay);
}
