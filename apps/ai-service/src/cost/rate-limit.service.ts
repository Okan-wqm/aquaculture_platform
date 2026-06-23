import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '@aquaculture/backend-common/redis';

/**
 * Hourly request rate limiting per tenant.
 *
 * Uses Redis INCR + EXPIRE for distributed, atomic counters.
 * Falls back to in-memory Map when Redis is unavailable (single-instance only).
 *
 * Redis key pattern: ai:ratelimit:{tenantId}:{YYYY-MM-DD-HH}
 * TTL: 3600 seconds (1 hour) — auto-expires after the window closes.
 *
 * WHY: Hourly keys (not sliding window) because:
 *   - Simpler to reason about for billing/quota dashboards
 *   - Naturally aligns with the cost reporting granularity
 *   - INCR is O(1) vs sliding window O(log N) with sorted sets
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly useRedis: boolean;

  /** In-memory fallback — single-instance only, not distributed */
  private readonly localCounters = new Map<string, { count: number; resetAt: number }>();

  private static readonly WINDOW_SECONDS = 3600; // 1 hour

  constructor(
    @Optional() private readonly redisService?: RedisService,
  ) {
    this.useRedis = !!this.redisService;
    // SECURITY: Fail closed — in production, Redis is REQUIRED for distributed
    // quota enforcement. In-memory fallback allows tenants to exceed plan limits
    // by N× across multi-instance deployments or via restarts.
    const isProduction = process.env['NODE_ENV'] === 'production';
    if (!this.useRedis && isProduction) {
      throw new Error(
        'CRITICAL: AI rate limiting requires Redis in production. ' +
        'In-memory fallback allows quota bypass across instances. ' +
        'Configure REDIS_HOST to enable distributed rate limiting.',
      );
    }
    if (!this.useRedis) {
      this.logger.warn(
        'AI rate limiting using in-memory Map (non-production). ' +
        'Multi-instance deployments will allow N× configured limit.',
      );
    }
  }

  // ── Key generation ────────────────────────────────────────────────────────

  /**
   * Generate an hourly-scoped Redis key.
   * Format: ai:ratelimit:{tenantId}:{YYYY-MM-DD-HH}
   *
   * WHY: Including the hour in the key means expired windows are separate keys
   * that Redis TTL garbage-collects automatically — no manual cleanup needed.
   */
  private getHourlyKey(tenantId: string): string {
    const now = new Date();
    const hour = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
      String(now.getUTCHours()).padStart(2, '0'),
    ].join('-');
    return `ai:ratelimit:${tenantId}:${hour}`;
  }

  /**
   * Calculate seconds remaining until the current hour ends.
   * Used as TTL for Redis keys so they auto-expire.
   */
  private getSecondsUntilHourEnd(): number {
    const now = new Date();
    const msRemaining =
      (60 - now.getUTCMinutes()) * 60 * 1000 -
      now.getUTCSeconds() * 1000 -
      now.getUTCMilliseconds();
    return Math.max(1, Math.ceil(msRemaining / 1000));
  }

  // ── Rate limit check ─────────────────────────────────────────────────────

  /**
   * Check and increment the rate limit counter for a tenant.
   *
   * @param tenantId - Tenant identifier (from JWT, not user-supplied)
   * @param limit    - Maximum requests allowed per hour
   * @returns Rate limit status with remaining quota and window reset time
   */
  async checkRateLimit(
    tenantId: string,
    limit: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    if (this.redisService) {
      return this.checkRateLimitRedis(this.redisService, tenantId, limit);
    }
    return this.checkRateLimitLocal(tenantId, limit);
  }

  // ── Redis implementation ──────────────────────────────────────────────────

  /**
   * Atomic Redis rate limit check using INCR + EXPIRE.
   *
   * SECURITY: INCR is atomic — concurrent requests from the same tenant
   * cannot race past the limit. The key auto-expires via TTL, so there
   * is no risk of leaked counters consuming Redis memory.
   */
  private async checkRateLimitRedis(
    redisService: RedisService,
    tenantId: string,
    limit: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    const key = this.getHourlyKey(tenantId);
    const ttl = this.getSecondsUntilHourEnd();

    // INCR atomically creates the key with value 1 if it doesn't exist
    const count = await redisService.incr(key);

    // Set TTL only on first increment (when count is 1)
    // WHY: Setting TTL on every INCR would reset the expiry window
    if (count === 1) {
      await redisService.expire(key, ttl);
    }

    const resetAt = new Date();
    resetAt.setUTCMinutes(0, 0, 0);
    resetAt.setUTCHours(resetAt.getUTCHours() + 1);

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt,
    };
  }

  // ── In-memory fallback ────────────────────────────────────────────────────

  /**
   * In-memory rate limit for single-instance deployments.
   *
   * IMPORTANT: This does NOT work across multiple instances.
   * Each instance maintains its own counter, effectively multiplying
   * the limit by the number of instances.
   */
  private async checkRateLimitLocal(
    tenantId: string,
    limit: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    const key = this.getHourlyKey(tenantId);
    const now = Date.now();
    const entry = this.localCounters.get(key);

    // ── Reset if hour has passed ──
    if (!entry || now > entry.resetAt) {
      const resetAt = now + RateLimitService.WINDOW_SECONDS * 1000;
      this.localCounters.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        remaining: limit - 1,
        resetAt: new Date(resetAt),
      };
    }

    // ── Limit exceeded ──
    if (entry.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(entry.resetAt),
      };
    }

    // ── Increment counter ──
    entry.count++;
    return {
      allowed: true,
      remaining: limit - entry.count,
      resetAt: new Date(entry.resetAt),
    };
  }
}
