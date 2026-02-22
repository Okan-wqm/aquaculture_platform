import { Injectable, Logger } from '@nestjs/common';

/**
 * Hourly request rate limiting per tenant.
 *
 * NOTE: Uses in-memory counters as placeholder.
 * Will be replaced with Redis sliding window when ioredis is wired up.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  private getHourlyKey(tenantId: string): string {
    return `ai:ratelimit:${tenantId}`;
  }

  async checkRateLimit(
    tenantId: string,
    limit: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    const key = this.getHourlyKey(tenantId);
    const now = Date.now();
    const entry = this.counters.get(key);

    // Reset if hour has passed
    if (!entry || now > entry.resetAt) {
      const resetAt = now + 60 * 60 * 1000;
      this.counters.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        remaining: limit - 1,
        resetAt: new Date(resetAt),
      };
    }

    if (entry.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(entry.resetAt),
      };
    }

    entry.count++;
    return {
      allowed: true,
      remaining: limit - entry.count,
      resetAt: new Date(entry.resetAt),
    };
  }
}
