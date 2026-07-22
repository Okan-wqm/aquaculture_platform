import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import {
  IRateLimiterStrategy,
  RateLimitResult,
} from '../interfaces';

/**
 * Rate limit entry for sliding window
 */
interface SlidingWindowEntry {
  timestamps: number[];
  windowStart: number;
}

/**
 * APA-368: atomic Redis sliding window over a sorted set. Runs entirely
 * server-side so concurrent requests across instances see one consistent count.
 *   - drop timestamps older than the window (ZREMRANGEBYSCORE);
 *   - if adding `points` would exceed `limit`, return blocked + the oldest score
 *     (for Retry-After) WITHOUT mutating the set;
 *   - otherwise ZADD one member per point (unique via a per-call token so
 *     concurrent callers at the same millisecond never collide) and PEXPIRE.
 * Returns {allowed(0|1), remaining, oldestScoreMs}.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local points = tonumber(ARGV[4])
local token = ARGV[5]
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
local function oldest()
  local z = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if z[2] then return tonumber(z[2]) end
  return now
end
if count + points > limit then
  return {0, 0, oldest()}
end
for i = 1, points do
  redis.call('ZADD', key, now, now .. ':' .. token .. ':' .. i)
end
redis.call('PEXPIRE', key, windowMs)
local remaining = limit - redis.call('ZCARD', key)
if remaining < 0 then remaining = 0 end
return {1, remaining, oldest()}
`;

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
  private readonly cleanupInterval?: NodeJS.Timeout;
  private readonly defaultLimit: number;
  private readonly defaultWindowMs: number;
  /**
   * APA-368: Redis-backed distributed rate limiting. Correct-by-default — when a
   * Redis client is wired (every service with a REDIS_URL provides REDIS_CLIENT),
   * the sliding window runs atomically in Redis so all replicas share ONE
   * counter; the in-memory Map is used only when no client is present
   * (local/dev/test). `RATE_LIMIT_USE_REDIS` (the flag production already sets)
   * defaults TRUE and only lets an operator force the in-memory path off Redis
   * locally. In production without a Redis client the strategy logs a loud error
   * (per-replica limits under-enforce) but does NOT crash — the ThrottlerModule
   * is imported by every service, so a hard fail-fast could take down a service
   * whose Redis wiring lives in the droplet `.env`; the honest signal + the
   * default-on behaviour close the gap without that blast radius.
   */
  private readonly useRedis: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {
    this.defaultLimit = this.configService.get<number>('RATE_LIMIT_DEFAULT', 100);
    this.defaultWindowMs = this.configService.get<number>('RATE_LIMIT_WINDOW_MS', 60000);
    this.useRedis =
      !!this.redis && this.configService.get<boolean>('RATE_LIMIT_USE_REDIS', true);

    const isProduction = this.configService.get<string>('NODE_ENV', 'development') === 'production';
    if (!this.useRedis && isProduction) {
      this.logger.error(
        'SlidingWindowStrategy is using in-memory storage in production — rate ' +
        'limits are per-replica and under-enforce across instances. Wire a Redis ' +
        'client (REDIS_URL) so RATE_LIMIT_USE_REDIS takes effect.',
      );
    }

    // Redis handles expiry via PEXPIRE; the sweep timer is in-memory only.
    if (!this.useRedis) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    }

    this.logger.log(
      `SlidingWindowStrategy initialized (storage: ${this.useRedis ? 'Redis' : 'in-memory'})`,
    );
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
  }

  /**
   * The Redis client, narrowed to non-optional. Only reached on the useRedis
   * path (constructor guarantees a client is wired whenever useRedis is true),
   * so this throw is a defensive invariant, not a runtime path.
   */
  private get redisClient(): Redis {
    if (!this.redis) {
      throw new Error('SlidingWindowStrategy: Redis client is not configured');
    }
    return this.redis;
  }

  /**
   * APA-368: atomic Redis sliding-window consume via the Lua script. One
   * round-trip, no read-modify-write race across instances.
   */
  private async consumeRedis(
    key: string,
    limit: number,
    windowMs: number,
    points: number,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const token = randomBytes(8).toString('hex');
    const raw = (await this.redisClient.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      String(now),
      String(windowMs),
      String(limit),
      String(points),
      token,
    )) as [number, number, number];
    const [allowedFlag, remaining, oldestScore] = raw;
    const resetTime = new Date(oldestScore + windowMs);
    if (allowedFlag === 1) {
      return { allowed: true, remaining, resetTime };
    }
    const retryAfter = Math.max(1, Math.ceil((oldestScore + windowMs - now) / 1000));
    return { allowed: false, remaining: 0, resetTime, retryAfter };
  }

  /**
   * Consume a rate limit point
   * Returns remaining points or -1 if blocked
   */
  async consume(key: string, points = 1): Promise<RateLimitResult> {
    if (this.useRedis) {
      return this.consumeRedis(key, this.defaultLimit, this.defaultWindowMs, points);
    }
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
    entry.timestamps = entry.timestamps.filter(ts => ts > windowStart);
    entry.windowStart = windowStart;

    // Count requests in current window
    const currentCount = entry.timestamps.length;

    // Check if limit would be exceeded
    if (currentCount + points > limit) {
      const oldestTimestamp = entry.timestamps[0] || now;
      const retryAfter = Math.ceil((oldestTimestamp + windowMs - now) / 1000);

      return {
        allowed: false,
        remaining: 0,
        resetTime: new Date(oldestTimestamp + windowMs),
        retryAfter: Math.max(1, retryAfter),
      };
    }

    // Add timestamps for consumed points
    for (let i = 0; i < points; i++) {
      entry.timestamps.push(now);
    }

    const remaining = Math.max(0, limit - entry.timestamps.length);
    const firstTimestamp = entry.timestamps[0];
    const resetTime = firstTimestamp !== undefined
      ? new Date(firstTimestamp + windowMs)
      : new Date(now + windowMs);

    return {
      allowed: true,
      remaining,
      resetTime,
    };
  }

  /**
   * Reset rate limit for a key
   */
  async reset(key: string): Promise<void> {
    if (this.useRedis) {
      await this.redisClient.del(key);
      return;
    }
    this.store.delete(key);
  }

  /**
   * Get current state without consuming
   */
  async get(key: string): Promise<RateLimitResult | null> {
    if (this.useRedis) {
      return this.getRedis(key, this.defaultLimit, this.defaultWindowMs);
    }
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    const windowMs = this.defaultWindowMs;
    const limit = this.extractLimitFromKey(key);
    const windowStart = now - windowMs;

    // Filter timestamps in current window
    const validTimestamps = entry.timestamps.filter(ts => ts > windowStart);
    const remaining = Math.max(0, limit - validTimestamps.length);
    const firstTimestamp = validTimestamps[0];
    const resetTime = firstTimestamp !== undefined
      ? new Date(firstTimestamp + windowMs)
      : new Date(now + windowMs);

    return {
      allowed: remaining > 0,
      remaining,
      resetTime,
    };
  }

  /**
   * Consume with custom limit/window
   */
  async consumeWithConfig(
    key: string,
    limit: number,
    windowMs: number,
    points = 1,
  ): Promise<RateLimitResult> {
    if (this.useRedis) {
      return this.consumeRedis(key, limit, windowMs, points);
    }
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
    entry.timestamps = entry.timestamps.filter(ts => ts > windowStart);
    entry.windowStart = windowStart;

    const currentCount = entry.timestamps.length;

    if (currentCount + points > limit) {
      const oldestTimestamp = entry.timestamps[0] || now;
      const retryAfter = Math.ceil((oldestTimestamp + windowMs - now) / 1000);

      return {
        allowed: false,
        remaining: 0,
        resetTime: new Date(oldestTimestamp + windowMs),
        retryAfter: Math.max(1, retryAfter),
      };
    }

    for (let i = 0; i < points; i++) {
      entry.timestamps.push(now);
    }

    const remaining = Math.max(0, limit - entry.timestamps.length);
    const firstTimestamp = entry.timestamps[0];
    const resetTime = firstTimestamp !== undefined
      ? new Date(firstTimestamp + windowMs)
      : new Date(now + windowMs);

    return {
      allowed: true,
      remaining,
      resetTime,
    };
  }

  /**
   * APA-368: read-only Redis window state (best-effort; no atomicity needed
   * since it consumes nothing). Prunes the window, then counts.
   */
  private async getRedis(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitResult | null> {
    const now = Date.now();
    await this.redisClient.zremrangebyscore(key, 0, now - windowMs);
    const count = await this.redisClient.zcard(key);
    if (count === 0) {
      return null;
    }
    const remaining = Math.max(0, limit - count);
    const oldest = await this.redisClient.zrange(key, 0, 0, 'WITHSCORES');
    const oldestScore = oldest[1] !== undefined ? Number(oldest[1]) : now;
    return {
      allowed: remaining > 0,
      remaining,
      resetTime: new Date(oldestScore + windowMs),
    };
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
      const validTimestamps = entry.timestamps.filter(ts => ts > now - windowMs);

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
