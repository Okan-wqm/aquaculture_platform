import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RedisService } from '../../redis/redis.service';
import { IRateLimiterStrategy, RateLimitResult } from '../interfaces';

interface SlidingWindowEntry {
  timestamps: number[];
}

/** Minimal Redis capability consumed by the distributed limiter. */
export interface SlidingWindowRedisClient {
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
  zremrangebyscore(key: string, minimum: number, maximum: number): Promise<number>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number, mode: 'WITHSCORES'): Promise<string[]>;
}

export interface SlidingWindowRedisPort {
  getKeyPrefix(): string;
  getClient(): SlidingWindowRedisClient;
  del(key: string): Promise<number>;
}

/**
 * Atomic sliding-window mutation. Every replica executes the complete
 * prune/count/admit/write operation inside Redis, so concurrent requests cannot
 * observe or overwrite a stale count.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local points = tonumber(ARGV[4])
local token = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window_ms)
local count = redis.call('ZCARD', key)

local function oldest_score()
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest[2] then
    return tonumber(oldest[2])
  end
  return now
end

if count + points > limit then
  return {0, 0, oldest_score()}
end

for index = 1, points do
  redis.call('ZADD', key, now, now .. ':' .. token .. ':' .. index)
end
redis.call('PEXPIRE', key, window_ms)

local remaining = limit - redis.call('ZCARD', key)
if remaining < 0 then
  remaining = 0
end
return {1, remaining, oldest_score()}
`;

function configBoolean(value: string | boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return value.trim().toLowerCase() === 'true';
}

function parseRedisWindowResult(value: unknown): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error('Redis returned an invalid sliding-window result');
  }

  const entries: unknown[] = value;
  const allowed = entries[0];
  const remaining = entries[1];
  const oldestTimestamp = entries[2];
  if (
    typeof allowed !== 'number' ||
    !Number.isFinite(allowed) ||
    typeof remaining !== 'number' ||
    !Number.isFinite(remaining) ||
    typeof oldestTimestamp !== 'number' ||
    !Number.isFinite(oldestTimestamp)
  ) {
    throw new Error('Redis returned an invalid sliding-window result');
  }

  return [allowed, remaining, oldestTimestamp];
}

/**
 * Canonical platform sliding-window rate limiter.
 *
 * Production is Redis-only: a missing Redis provider or an attempted
 * RATE_LIMIT_USE_REDIS=false override fails application composition instead of
 * silently multiplying limits by the replica count. The local Map exists only
 * for development and isolated unit tests that deliberately have no Redis.
 */
@Injectable()
export class SlidingWindowStrategy implements IRateLimiterStrategy, OnModuleDestroy {
  private readonly logger = new Logger(SlidingWindowStrategy.name);
  private readonly store = new Map<string, SlidingWindowEntry>();
  private readonly cleanupInterval?: NodeJS.Timeout;
  private readonly defaultLimit: number;
  private readonly defaultWindowMs: number;
  private readonly useRedis: boolean;

  constructor(
    @Inject(ConfigService)
    private readonly configService: Pick<ConfigService, 'get'>,
    @Optional()
    @Inject(RedisService)
    private readonly redis?: SlidingWindowRedisPort,
  ) {
    this.defaultLimit = this.configService.get<number>('RATE_LIMIT_DEFAULT', 100);
    this.defaultWindowMs = this.configService.get<number>('RATE_LIMIT_WINDOW_MS', 60_000);

    const production = this.configService.get<string>('NODE_ENV', 'development') === 'production';
    const redisRequested = configBoolean(
      this.configService.get<string | boolean>('RATE_LIMIT_USE_REDIS'),
      true,
    );

    if (production && !redisRequested) {
      throw new Error(
        'RATE_LIMIT_USE_REDIS=false is forbidden in production; distributed throttling is mandatory',
      );
    }
    if (production && !this.redis) {
      throw new Error(
        'RedisService is required for production throttling; import RedisModule in the service root',
      );
    }

    this.useRedis = redisRequested && this.redis !== undefined;
    if (!this.useRedis) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    }

