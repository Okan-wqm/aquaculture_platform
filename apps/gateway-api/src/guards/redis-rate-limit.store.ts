import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@aquaculture/backend-common';
import { RateLimitStore } from './rate-limit.guard';

/**
 * Rate limit entry
 */
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * Redis-based rate limit store for distributed deployments
 * Uses Redis for atomic operations and automatic TTL-based cleanup
 */
@Injectable()
export class RedisRateLimitStore implements RateLimitStore {
  private readonly logger = new Logger(RedisRateLimitStore.name);
  private readonly keyPrefix = 'ratelimit:';

  constructor(private readonly redisService: RedisService) {}

  async get(key: string): Promise<RateLimitEntry | null> {
    try {
      const data = await this.redisService.get(this.keyPrefix + key);
      if (!data) return null;

      const entry = JSON.parse(data) as RateLimitEntry;

      // Check if expired
      if (Date.now() > entry.resetTime) {
        await this.redisService.del(this.keyPrefix + key);
        return null;
      }

      return entry;
    } catch (error) {
      this.logger.error(`Failed to get rate limit entry: ${error}`);
      return null;
    }
  }

  async set(key: string, entry: RateLimitEntry, ttlMs: number): Promise<void> {
    try {
      const ttlSeconds = Math.ceil(ttlMs / 1000);
      await this.redisService.set(
        this.keyPrefix + key,
        JSON.stringify(entry),
        ttlSeconds,
      );
    } catch (error) {
      this.logger.error(`Failed to set rate limit entry: ${error}`);
    }
  }

  async increment(key: string): Promise<number> {
    try {
      const prefixedKey = this.keyPrefix + key;
      const count = await this.redisService.incr(prefixedKey);
      return count;
    } catch (error) {
      this.logger.error(`Failed to increment rate limit: ${error}`);
      return 1;
    }
  }

  /**
   * Atomic increment-or-create operation
   * SECURITY: Uses Redis INCR + PEXPIRE for true atomicity under concurrent load.
   * The previous GET-then-SET approach allowed race conditions where N parallel
   * requests could all read the same pre-increment count and be counted as 1.
   */
  async incrementOrCreate(
    key: string,
    windowMs: number,
  ): Promise<{ entry: RateLimitEntry; isNew: boolean }> {
    try {
      const prefixedKey = this.keyPrefix + key;
      const now = Date.now();

      // SECURITY: Atomic INCR -- Redis INCR is atomic and creates the key if
      // it doesn't exist, returning 1 on first call. This eliminates the
      // GET-then-SET race condition entirely.
      const count = await this.redisService.incr(prefixedKey);
      const isNew = count === 1;

      if (isNew) {
        // Set expiry only on first increment (new window)
        const ttlSeconds = Math.ceil(windowMs / 1000);
        await this.redisService.expire(prefixedKey, ttlSeconds);
      }

      const entry: RateLimitEntry = {
        count,
        resetTime: now + windowMs,
      };

      return { entry, isNew };
    } catch (error) {
      this.logger.error(`Failed to incrementOrCreate rate limit: ${error}`);
      // Return a default entry to allow the request through on error
      // The guard will handle fail-closed behavior
      return {
        entry: { count: 1, resetTime: Date.now() + windowMs },
        isNew: true,
      };
    }
  }

  /**
   * Check if Redis connection is healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      // Try a simple ping operation
      await this.redisService.get('_health_check');
      return true;
    } catch (error) {
      this.logger.error(`Redis health check failed: ${error}`);
      return false;
    }
  }
}
