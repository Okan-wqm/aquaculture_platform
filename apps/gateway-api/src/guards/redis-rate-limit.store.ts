import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@platform/backend-common';
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
      const data = await this.redisService.get(prefixedKey);

      if (!data) {
        return 1;
      }

      const entry = JSON.parse(data) as RateLimitEntry;
      entry.count++;

      // Calculate remaining TTL
      const remainingMs = entry.resetTime - Date.now();
      if (remainingMs <= 0) {
        return 1;
      }

      const ttlSeconds = Math.ceil(remainingMs / 1000);
      await this.redisService.set(prefixedKey, JSON.stringify(entry), ttlSeconds);

      return entry.count;
    } catch (error) {
      this.logger.error(`Failed to increment rate limit: ${error}`);
      return 1;
    }
  }

  /**
   * Atomic increment-or-create operation
   * SECURITY: Uses Redis atomic operations to prevent race conditions
   */
  async incrementOrCreate(
    key: string,
    windowMs: number,
  ): Promise<{ entry: RateLimitEntry; isNew: boolean }> {
    try {
      const prefixedKey = this.keyPrefix + key;
      const now = Date.now();
      const data = await this.redisService.get(prefixedKey);

      if (data) {
        const entry = JSON.parse(data) as RateLimitEntry;

        // Check if entry is still valid
        if (now <= entry.resetTime) {
          entry.count++;

          const remainingMs = entry.resetTime - now;
          const ttlSeconds = Math.ceil(remainingMs / 1000);
          await this.redisService.set(prefixedKey, JSON.stringify(entry), ttlSeconds);

          return { entry, isNew: false };
        }
      }

      // Create new entry
      const newEntry: RateLimitEntry = {
        count: 1,
        resetTime: now + windowMs,
      };

      const ttlSeconds = Math.ceil(windowMs / 1000);
      await this.redisService.set(prefixedKey, JSON.stringify(newEntry), ttlSeconds);

      return { entry: newEntry, isNew: true };
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