    this.logger.log(
      `SlidingWindowStrategy initialized with ${this.useRedis ? 'Redis' : 'non-production memory'} storage`,
    );
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.store.clear();
  }

  async consume(key: string, points = 1): Promise<RateLimitResult> {
    return this.consumeWithConfig(key, this.defaultLimit, this.defaultWindowMs, points);
  }

  async reset(key: string): Promise<void> {
    if (this.useRedis) {
      await this.redisOrThrow.del(this.logicalRedisKey(key));
      return;
    }
    this.store.delete(key);
  }

  async get(key: string): Promise<RateLimitResult | null> {
    if (this.useRedis) {
      return this.getRedis(key, this.defaultLimit, this.defaultWindowMs);
    }

    const timestamps = this.activeTimestamps(key, this.defaultWindowMs);
    if (timestamps.length === 0) return null;

    const remaining = Math.max(0, this.defaultLimit - timestamps.length);
    return {
      allowed: remaining > 0,
      remaining,
      resetTime: new Date(timestamps[0]! + this.defaultWindowMs),
    };
  }

  async consumeWithConfig(
    key: string,
    limit: number,
    windowMs: number,
    points = 1,
  ): Promise<RateLimitResult> {
    this.assertConfiguration(limit, windowMs, points);
    if (this.useRedis) return this.consumeRedis(key, limit, windowMs, points);
    return this.consumeMemory(key, limit, windowMs, points);
  }

  private get redisOrThrow(): SlidingWindowRedisPort {
    if (!this.redis) {
      throw new Error('RedisService is not configured for distributed throttling');
    }
    return this.redis;
  }

  private logicalRedisKey(key: string): string {
    return `rate-limit:${key}`;
  }

  private physicalRedisKey(key: string): string {
    return `${this.redisOrThrow.getKeyPrefix()}${this.logicalRedisKey(key)}`;
  }

  private async consumeRedis(
    key: string,
    limit: number,
    windowMs: number,
    points: number,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const result = await this.redisOrThrow
      .getClient()
      .eval(
        SLIDING_WINDOW_LUA,
        1,
        this.physicalRedisKey(key),
        String(now),
        String(windowMs),
        String(limit),
        String(points),
        randomBytes(12).toString('hex'),
      );
    const [allowedFlag, remaining, oldestTimestamp] = parseRedisWindowResult(result);
    const resetTime = new Date(oldestTimestamp + windowMs);

    if (allowedFlag === 1) return { allowed: true, remaining, resetTime };

    return {
      allowed: false,
      remaining: 0,
      resetTime,
      retryAfter: Math.max(1, Math.ceil((oldestTimestamp + windowMs - now) / 1000)),
    };
  }

  private async getRedis(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitResult | null> {
    const client = this.redisOrThrow.getClient();
    const physicalKey = this.physicalRedisKey(key);
    const now = Date.now();
    await client.zremrangebyscore(physicalKey, 0, now - windowMs);
    const count = await client.zcard(physicalKey);
    if (count === 0) return null;

    const oldest = await client.zrange(physicalKey, 0, 0, 'WITHSCORES');
    const oldestTimestamp = oldest[1] === undefined ? now : Number(oldest[1]);
    if (!Number.isFinite(oldestTimestamp)) {
      throw new Error('Redis returned an invalid oldest sliding-window timestamp');
    }
    const remaining = Math.max(0, limit - count);
    return {
      allowed: remaining > 0,
      remaining,
      resetTime: new Date(oldestTimestamp + windowMs),
    };
  }

  private consumeMemory(
    key: string,
    limit: number,
    windowMs: number,
    points: number,
  ): RateLimitResult {
    const now = Date.now();
    const timestamps = this.activeTimestamps(key, windowMs);
    const oldestTimestamp = timestamps[0] ?? now;
    if (timestamps.length + points > limit) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: new Date(oldestTimestamp + windowMs),
        retryAfter: Math.max(1, Math.ceil((oldestTimestamp + windowMs - now) / 1000)),
      };
    }

    for (let index = 0; index < points; index += 1) timestamps.push(now);
    this.store.set(key, { timestamps });
    return {
      allowed: true,
      remaining: Math.max(0, limit - timestamps.length),
      resetTime: new Date((timestamps[0] ?? now) + windowMs),
    };
  }

  private activeTimestamps(key: string, windowMs: number): number[] {
    const cutoff = Date.now() - windowMs;
    const timestamps = (this.store.get(key)?.timestamps ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (timestamps.length === 0) this.store.delete(key);
    else this.store.set(key, { timestamps });
    return timestamps;
  }

  private assertConfiguration(limit: number, windowMs: number, points: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('Rate-limit limit must be a positive safe integer');
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new RangeError('Rate-limit windowMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(points) || points < 1) {
      throw new RangeError('Rate-limit points must be a positive safe integer');
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.defaultWindowMs;
    for (const [key, entry] of this.store.entries()) {
      const timestamps = entry.timestamps.filter((timestamp) => timestamp > cutoff);
      if (timestamps.length === 0) this.store.delete(key);
      else this.store.set(key, { timestamps });
    }
  }
}
