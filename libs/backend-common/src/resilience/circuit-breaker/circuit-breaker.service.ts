import { Injectable, Logger } from '@nestjs/common';

import {
  CircuitBreakerOptions,
  CircuitOpenError,
  CircuitStats,
  CircuitState,
  DEFAULT_BREAKER_OPTIONS,
  FailureMode,
} from './circuit-breaker.types';

/**
 * Sliding window over N buckets × bucketDuration ms.
 *
 * WHY: Industry-standard pattern (Hystrix, Resilience4j). Counting via
 * fixed-time buckets means a momentary blip ages out of the calculation
 * within `windowSeconds`, so the breaker's view is "what happened in the
 * last 10 seconds" rather than "what has ever happened". This keeps the
 * breaker responsive without retaining old failures forever.
 *
 * WHAT: Each bucket holds {success, failure, slow, timestamp}. The
 * `cleanup()` pass drops buckets older than `windowSize × bucketDuration`
 * before any read so getStats() reflects ONLY the current window.
 */
interface SlidingWindowBucket {
  success: number;
  failure: number;
  slow: number;
  timestamp: number;
}

class SlidingWindow {
  private readonly buckets: SlidingWindowBucket[] = [];

  constructor(
    private readonly windowSize: number,
    private readonly bucketDurationMs: number,
  ) {}

  recordSuccess(slow: boolean): void {
    const b = this.currentBucket();
    b.success += 1;
    if (slow) b.slow += 1;
  }

  recordFailure(): void {
    this.currentBucket().failure += 1;
  }

  getStats(): { success: number; failure: number; slow: number; total: number } {
    this.cleanup();
    const stats = { success: 0, failure: 0, slow: 0, total: 0 };
    for (const b of this.buckets) {
      stats.success += b.success;
      stats.failure += b.failure;
      stats.slow += b.slow;
    }
    stats.total = stats.success + stats.failure;
    return stats;
  }

  reset(): void {
    this.buckets.length = 0;
  }

  private currentBucket(): SlidingWindowBucket {
    const now = Date.now();
    const bucketTs = Math.floor(now / this.bucketDurationMs) * this.bucketDurationMs;
    this.cleanup();
    let b = this.buckets.find((x) => x.timestamp === bucketTs);
    if (!b) {
      b = { success: 0, failure: 0, slow: 0, timestamp: bucketTs };
      this.buckets.push(b);
    }
    return b;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowSize * this.bucketDurationMs;
    while (this.buckets.length > 0 && (this.buckets[0]?.timestamp ?? 0) < cutoff) {
      this.buckets.shift();
    }
  }
}

/**
 * One CircuitBreaker instance per (serviceName, tenantKey). The lifetime
 * matches the parent CircuitBreakerService — typically the lifetime of
 * the Nest module, so the breaker accumulates state across requests
 * within the same pod and is GC'd at pod restart.
 */
class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private stateChangedAt = Date.now();
  private consecutiveSuccesses = 0;
  private consecutiveFailures = 0;
  private halfOpenAdmitted = 0;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private readonly window: SlidingWindow;

  constructor(
    public readonly serviceName: string,
    public readonly tenantKey: string,
    private readonly options: CircuitBreakerOptions,
    private readonly logger: Logger,
  ) {
    const bucketCount = Math.max(1, Math.ceil(options.windowSeconds / options.bucketSeconds));
    this.window = new SlidingWindow(bucketCount, options.bucketSeconds * 1000);
  }

  canAdmit(): boolean {
    this.maybeAutoTransition();
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') return false;
    if (this.halfOpenAdmitted < this.options.halfOpenRequests) {
      this.halfOpenAdmitted += 1;
      return true;
    }
    return false;
  }

  recordSuccess(durationMs: number): void {
    this.window.recordSuccess(durationMs >= this.options.slowCallMs);
    this.lastSuccessAt = Date.now();
    this.consecutiveSuccesses += 1;
    this.consecutiveFailures = 0;
    if (this.state === 'HALF_OPEN' && this.consecutiveSuccesses >= this.options.successThreshold) {
      this.transition('CLOSED');
    }
  }

  recordFailure(): void {
    this.window.recordFailure();
    this.lastFailureAt = Date.now();
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
    if (this.state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN re-opens immediately — probe-and-rollback semantics.
      this.transition('OPEN');
      return;
    }
    this.evaluateTrip();
  }

  getStats(): CircuitStats {
    const ws = this.window.getStats();
    const failureRatePct = ws.total > 0 ? (ws.failure / ws.total) * 100 : 0;
    const slowCallRatePct = ws.total > 0 ? (ws.slow / ws.total) * 100 : 0;
    return {
      state: this.state,
      totalCalls: ws.total,
      successes: ws.success,
      failures: ws.failure,
      slowCalls: ws.slow,
      failureRatePct,
      slowCallRatePct,
      stateChangedAtIso: new Date(this.stateChangedAt).toISOString(),
      lastFailureAtIso: this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
      lastSuccessAtIso: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
    };
  }

  reset(): void {
    this.window.reset();
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures = 0;
    this.halfOpenAdmitted = 0;
    this.transition('CLOSED');
  }

  private maybeAutoTransition(): void {
    if (this.state === 'OPEN' && Date.now() - this.stateChangedAt >= this.options.openTimeoutMs) {
      this.transition('HALF_OPEN');
    }
  }

  private evaluateTrip(): void {
    const ws = this.window.getStats();
    if (ws.total < this.options.volumeThreshold) return;

    const failureRatePct = (ws.failure / ws.total) * 100;
    const slowCallRatePct = (ws.slow / ws.total) * 100;
    const tripsOnFailureRate = failureRatePct >= this.options.failureRatePct;
    const tripsOnSlowRate = slowCallRatePct >= this.options.slowCallRatePct;
    const tripsOnAbsolute = ws.failure >= this.options.failureThreshold;

    if (tripsOnFailureRate || tripsOnSlowRate || tripsOnAbsolute) {
      this.transition('OPEN');
    }
  }

  private transition(next: CircuitState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.stateChangedAt = Date.now();
    if (next === 'HALF_OPEN') this.halfOpenAdmitted = 0;
    if (next === 'CLOSED') this.consecutiveFailures = 0;
    this.logger.log(`CircuitBreaker[${this.serviceName}:${this.tenantKey}] ${prev} → ${next}`);
  }
}

