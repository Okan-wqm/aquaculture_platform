import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { RateLimitIncrementResult, RateLimitStore } from './rate-limit.types';

/**
 * Narrow Redis surface the rate-limit store depends on (Interface
 * Segregation, CLAUDE.md Code Quality). The store needs exactly two
 * capabilities: the raw client's `eval` (atomic Lua) and `deletePattern`
 * (window clear).
 *
 * WHY a port and not the full RedisService: the fat service has ~25 methods;
 * depending on the whole surface forces every test to fake all of them (or
 * reach for a banned double-cast through unknown). RedisService satisfies
 * this port structurally, so production wiring is unchanged while a test
 * supplies a two-method double with zero casts.
 *
 * `getClient(): Pick<Redis, 'eval'>` re-uses ioredis' own (overloaded) `eval`
 * type so the production call site type-checks identically and a `jest.Mock`
 * double stays assignable in tests.
 */
export interface RateLimitRedisPort {
  getClient(): Pick<Redis, 'eval'>;
  deletePattern(pattern: string): Promise<number>;
}

/**
 * Lua script executed atomically on the Redis server.
 *
 * WHY Lua instead of GET→parse→SET: a read-modify-write round-trip lets two
 * concurrent requests read the same count and both pass the limit — the race
 * fires exactly under the burst conditions limiting exists for. INCR +
 * conditional PEXPIRE inside one script is a single atomic step, and PTTL in
 * the same script returns the authoritative reset time with no second
 * round-trip.
 */
const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
return {current, pttl}
`;

/**
 * Distributed counting store — the production backend for the platform
 * rate-limit guard. Counters live in Redis so every replica enforces ONE
 * shared window per key.
 */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly logger = new Logger(RedisRateLimitStore.name);
  private healthy = true;

  constructor(
    private readonly redisService: RateLimitRedisPort,
    /** Key namespace; combined with the service-level Redis keyPrefix. */
    private readonly keyPrefix = 'ratelimit:',
  ) {}

  async incrementOrCreate(key: string, windowMs: number): Promise<RateLimitIncrementResult> {
    try {
      // WHY getClient(): eval is an "advanced operation" by RedisService's
      // own contract — the sanctioned escape hatch for atomic scripts.
      const result = (await this.redisService
        .getClient()
        .eval(INCREMENT_SCRIPT, 1, this.keyPrefix + key, windowMs.toString())) as [
        number,
        number,
      ];

      this.healthy = true;
      const [count, pttl] = result;
      return {
        entry: { count, resetTime: Date.now() + pttl },
        isNew: count === 1,
      };
    } catch (error) {
      // WHY mark-unhealthy-and-rethrow: the GUARD owns the fail-open/closed
      // policy decision; the store's job is to report truthfully. Swallowing
      // here would silently disable limiting on every Redis hiccup.
      this.healthy = false;
      this.logger.error(
        `Rate-limit increment failed for key ${key}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async clear(): Promise<void> {
    await this.redisService.deletePattern(`${this.keyPrefix}*`);
  }

  destroy(): void {
    // Connection lifecycle belongs to RedisService.
  }
}
