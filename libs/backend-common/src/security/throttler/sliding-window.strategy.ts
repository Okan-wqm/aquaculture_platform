import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IRateLimiterStrategy, RateLimitResult } from '../interfaces';

/**
 * Rate limit entry for sliding window
 */
interface SlidingWindowEntry {
  timestamps: number[];
  windowStart: number;
}

function resetTimeFor(timestamps: readonly number[], now: number, windowMs: number): Date {
  return new Date((timestamps[0] ?? now) + windowMs);
}

/**
 * Sliding Window Rate Limiter Strategy
 *
 * Uses a sliding window algorithm for more accurate rate limiting.
 * Supports both in-memory (single instance) and Redis (distributed) storage.
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles rate limiting logic
 * - Open/Closed: Can be extended with different storage backends
 * - Liskov Substitution: Implements IRateLimiterStrategy interface
 * - Interface Segregation: Uses minimal interface
 * - Dependency Inversion: Depends on abstractions (Redis interface)
 */
@Injectable()
export class SlidingWindowStrategy implements IRateLimiterStrategy, OnModuleDestroy {
  private readonly logger = new Logger(SlidingWindowStrategy.name);
  private readonly store = new Map<string, SlidingWindowEntry>();
  private readonly cleanupInterval: NodeJS.Timeout;
  private readonly defaultLimit: number;
  private readonly defaultWindowMs: number;

  constructor(private readonly configService: ConfigService) {
    this.defaultLimit = this.configService.get<number>('RATE_LIMIT_DEFAULT', 100);
    this.defaultWindowMs = this.configService.get<number>('RATE_LIMIT_WINDOW_MS', 60000);

    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);

    const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
    if (nodeEnv === 'production') {
      this.logger.warn(
        'SlidingWindowStrategy is using in-memory storage. ' +
          'Rate limits will NOT be enforced across multiple instances. ' +
          'Configure a Redis-backed rate limiter for production deployments.',
      );
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
  }

  /**
   * Consume a rate limit point
   * Returns remaining points or -1 if blocked
   */
  consume(key: string, points = 1): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = this.defaultWindowMs;
    const limit = this.extractLimitFromKey(key);
    const windowStart = now - windowMs;

    // Get or create entry
    let entry = this.store.get(key);

    if (!entry) {
      entry = {
        timestamps: [],
        windowStart: now,
      };
      this.store.set(key, entry);
    }

    // Remove timestamps outside the current window
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);
    entry.windowStart = windowStart;

    // Count requests in current window
    const currentCount = entry.timestamps.length;

    // Check if limit would be exceeded
    if (currentCount + points > limit) {
      const oldestTimestamp = entry.timestamps[0] || now;
      const retryAfter = Math.ceil((oldestTimestamp + windowMs - now) / 1000);

      return Promise.resolve({
        allowed: false,
        remaining: 0,
        resetTime: new Date(oldestTimestamp + windowMs),
        retryAfter: Math.max(1, retryAfter),
      });
    }

    // Add timestamps for consumed points
    for (let i = 0; i < points; i++) {
      entry.timestamps.push(now);
    }

    const remaining = Math.max(0, limit - entry.timestamps.length);
    const resetTime = resetTimeFor(entry.timestamps, now, windowMs);

    return Promise.resolve({
      allowed: true,
      remaining,
      resetTime,
    });
  }

  /**
   * Reset rate limit for a key
   */
  reset(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  /**
   * Get current state without consuming
   */
  get(key: string): Promise<RateLimitResult | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }

    const now = Date.now();
    const windowMs = this.defaultWindowMs;
    const limit = this.extractLimitFromKey(key);
    const windowStart = now - windowMs;

    // Filter timestamps in current window
    const validTimestamps = entry.timestamps.filter((ts) => ts > windowStart);
    const remaining = Math.max(0, limit - validTimestamps.length);
    const resetTime = resetTimeFor(validTimestamps, now, windowMs);

    return Promise.resolve({
      allowed: remaining > 0,
      remaining,
      resetTime,
    });
  }

  /**
   * Consume with custom limit/window
   */
  consumeWithConfig(
    key: string,
    limit: number,
    windowMs: number,
    points = 1,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowMs;

    let entry = this.store.get(key);

    if (!entry) {
      entry = {
        timestamps: [],
        windowStart: now,
      };
      this.store.set(key, entry);
    }

    // Remove timestamps outside the current window
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);
    entry.windowStart = windowStart;

    const currentCount = entry.timestamps.length;

    if (currentCount + points > limit) {
      const oldestTimestamp = entry.timestamps[0] || now;
      const retryAfter = Math.ceil((oldestTimestamp + windowMs - now) / 1000);

      return Promise.resolve({
        allowed: false,
        remaining: 0,
        resetTime: new Date(oldestTimestamp + windowMs),
        retryAfter: Math.max(1, retryAfter),
      });
    }

    for (let i = 0; i < points; i++) {
      entry.timestamps.push(now);
    }

    const remaining = Math.max(0, limit - entry.timestamps.length);
    const resetTime = resetTimeFor(entry.timestamps, now, windowMs);

    return Promise.resolve({
      allowed: true,
      remaining,
      resetTime,
    });
  }

  /**
   * Get the rate limit for a given key.
   *
   * The key format from ThrottlerGuard is 'throttle:{type}:{identifier}'
   * (e.g., 'throttle:ip:1.2.3.4'), which does not encode a numeric limit.
   * Always returns the configured default limit. Per-route limits should
   * use consumeWithConfig() which accepts the limit explicitly.
   */
  private extractLimitFromKey(_key: string): number {
    return this.defaultLimit;
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    const windowMs = this.defaultWindowMs;
    let cleanedCount = 0;

    for (const [key, entry] of this.store.entries()) {
      // Remove entries with no valid timestamps
      const validTimestamps = entry.timestamps.filter((ts) => ts > now - windowMs);

      if (validTimestamps.length === 0) {
        this.store.delete(key);
        cleanedCount++;
      } else {
        entry.timestamps = validTimestamps;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`Cleaned up ${cleanedCount} expired rate limit entries`);
    }
  }
}
