/**
 * Legacy Token Metrics
 *
 * Tracks usage of pre-hardening JWT tokens (missing `type` or `jti` fields).
 * These counters help determine when backward compatibility for legacy tokens
 * can safely be removed. Once both counters reach zero over a sustained period
 * (longer than the maximum token TTL), the sunset is complete.
 *
 * The counters are in-process; for multi-instance deployments they should be
 * wired to a Prometheus-compatible collector via the metrics module.
 *
 * @example
 * ```typescript
 * // In auth guard or JWT middleware:
 * if (!payload.type) LegacyTokenMetrics.incrementNoType();
 * if (!payload.jti)  LegacyTokenMetrics.incrementNoJti();
 *
 * // In health/metrics endpoint:
 * const m = LegacyTokenMetrics.getMetrics();
 * gauge.set({ field: 'withoutType' }, m.withoutType);
 * ```
 */
let tokenWithoutType = 0;
let tokenWithoutJti = 0;

export const LegacyTokenMetrics = {
  /** Increment the counter for tokens missing the `type` claim. */
  incrementNoType(): void {
    tokenWithoutType++;
  },

  /** Increment the counter for tokens missing the `jti` claim. */
  incrementNoJti(): void {
    tokenWithoutJti++;
  },

  /**
   * Return current metric values.
   * Both counters are monotonically increasing within a process lifetime.
   */
  getMetrics(): { withoutType: number; withoutJti: number } {
    return {
      withoutType: tokenWithoutType,
      withoutJti: tokenWithoutJti,
    };
  },

  /**
   * Reset all counters to zero.
   * Intended for testing only; production systems should rely on the
   * monotonic counters and compute rates externally.
   */
  reset(): void {
    tokenWithoutType = 0;
    tokenWithoutJti = 0;
  },
} as const;
