/**
 * @aquaculture/backend-common — canonical circuit-breaker library types
 *
 * # Why this file exists
 *
 * Pre-fix the repository had FIVE incompatible ad-hoc circuit-breaker
 * implementations (gateway proxy, OPA enforcer, messaging-redis breaker,
 * admin-email breaker, claude-budget stub) and ~32 raw `await fetch()`
 * sites with NO breaker at all. CIRCUIT-CRITICAL-004 captures the
 * architectural root cause: no canonical library, so every external-call
 * surface re-derived the pattern (or skipped it). A single shared library
 * with consistent semantics is the Tier-1 cure — once it lands, future
 * external-call sites have one obvious place to wrap, the W3 wave can
 * migrate the 5 ad-hoc impls onto it, and the no-direct-fetch-without-
 * breaker invariant becomes enforceable.
 *
 * # Design contract
 *
 * - Per-tenant keying built-in. A noisy tenant cannot trip the breaker
 *   for everyone (TENANTCOST-HIGH-001 root-cause class). Pass `tenantId`
 *   to `execute()`; '*' (the global key) is the explicit opt-out for
 *   shared infrastructure (e.g. JWKS fetch).
 * - Fail-mode discriminator on every call. Billable / auth callers MUST
 *   pass `failureMode: 'fail-closed'`; non-critical callers may pass
 *   `failureMode: 'fail-open-degraded'` with an explicit fallback.
 * - Sliding window over N buckets × M ms. Default 10×1000 = 10 s window
 *   (matches industry default — Hystrix, Resilience4j).
 * - State machine: CLOSED → OPEN → HALF_OPEN → CLOSED.
 * - Prometheus metrics emitted under `circuit_breaker_*` SSoT label.
 *   The `tenant` label is intentionally OMITTED at metric emission to
 *   avoid unbounded cardinality (PLAT-CRITICAL-001 lesson). Per-tenant
 *   visibility is via the structured-log path, not Prom labels.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Failure-mode discriminator chosen by the caller per-call.
 *
 * - `fail-closed`: trip → reject calls outright. Required for billable /
 *    auth boundary (a financial DB outage MUST not silently succeed).
 * - `fail-open-degraded`: trip → consult fallback, return degraded result.
 *    Appropriate for non-critical paths (cache lookup, telemetry write,
 *    optional metadata fetch).
 *
 * The discriminator is per-call (not per-breaker) because the same
 * external dependency may have both critical and non-critical callers —
 * e.g. a Stripe API call from the create-subscription handler is fail-
 * closed; the same Stripe call from a usage-summary GET endpoint may be
 * fail-open-degraded.
 */
export type FailureMode = 'fail-closed' | 'fail-open-degraded';

export interface CircuitBreakerOptions {
  /**
   * Number of failures within the window required to trip the breaker.
   * Compared against the absolute count, not the rate.
   */
  readonly failureThreshold: number;

  /**
   * Consecutive successes in HALF_OPEN required to close the breaker.
   * Conservative default: 3 — a single test success could be transient.
   */
  readonly successThreshold: number;

  /**
   * Minimum total calls within the window before failure-rate evaluation
   * fires. Prevents a single failure on the first call from tripping.
   */
  readonly volumeThreshold: number;

  /**
   * Failure rate (0-100) within the window above which the breaker
   * trips, IF volumeThreshold is met.
   */
  readonly failureRatePct: number;

  /**
   * Time in ms a call takes before counting as "slow" against the
   * slow-call rate.
   */
  readonly slowCallMs: number;

  /**
   * Slow-call rate (0-100) within the window above which the breaker
   * trips, IF volumeThreshold is met.
   */
  readonly slowCallRatePct: number;

  /**
   * Number of probes admitted in HALF_OPEN. If any probe fails, the
   * breaker re-opens immediately.
   */
  readonly halfOpenRequests: number;

  /**
   * Time in ms the breaker stays OPEN before transitioning to HALF_OPEN.
   */
  readonly openTimeoutMs: number;

  /**
   * Window size in seconds (sliding-window total duration).
   */
  readonly windowSeconds: number;

  /**
   * Bucket duration in seconds (window divides into ⌈windowSeconds/bucketSeconds⌉ buckets).
   */
  readonly bucketSeconds: number;

  /**
   * Per-call failure-mode contract. Required field — explicit-opt-in
   * is the make-impossible discipline for fail-CLOSED on billable paths.
   */
  readonly failureMode: FailureMode;
}

/**
 * Conservative defaults per `.claude/agents/circuit-breaker-auditor.md`
 * configuration discipline. Callers may override per-call but should
 * generally use these unless they have profile data.
 */
export const DEFAULT_BREAKER_OPTIONS: Omit<CircuitBreakerOptions, 'failureMode'> = {
  failureThreshold: 5,
  successThreshold: 3,
  volumeThreshold: 10,
  failureRatePct: 50,
  slowCallMs: 5000,
  slowCallRatePct: 50,
  halfOpenRequests: 3,
  openTimeoutMs: 30_000,
  windowSeconds: 10,
  bucketSeconds: 1,
};

export interface CircuitStats {
  readonly state: CircuitState;
  readonly totalCalls: number;
  readonly successes: number;
  readonly failures: number;
  readonly slowCalls: number;
  readonly failureRatePct: number;
  readonly slowCallRatePct: number;
  readonly stateChangedAtIso: string;
  readonly lastFailureAtIso: string | null;
  readonly lastSuccessAtIso: string | null;
}

/**
 * Thrown when a fail-closed call is rejected because the breaker is OPEN.
 * Distinct error type so call sites can catch specifically and respond
 * with a 503 / 429 instead of a generic 500.
 */
export class CircuitOpenError extends Error {
  constructor(public readonly serviceName: string, public readonly tenantKey: string) {
    super(`Circuit OPEN for service "${serviceName}" (tenantKey="${tenantKey}")`);
    this.name = 'CircuitOpenError';
  }
}
