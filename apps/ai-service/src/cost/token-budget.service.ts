import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '@aquaculture/backend-common/redis';

/**
 * Monthly token budget tracking per tenant.
 *
 * Uses Redis INCRBY for distributed, atomic token counters.
 * Falls back to in-memory Map when Redis is unavailable (single-instance only).
 *
 * Redis key pattern: ai:tokens:{tenantId}:{YYYY-MM}
 * TTL: End of month + 48 hours buffer (for billing reconciliation queries).
 *
 * WHY: Monthly keys rotate naturally — each month gets a fresh counter.
 * The 48h buffer after month-end allows billing cron jobs to read
 * the final value before the key expires.
 */
@Injectable()
export class TokenBudgetService {
  private readonly logger = new Logger(TokenBudgetService.name);
  private readonly useRedis: boolean;

  /** In-memory fallback — single-instance only, loses data on restart */
  private readonly localCounters = new Map<string, number>();

  constructor(@Optional() private readonly redisService?: RedisService) {
    this.useRedis = !!this.redisService;
    // SECURITY: Fail closed — in production, Redis is REQUIRED for distributed
    // token budget enforcement. In-memory fallback allows tenants to exceed
    // monthly budgets via restarts or multi-instance scaling.
    const isProduction = process.env['NODE_ENV'] === 'production';
    if (!this.useRedis && isProduction) {
      throw new Error(
        'CRITICAL: AI token budget requires Redis in production. ' +
          'In-memory fallback allows budget bypass across instances. ' +
          'Configure REDIS_HOST to enable distributed budget enforcement.',
      );
    }
    if (!this.useRedis) {
      this.logger.warn(
        'AI token budget using in-memory Map (non-production). ' +
          'Multi-instance deployments will have separate counters. ' +
          'Data will be lost on service restart.',
      );
    }
  }

  // ── Key generation ────────────────────────────────────────────────────────

  /**
   * Generate a monthly-scoped Redis key.
   * Format: ai:tokens:{tenantId}:{YYYY-MM}
   */
  private getMonthlyKey(tenantId: string): string {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return `ai:tokens:${tenantId}:${month}`;
  }

  /**
   * Calculate seconds until end of current month + 48h buffer.
   *
   * WHY: 48h buffer ensures billing reconciliation cron jobs can still
   * read the final token count after the month rolls over.
   */
  private getMonthEndTtl(): number {
    const now = new Date();
    const endOfMonth = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() + 1, // Next month
        1,
        0,
        0,
        0, // First day at midnight
      ),
    );
    const bufferMs = 48 * 60 * 60 * 1000; // 48 hours
    const ttlMs = endOfMonth.getTime() - now.getTime() + bufferMs;
    return Math.max(1, Math.ceil(ttlMs / 1000));
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Get current token usage for a tenant this month.
   *
   * @param tenantId - Tenant identifier (from JWT, not user-supplied)
   * @returns Current token count (0 if no usage this month)
   */
  async getUsage(tenantId: string): Promise<number> {
    const key = this.getMonthlyKey(tenantId);
    if (this.redisService) {
      const value = await this.redisService.get(key);
      return value ? parseInt(value, 10) : 0;
    }
    return this.localCounters.get(key) ?? 0;
  }

  /**
   * Add token usage for a tenant.
   *
   * Uses Redis INCRBY for atomic, distributed increment.
   * Sets TTL on first write so the key auto-expires after month end.
   *
   * @param tenantId - Tenant identifier (from JWT, not user-supplied)
   * @param tokens   - Number of tokens consumed in this request
   * @returns New cumulative usage for the current month
   */
  async addUsage(tenantId: string, tokens: number): Promise<number> {
    if (this.redisService) {
      return this.addUsageRedis(this.redisService, tenantId, tokens);
    }
    return this.addUsageLocal(tenantId, tokens);
  }

  /**
   * Check whether a tenant has remaining budget.
   *
   * @param tenantId - Tenant identifier (from JWT, not user-supplied)
   * @param budget   - Monthly token limit from subscription plan
   * @returns Budget status with used/remaining counts
   */
  async checkBudget(
    tenantId: string,
    budget: number,
  ): Promise<{ allowed: boolean; used: number; remaining: number }> {
    const used = await this.getUsage(tenantId);
    const remaining = Math.max(0, budget - used);
    return {
      allowed: used < budget,
      used,
      remaining,
    };
  }

  /**
   * SEC-MEDIUM-075 (2026-08-23 scan №20): atomically RESERVE budget before a
   * billable provider call and settle the difference afterwards.
   *
   * The previous check-then-spend flow (GET here, INCRBY after the turn)
   * let every concurrent request pass the same pre-check and all spend —
   * overshoot bounded only by in-flight × per-turn tokens. Reserving via
   * INCRBY-first makes the window structurally impossible: a reservation
   * that would cross the budget rolls back and fails closed.
   *
   * @param tenantId        - Tenant identifier (from JWT)
   * @param budget          - Monthly token limit
   * @param estimatedTokens - Upper bound for the upcoming call (per-turn cap)
   */
  async reserveBudget(tenantId: string, budget: number, estimatedTokens: number): Promise<void> {
    const after = await this.addUsage(tenantId, estimatedTokens);
    if (after > budget) {
      // Roll the reservation back — the attempt is rejected, not charged.
      await this.addUsage(tenantId, -estimatedTokens);
      const used = Math.max(0, after - estimatedTokens);
      throw new Error(`Monthly token budget exceeded (${used}/${budget})`);
    }
  }

  /**
   * SEC-MEDIUM-075: settle a reservation — refund the unused difference
   * between the reserved upper bound and the tokens actually consumed.
   */
  async settleReservation(
    tenantId: string,
    estimatedTokens: number,
    actualTokens: number,
  ): Promise<void> {
    const refund = estimatedTokens - actualTokens;
    if (refund > 0) {
      await this.addUsage(tenantId, -refund);
    }
  }

  // ── Redis implementation ──────────────────────────────────────────────────

  /**
   * Atomic Redis token increment using INCRBY + conditional EXPIRE.
   *
   * SECURITY: INCRBY is atomic — concurrent requests cannot cause
   * lost updates. The key auto-expires via TTL after month end.
   */
  private async addUsageRedis(
    redisService: RedisService,
    tenantId: string,
    tokens: number,
  ): Promise<number> {
    const key = this.getMonthlyKey(tenantId);

    // INCRBY atomically creates the key with the increment value if it doesn't exist
    const newValue = await redisService.incrby(key, tokens);

    // Set TTL only on first write (when newValue equals the tokens just added)
    // WHY: Re-setting TTL on every write would push expiry into the future
    if (newValue === tokens) {
      const ttl = this.getMonthEndTtl();
      await redisService.expire(key, ttl);
    }

    return newValue;
  }

  // ── In-memory fallback ────────────────────────────────────────────────────

  /**
   * In-memory token increment for single-instance deployments.
   *
   * IMPORTANT: Counters are lost on service restart and are NOT
   * shared across instances.
   */
  private async addUsageLocal(tenantId: string, tokens: number): Promise<number> {
    const key = this.getMonthlyKey(tenantId);
    const current = this.localCounters.get(key) ?? 0;
    const newValue = current + tokens;
    this.localCounters.set(key, newValue);
    return newValue;
  }
}
