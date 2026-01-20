/**
 * Cacheable Decorator
 *
 * Method decorator for Redis caching with automatic key generation and TTL.
 * Works with async methods that return JSON-serializable data.
 *
 * Usage:
 * ```typescript
 * @Injectable()
 * class MyService {
 *   constructor(private redisService: RedisService) {}
 *
 *   @Cacheable('user:{0}', 3600) // Cache key uses first argument, 1 hour TTL
 *   async getUser(userId: string): Promise<User> {
 *     return this.userRepository.findOne(userId);
 *   }
 *
 *   @Cacheable('tenant:{0}:stats', 1800, { skipCache: (result) => !result })
 *   async getTenantStats(tenantId: string): Promise<Stats | null> {
 *     return this.computeStats(tenantId);
 *   }
 * }
 * ```
 */

import { Logger } from '@nestjs/common';

export interface CacheableOptions {
  /**
   * Skip caching if this function returns true
   * Useful for not caching null/empty results
   */
  skipCache?: (result: unknown) => boolean;

  /**
   * Custom key generator function
   * If provided, overrides the keyPattern
   */
  keyGenerator?: (...args: unknown[]) => string;

  /**
   * Log cache hits/misses (default: false)
   */
  debug?: boolean;
}

const logger = new Logger('Cacheable');

/**
 * Interpolate cache key pattern with method arguments
 * Pattern: "prefix:{0}:{1}" where {0}, {1} are argument indices
 *
 * Also supports object property access: "prefix:{0.tenantId}:{0.batchId}"
 */
function interpolateKey(pattern: string, args: unknown[]): string {
  return pattern.replace(/\{(\d+)(?:\.(\w+))?\}/g, (_, index, prop) => {
    const argIndex = parseInt(index, 10);
    const arg = args[argIndex];

    if (arg === undefined || arg === null) {
      return 'null';
    }

    if (prop && typeof arg === 'object') {
      const value = (arg as Record<string, unknown>)[prop];
      return value !== undefined && value !== null ? String(value) : 'null';
    }

    // For objects without property access, use JSON hash or id
    if (typeof arg === 'object') {
      const obj = arg as Record<string, unknown>;
      // Try common ID fields first
      if (obj.id) return String(obj.id);
      if (obj.tenantId) return String(obj.tenantId);
      // Fallback to JSON hash (first 16 chars)
      return JSON.stringify(arg).substring(0, 16);
    }

    return String(arg);
  });
}

/**
 * Cacheable method decorator
 *
 * @param keyPattern - Cache key pattern with argument placeholders
 * @param ttlSeconds - Time to live in seconds (default: 3600 = 1 hour)
 * @param options - Additional options
 */
export function Cacheable(
  keyPattern: string,
  ttlSeconds: number = 3600,
  options: CacheableOptions = {},
) {
  return function (
    target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;
    const className = target.constructor.name;

    descriptor.value = async function (...args: unknown[]) {
      // Get RedisService from the class instance
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      const redisService = self.redisService || self.redis || self.cacheService;

      // If no Redis service, just execute the method
      if (!redisService || typeof redisService.getJson !== 'function') {
        if (options.debug) {
          logger.warn(`No RedisService found in ${className}, skipping cache`);
        }
        return originalMethod.apply(this, args);
      }

      // Generate cache key
      const cacheKey = options.keyGenerator
        ? options.keyGenerator(...args)
        : interpolateKey(keyPattern, args);

      try {
        // Try to get from cache
        const cached = await redisService.getJson(cacheKey);

        if (cached !== null) {
          if (options.debug) {
            logger.debug(`Cache HIT: ${cacheKey}`);
          }
          return cached;
        }

        if (options.debug) {
          logger.debug(`Cache MISS: ${cacheKey}`);
        }
      } catch (err) {
        logger.warn(`Cache read error for ${cacheKey}: ${(err as Error).message}`);
      }

      // Execute original method
      const result = await originalMethod.apply(this, args);

      // Cache the result if it shouldn't be skipped
      const shouldSkip = options.skipCache ? options.skipCache(result) : false;

      if (!shouldSkip && result !== undefined) {
        try {
          await redisService.setJson(cacheKey, result, ttlSeconds);

          if (options.debug) {
            logger.debug(`Cached: ${cacheKey} (TTL: ${ttlSeconds}s)`);
          }
        } catch (err) {
          logger.warn(`Cache write error for ${cacheKey}: ${(err as Error).message}`);
        }
      }

      return result;
    };

    return descriptor;
  };
}

/**
 * Cache invalidation decorator
 * Clears cache entries matching the pattern after method execution
 *
 * Usage:
 * ```typescript
 * @CacheInvalidate('user:{0}')
 * async updateUser(userId: string, data: UpdateUserDto): Promise<User> {
 *   return this.userRepository.update(userId, data);
 * }
 * ```
 */
export function CacheInvalidate(keyPattern: string) {
  return function (
    target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;
    const className = target.constructor.name;

    descriptor.value = async function (...args: unknown[]) {
      // Execute original method first
      const result = await originalMethod.apply(this, args);

      // Get RedisService from the class instance
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      const redisService = self.redisService || self.redis || self.cacheService;

      if (redisService && typeof redisService.del === 'function') {
        const cacheKey = interpolateKey(keyPattern, args);
        try {
          await redisService.del(cacheKey);
          logger.debug(`Cache invalidated: ${cacheKey}`);
        } catch (err) {
          logger.warn(`Cache invalidation error for ${cacheKey}: ${(err as Error).message}`);
        }
      }

      return result;
    };

    return descriptor;
  };
}

/**
 * Cache invalidation decorator with pattern matching
 * Clears all cache entries matching the wildcard pattern
 *
 * Usage:
 * ```typescript
 * @CacheInvalidatePattern('tenant:{0}:*')
 * async deleteTenant(tenantId: string): Promise<void> {
 *   await this.tenantRepository.delete(tenantId);
 * }
 * ```
 */
export function CacheInvalidatePattern(keyPattern: string) {
  return function (
    target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      // Execute original method first
      const result = await originalMethod.apply(this, args);

      // Get RedisService from the class instance
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      const redisService = self.redisService || self.redis || self.cacheService;

      if (redisService && typeof redisService.deletePattern === 'function') {
        const pattern = interpolateKey(keyPattern, args);
        try {
          const count = await redisService.deletePattern(pattern);
          logger.debug(`Cache pattern invalidated: ${pattern} (${count} keys)`);
        } catch (err) {
          logger.warn(`Cache pattern invalidation error: ${(err as Error).message}`);
        }
      }

      return result;
    };

    return descriptor;
  };
}
