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
export class LegacyTokenMetrics {
  /** Count of tokens received without the `type` JWT claim. */
  private static tokenWithoutType = 0;

  /** Count of tokens received without the `jti` (JWT ID) claim. */
  private static tokenWithoutJti = 0;

  /** Increment the counter for tokens missing the `type` claim. */
  static incrementNoType(): void {
    this.tokenWithoutType++;
  }

  /** Increment the counter for tokens missing the `jti` claim. */
  static incrementNoJti(): void {
    this.tokenWithoutJti++;
  }

  /**
   * Return current metric values.
   * Both counters are monotonically increasing within a process lifetime.
   */
  static getMetrics(): { withoutType: number; withoutJti: number } {
    return {
      withoutType: this.tokenWithoutType,
      withoutJti: this.tokenWithoutJti,
    };
  }

  /**
   * Reset all counters to zero.
   * Intended for testing only; production systems should rely on the
   * monotonic counters and compute rates externally.
   */
  static reset(): void {
    this.tokenWithoutType = 0;
    this.tokenWithoutJti = 0;
  }
}
