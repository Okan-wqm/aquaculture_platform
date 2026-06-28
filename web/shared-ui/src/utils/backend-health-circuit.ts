/**
 * Backend-health circuit breaker — a tiny, dependency-free outage gate shared by
 * the GraphQL client and the react-query config.
 *
 * WHY: when the gateway is down it returns 502 on every request. Without a gate,
 * `refetchOnWindowFocus` / `refetchOnReconnect` re-fire on every tab focus and
 * network blip, each hitting the 502 and surfacing an error over already-loaded
 * data — the "data loads, then disappears" symptom — while hammering a dead
 * upstream. This breaker lets the UI STOP those amplifying refetches during a
 * detected outage, then probe for recovery.
 *
 * STATE (a classic 3-state breaker):
 *   - closed   → healthy; refetches allowed.
 *   - open     → outage detected (>= OPEN_THRESHOLD consecutive transport
 *                failures); refetches suppressed for COOLDOWN_MS.
 *   - half-open→ after the cooldown, `isOpen()` returns false ONCE so a single
 *                refetch can probe; a fresh failure re-opens (resets the cooldown),
 *                a success closes the breaker.
 *
 * Only TRANSPORT failures (5xx / network — `recordFailure`) count; GraphQL-level
 * errors on a healthy 200 do NOT (those are not an outage). `recordSuccess` on any
 * 2xx resets it. It deliberately gates only the *amplifiers* (focus/reconnect
 * refetch); react-query's own retry + any refetchInterval still probe, so recovery
 * never depends solely on the breaker half-opening.
 */

/** Consecutive transport failures before the breaker opens. */
const OPEN_THRESHOLD = 3;

/** How long an open breaker suppresses focus/reconnect refetch before a probe. */
const COOLDOWN_MS = 15_000;

class BackendHealthCircuit {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  /** Record a transport failure (5xx / network). Opens after the threshold. */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= OPEN_THRESHOLD) {
      // (Re)start the cooldown from the latest failure so a still-failing probe
      // keeps the breaker suppressing rather than flapping open/closed.
      this.openedAt = Date.now();
    }
  }

  /** Record a successful request (any 2xx). Closes the breaker. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  /**
   * True while refetch amplifiers should be suppressed. Returns false once the
   * cooldown elapses (half-open) so a single probe can attempt recovery.
   */
  isOpen(): boolean {
    if (this.openedAt === null) return false;
    return Date.now() - this.openedAt < COOLDOWN_MS;
  }

  /** Test seam: force back to the closed state. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }
}

/** Process-wide singleton — one breaker per loaded shell. */
export const backendHealthCircuit = new BackendHealthCircuit();

/**
 * react-query `refetchOnWindowFocus` / `refetchOnReconnect` accept a function
 * form; gate them on the breaker so an outage stops the focus/reconnect storm.
 */
export const refetchWhenBackendHealthy = (): boolean => !backendHealthCircuit.isOpen();