/**
 * Canonical CircuitBreakerService — the single shared library every
 * external-call site MUST use. Per-tenant keying is built-in: a noisy
 * tenant cannot trip the breaker for everyone.
 *
 * # Why a service (not a free function)
 *
 * The breaker accumulates state across calls (sliding window + state
 * machine). A free function would either be stateless (useless) or
 * own a module-scoped singleton (caller-invisible). Wrapping in a
 * NestJS service makes the lifecycle explicit, lets us inject test
 * doubles, and enables future Prom metric registration via OnModuleInit.
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly breakers = new Map<string, CircuitBreaker>();

  /**
   * Execute `fn` under the circuit breaker for `(serviceName, tenantId)`.
   *
   * @param args.serviceName  Stable identifier for the breaker (e.g. 'stripe-api',
   *                           'anthropic', 'opa', 'jwks-fetch'). Used as the
   *                           Prometheus metric label suffix.
   * @param args.tenantId      Tenant UUID for per-tenant keying. Pass undefined
   *                           or '*' for global (cross-tenant) infrastructure
   *                           — JWKS, JWT pubkey fetch, etc.
   * @param args.fn            The operation to protect. MUST be idempotent OR
   *                           the caller MUST handle retry-on-failure semantics
   *                           in `fallback`.
   * @param args.options       Breaker config including failureMode discriminator.
   * @param args.fallback      Consulted ONLY when failureMode='fail-open-degraded'
   *                           AND the breaker is OPEN. fail-closed callers MUST
   *                           NOT pass a fallback — they want the rejection.
   *
   * @returns the value of `fn` on success, the value of `fallback` on
   *          fail-open-degraded trip, or throws CircuitOpenError on
   *          fail-closed trip.
   */
  async execute<T>(args: {
    serviceName: string;
    tenantId?: string;
    fn: () => Promise<T>;
    options: CircuitBreakerOptions;
    fallback?: () => T | Promise<T>;
  }): Promise<T> {
    const tenantKey = args.tenantId ?? '*';
    const breaker = this.getOrCreate(args.serviceName, tenantKey, args.options);

    if (!breaker.canAdmit()) {
      // Trip path: failureMode dictates behaviour.
      if (args.options.failureMode === 'fail-closed') {
        throw new CircuitOpenError(args.serviceName, tenantKey);
      }
      // fail-open-degraded — caller MUST have provided a fallback.
      if (!args.fallback) {
        throw new Error(
          `[CircuitBreaker:${args.serviceName}] failureMode='fail-open-degraded' requires an explicit fallback. ` +
            'Pass `fallback: () => …` or switch to failureMode=fail-closed.',
        );
      }
      return args.fallback();
    }

    const startMs = Date.now();
    try {
      const result = await args.fn();
      breaker.recordSuccess(Date.now() - startMs);
      return result;
    } catch (err) {
      breaker.recordFailure();
      throw err;
    }
  }

  /**
   * Diagnostic — return the current stats for every active breaker.
   * Used by health endpoints and observability dumps. NOT for runtime
   * control flow — call sites should consult breaker state via
   * `execute()` only.
   */
  getAllStats(): { key: string; serviceName: string; tenantKey: string; stats: CircuitStats }[] {
    return Array.from(this.breakers.entries()).map(([key, b]) => ({
      key,
      serviceName: b.serviceName,
      tenantKey: b.tenantKey,
      stats: b.getStats(),
    }));
  }

  /**
   * Force-reset every breaker. Operator-only; intended for the
   * `/admin/circuit-breakers/reset` endpoint after manual incident
   * recovery. Per-breaker reset would be too granular — operators want
   * the whole pod's view to start fresh.
   */
  resetAll(): void {
    for (const b of this.breakers.values()) b.reset();
  }

  private getOrCreate(
    serviceName: string,
    tenantKey: string,
    options: CircuitBreakerOptions,
  ): CircuitBreaker {
    const key = `${serviceName}:${tenantKey}`;
    let b = this.breakers.get(key);
    if (!b) {
      b = new CircuitBreaker(serviceName, tenantKey, options, this.logger);
      this.breakers.set(key, b);
    }
    return b;
  }
}

// Re-export option helpers so callers do not need a second import.
export { DEFAULT_BREAKER_OPTIONS };
export type { CircuitBreakerOptions, FailureMode, CircuitState, CircuitStats };
export { CircuitOpenError };
