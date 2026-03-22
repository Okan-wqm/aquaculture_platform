import { RedisService } from './redis.service';

/**
 * UUID v4 validation regex
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * TenantRedisService
 *
 * Wraps RedisService and automatically prefixes all keys with `tenant:{tenantId}:`
 * to ensure strict tenant isolation in Redis. This prevents cross-tenant data
 * leakage through cache keys.
 *
 * Usage:
 * ```typescript
 * const tenantRedis = TenantRedisService.forTenant(redisService, tenantId);
 * await tenantRedis.set('cache:users', JSON.stringify(users), 3600);
 * // Actual Redis key: "tenant:{tenantId}:cache:users"
 * ```
 */
export class TenantRedisService {
  private readonly keyPrefix: string;

  private constructor(
    private readonly redis: RedisService,
    private readonly tenantId: string,
  ) {
    this.keyPrefix = `tenant:${tenantId}:`;
  }

  /**
   * Create a tenant-scoped Redis service.
   * Validates that tenantId is a valid UUID to prevent injection attacks.
   *
   * @param redis - The underlying RedisService instance
   * @param tenantId - Must be a valid UUID v4
   * @throws Error if tenantId is not a valid UUID
   */
  static forTenant(redis: RedisService, tenantId: string): TenantRedisService {
    if (!tenantId || typeof tenantId !== 'string' || !UUID_REGEX.test(tenantId)) {
      throw new Error(
        `tenantId must be a valid UUID, got: ${String(tenantId)}`,
      );
    }
    return new TenantRedisService(redis, tenantId);
  }

  /**
   * Get the tenant key prefix used by this instance.
   */
  getKeyPrefix(): string {
    return this.keyPrefix;
  }

  /**
   * Get the tenantId used by this instance.
   */
  getTenantId(): string {
    return this.tenantId;
  }

  /**
   * Prefix a key with the tenant namespace.
   */
  private prefixKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Get a value by tenant-scoped key.
   */
  async get(key: string): Promise<string | null> {
    return this.redis.get(this.prefixKey(key));
  }

  /**
   * Set a value with optional TTL (seconds), using tenant-scoped key.
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    return this.redis.set(this.prefixKey(key), value, ttlSeconds);
  }

  /**
   * Delete a tenant-scoped key.
   */
  async del(key: string): Promise<number> {
    return this.redis.del(this.prefixKey(key));
  }

  /**
   * Check if a tenant-scoped key exists.
   */
  async exists(key: string): Promise<boolean> {
    return this.redis.exists(this.prefixKey(key));
  }

  /**
   * Delete all tenant-scoped keys matching a pattern.
   */
  async deletePattern(pattern: string): Promise<number> {
    return this.redis.deletePattern(this.prefixKey(pattern));
  }

  /**
   * Hash set on a tenant-scoped key.
   */
  async hset(key: string, field: string, value: string): Promise<number> {
    return this.redis.hset(this.prefixKey(key), field, value);
  }

  /**
   * Hash get from a tenant-scoped key.
   */
  async hget(key: string, field: string): Promise<string | null> {
    return this.redis.hget(this.prefixKey(key), field);
  }

  /**
   * Hash delete from a tenant-scoped key.
   */
  async hdel(key: string, ...fields: string[]): Promise<number> {
    return this.redis.hdel(this.prefixKey(key), ...fields);
  }

  /**
   * Hash get all from a tenant-scoped key.
   */
  async hgetall(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(this.prefixKey(key));
  }
}
