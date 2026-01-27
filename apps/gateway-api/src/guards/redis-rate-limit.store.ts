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
}
