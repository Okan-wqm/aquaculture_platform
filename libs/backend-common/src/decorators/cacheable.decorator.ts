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

import { RedisService } from '../redis/redis.service';

/**
 * Interface for Redis cache service operations.
 * Uses Pick<RedisService, ...> to stay in sync with the actual RedisService signature
 * and avoid return-type drift (e.g. del returns Promise<number>, not Promise<void>).
 */
type RedisCacheService = Pick<RedisService, 'getJson' | 'setJson' | 'del' | 'deletePattern'>;

/**
 * Interface for services that support caching
 */
interface CacheableService {
  redisService?: RedisCacheService;
  redis?: RedisCacheService;
  cacheService?: RedisCacheService;
}

type CacheMethod = (this: CacheableService, ...args: unknown[]) => unknown;

type CacheMethodDecorator = (
  target: object,
  propertyKey: string | symbol,
  descriptor: PropertyDescriptor,
) => PropertyDescriptor;

/**
 * Get Redis service from a cacheable service instance
 */
function getRedisService(instance: CacheableService): RedisCacheService | undefined {
  return instance.redisService || instance.redis || instance.cacheService;
}

function getCacheMethod(descriptor: PropertyDescriptor, decoratorName: string): CacheMethod {
  const candidate: unknown = descriptor.value;
  if (typeof candidate !== 'function') {
    throw new TypeError(`${decoratorName} can only decorate methods`);
  }
  return candidate as CacheMethod;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function cacheKeyScalar(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
    default:
      return undefined;
  }
}

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

/** Track classes that have already emitted the missing-Redis warning */
const warnedClasses = new Set<string>();

/** Track key patterns that have already emitted the missing-tenant-namespace warning */
const warnedTenantKeys = new Set<string>();

/**
 * Prefixes that are exempt from tenant namespace validation.
 * These are legitimate cross-tenant or system-wide cache keys.
 */
const TENANT_EXEMPT_PREFIXES = ['system:', 'global:'];

/**
 * Check if a cache key includes a tenant namespace.
 * Keys should contain 'tenant:' to indicate proper tenant scoping.
 * Keys starting with "system:" or "global:" are exempt.
 */
function validateTenantKeyPattern(
  cacheKey: string,
  keyPattern: string,
  className: string,
  methodName: string,
): void {
  // Skip validation for exempt prefixes
  if (TENANT_EXEMPT_PREFIXES.some((prefix) => cacheKey.startsWith(prefix))) {
    return;
  }

  // Check if key contains tenant namespace
  if (!cacheKey.includes('tenant:') && !cacheKey.includes('tenant_')) {
    const warnKey = `${className}.${methodName}`;
    if (!warnedTenantKeys.has(warnKey)) {
      warnedTenantKeys.add(warnKey);
      logger.warn(
        `Cache key "${cacheKey}" in ${className}.${methodName} is missing tenant namespace. ` +
          `Multi-tenant cache keys should include "tenant:{tenantId}:" prefix to prevent cross-tenant data leakage. ` +
          `If this is intentionally global, prefix with "system:" or "global:".`,
      );
    }
  }
}

/**
 * Interpolate cache key pattern with method arguments
 * Pattern: "prefix:{0}:{1}" where {0}, {1} are argument indices
 *
 * Also supports object property access: "prefix:{0.tenantId}:{0.batchId}"
 */
