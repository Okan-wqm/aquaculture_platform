/**
 * Conditional socket reconnect policy primitives (FAZ 3.1) — pure, testable.
 *
 * The panel deliberately does NOT use socket.io's built-in reconnection loop:
 * the FAZ 3.1 policy requires (a) jittered bounded backoff, (b) a /health/live
 * gate that keeps WAITING while the gateway is down instead of hammering it,
 * (c) a hard stop on 401/4401-class failures (session recovery path), and
 * (d) a visibilitychange-triggered retry with a 2s debounce. The hook owns the
 * loop; everything decision-shaped lives here.
 */

/** Base delay of the exponential ladder (attempt 0 → ~1s). */
export const RECONNECT_BASE_DELAY_MS = 1_000;
/** Ladder cap — never wait longer between attempts (jitter applied below). */
export const RECONNECT_MAX_DELAY_MS = 30_000;
/**
 * Bounded, NOT Infinity: during a full gateway outage an unbounded retry
 * storms the dead upstream forever; ~20 attempts at up to 30s backoff covers
 * transient blips without amplifying an outage (visibility revive resets it).
 */
export const RECONNECT_MAX_ATTEMPTS = 20;

/** Liveness probe endpoint (nginx `location /health` → gateway, unauthenticated GET). */
export const HEALTH_PROBE_URL = '/health/live';
/** Probe timeout — a hung gateway counts as unhealthy. */
export const HEALTH_PROBE_TIMEOUT_MS = 5_000;
/** While unhealthy, re-probe at this cadence WITHOUT burning a backoff attempt. */
export const HEALTH_RETRY_INTERVAL_MS = 5_000;

/** visibilitychange-triggered reconnect debounce (user back → wait, then retry). */
export const VISIBILITY_RECONNECT_DEBOUNCE_MS = 2_000;

/**
 * Full-jitter exponential backoff, clamped to [delay/2, delay]:
 *   attempt 0 → [500, 1000]ms, 1 → [1000, 2000]ms, … capped at [15000, 30000]ms.
 * Jitter desynchronizes fleets of reconnecting clients after a gateway bounce.
 */
export function jitteredBackoffDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt),
  );
  return Math.floor(exponent * (0.5 + random() / 2));
}

/**
 * Classify a failure as AUTH-class (stop reconnecting; recover the session
 * instead). Matches both shapes the client can see:
 *  - `connect_error` Errors whose message/description carry a status token
 *    (401 handshake rejection, 4401 re-auth exhausted) or an auth keyword;
 *  - the gateway's in-band `error` envelope `{ message, code? }` (401/4401
 *    auth failures, 4403 suspended).
 * Suspension (4403) is included deliberately: reconnecting a suspended socket
 * is a loop of guaranteed failures.
 */
export function isAuthDisconnectError(failure: unknown): boolean {
  const code = readCode(failure);
  if (code === 401 || code === 4401 || code === 4403) return true;
  const text = stringifyFailure(failure);
  if (/(^|[^0-9])(401|4401|4403)([^0-9]|$)/.test(text)) return true;
  return /(authentication required|invalid token|not authorized|token expired|re-authentication failed|user suspended)/i.test(
    text,
  );
}

function readCode(failure: unknown): number | undefined {
  if (failure !== null && typeof failure === 'object') {
    const code = (failure as { code?: unknown }).code;
    if (typeof code === 'number') return code;
    if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  }
  return undefined;
}

function stringifyFailure(failure: unknown): string {
  if (typeof failure === 'string') return failure;
  if (typeof failure === 'object' && failure !== null) {
    const err = failure as { message?: unknown; description?: unknown };
    const message = typeof err.message === 'string' ? err.message : '';
    const description = typeof err.description === 'string' ? err.description : '';
    return `${message} ${description}`.trim();
  }
  if (typeof failure === 'number' || typeof failure === 'boolean' || typeof failure === 'bigint') {
    return String(failure);
  }
  return '';
}

/**
 * Liveness gate: reconnect ONLY through a healthy gateway. Strictly 2xx
 * ("200 değilse beklemeye devam") — a 5xx/timeout keeps the client waiting at
 * the probe cadence, which is what keeps a gateway outage un-amplified.
 */
export async function gatewayHealthy(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const response = await fetchFn(HEALTH_PROBE_URL, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