function interpolateKey(pattern: string, args: unknown[]): string {
  return pattern.replace(
    /\{(\d+)(?:\.(\w+))?\}/g,
    (_match: string, index: string, prop: string | undefined): string => {
      const argIndex = Number.parseInt(index, 10);
      const arg = args[argIndex];

      if (arg === undefined || arg === null) {
        return 'null';
      }

      if (prop && typeof arg === 'object') {
        const value = (arg as Record<string, unknown>)[prop];
        return cacheKeyScalar(value) ?? 'null';
      }

      // For objects without property access, use JSON hash or id
      if (typeof arg === 'object') {
        const obj = arg as Record<string, unknown>;
        // Try common ID fields first
        const id = cacheKeyScalar(obj['id']);
        if (id !== undefined) return id;
        const tenantId = cacheKeyScalar(obj['tenantId']);
        if (tenantId !== undefined) return tenantId;
        // Fallback to JSON hash (first 16 chars)
        return (JSON.stringify(arg) ?? 'null').substring(0, 16);
      }

      return cacheKeyScalar(arg) ?? 'null';
    },
  );
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
  ttlSeconds = 3600,
  options: CacheableOptions = {},
): CacheMethodDecorator {
  return function (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const originalMethod = getCacheMethod(descriptor, '@Cacheable');
    const className = target.constructor.name;
    const methodName = String(propertyKey);

    descriptor.value = async function (
      this: CacheableService,
      ...args: unknown[]
    ): Promise<unknown> {
      // Get RedisService from the class instance
      const redisService = getRedisService(this);

      // If no Redis service, just execute the method
      if (!redisService) {
        // Emit warning once per class (not per call) regardless of debug mode
        if (!warnedClasses.has(className)) {
          warnedClasses.add(className);
          logger.warn(
            `No RedisService found in ${className}. @Cacheable will execute without caching. ` +
              `Ensure the service injects RedisService as 'redisService', 'redis', or 'cacheService'.`,
          );
        }
        return await originalMethod.apply(this, args);
      }

      // Generate cache key
      const cacheKey = options.keyGenerator
        ? options.keyGenerator(...args)
        : interpolateKey(keyPattern, args);

      // Runtime validation: warn if cache key doesn't include tenant namespace
      validateTenantKeyPattern(cacheKey, keyPattern, className, methodName);

      try {
        // Try to get from cache
        const cached = await redisService.getJson<unknown>(cacheKey);

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
        logger.warn(`Cache read error for ${cacheKey}: ${toError(err).message}`);
      }

      // Execute original method
      const result: unknown = await originalMethod.apply(this, args);

      // Cache the result if it shouldn't be skipped
      const shouldSkip = options.skipCache ? options.skipCache(result) : false;

      if (!shouldSkip && result !== undefined) {
        try {
          await redisService.setJson(cacheKey, result, ttlSeconds);

          if (options.debug) {
            logger.debug(`Cached: ${cacheKey} (TTL: ${ttlSeconds}s)`);
          }
        } catch (err) {
          logger.warn(`Cache write error for ${cacheKey}: ${toError(err).message}`);
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
export function CacheInvalidate(keyPattern: string): CacheMethodDecorator {
  return function (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const originalMethod = getCacheMethod(descriptor, '@CacheInvalidate');

    descriptor.value = async function (
      this: CacheableService,
      ...args: unknown[]
    ): Promise<unknown> {
      // Execute original method first
      const result: unknown = await originalMethod.apply(this, args);

      // Get RedisService from the class instance
      const redisService = getRedisService(this);

      if (redisService) {
        const cacheKey = interpolateKey(keyPattern, args);
        try {
          await redisService.del(cacheKey);
          logger.debug(`Cache invalidated: ${cacheKey}`);
        } catch (err) {
          logger.warn(`Cache invalidation error for ${cacheKey}: ${toError(err).message}`);
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
export function CacheInvalidatePattern(keyPattern: string): CacheMethodDecorator {
  return function (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const originalMethod = getCacheMethod(descriptor, '@CacheInvalidatePattern');

    descriptor.value = async function (
      this: CacheableService,
      ...args: unknown[]
    ): Promise<unknown> {
      // Execute original method first
      const result: unknown = await originalMethod.apply(this, args);

      // Get RedisService from the class instance
      const redisService = getRedisService(this);

      if (redisService?.deletePattern) {
        const pattern = interpolateKey(keyPattern, args);
        try {
          const count = await redisService.deletePattern(pattern);
          logger.debug(`Cache pattern invalidated: ${pattern} (${count} keys)`);
        } catch (err) {
          logger.warn(`Cache pattern invalidation error: ${toError(err).message}`);
        }
      }

      return result;
    };

    return descriptor;
  };
}
