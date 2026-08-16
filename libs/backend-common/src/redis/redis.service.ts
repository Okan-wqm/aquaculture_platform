import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export interface RedisModuleOptions {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}

export interface RedisPatternDeletionEvidenceV1 {
  readonly schemaVersion: 'redis-pattern-deletion-evidence.v1';
  readonly matchedKeys: readonly string[];
  readonly deletedCount: number;
}

/** Fixed namespace owned by auth-service for distributed revocation markers. */
export const AUTHORIZATION_REDIS_KEY_PREFIX = 'auth:';

export type RevokedTokenRedisKey = `token:blacklist:${string}`;
export type UserInvalidationRedisKey = `user_blacklist:${string}`;
export type AuthorizationRedisKey = RevokedTokenRedisKey | UserInvalidationRedisKey;

export type RedisScopedKey =
  | { scope: 'service'; key: string }
  | { scope: 'authorization'; key: AuthorizationRedisKey };

/**
 * Redis Service
 * Provides Redis connection and operations for the platform
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private readonly keyPrefix: string;

  constructor(options: RedisModuleOptions) {
    this.keyPrefix = options.keyPrefix ?? 'aqua:';

    if (options.url) {
      // IP-1: ioredis handles rediss:// URLs for TLS. For internal Docker
      // networks with self-signed certs, disable strict cert verification.
      const isTls = options.url.startsWith('rediss://');
      this.client = new Redis(
        options.url,
        isTls
          ? {
              tls: { rejectUnauthorized: false },
            }
          : {},
      );
    } else {
      this.client = new Redis({
        host: options.host || 'localhost',
        port: options.port || 6379,
        password: options.password,
        db: options.db || 0,
      });
    }

    this.client.on('connect', () => {
      this.logger.log('Connected to Redis');
    });

    this.client.on('error', (err) => {
      this.logger.error('Redis connection error', err);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  /**
   * Get prefixed key
   */
  private prefixKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Physical namespace owned by this service connection.
   *
   * Advanced atomic operations (for example the Lua-backed distributed rate
   * limiter) need to pass a physical key to Redis scripts. Keeping the prefix
   * readable here prevents callers from duplicating or guessing it.
   */
  getKeyPrefix(): string {
    return this.keyPrefix;
  }

  private scopedKey(key: RedisScopedKey): string {
    return key.scope === 'authorization'
      ? `${AUTHORIZATION_REDIS_KEY_PREFIX}${key.key}`
      : this.prefixKey(key.key);
  }

  /**
   * Set a value with optional TTL (in seconds)
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.setAtKey(this.prefixKey(key), value, ttlSeconds);
  }

  /** Write a marker into the fixed authorization-owned namespace. */
  async setAuthorization(
    key: AuthorizationRedisKey,
    value: string,
    ttlSeconds?: number,
  ): Promise<void> {
    await this.setAtKey(`${AUTHORIZATION_REDIS_KEY_PREFIX}${key}`, value, ttlSeconds);
  }

  private async setAtKey(physicalKey: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(physicalKey, ttlSeconds, value);
    } else {
      await this.client.set(physicalKey, value);
    }
  }

  /** Atomically retain the greatest positive safe integer at a service-local key. */
  async setMaxSafeInteger(key: string, value: number, ttlSeconds: number): Promise<number> {
    return this.setMaxSafeIntegerAtKey(this.prefixKey(key), value, ttlSeconds);
  }

  /** Authorization-scoped max-only writer for user invalidation epochs. */
  async setAuthorizationMaxSafeInteger(
    key: UserInvalidationRedisKey,
    value: number,
    ttlSeconds: number,
  ): Promise<number> {
    return this.setMaxSafeIntegerAtKey(
      `${AUTHORIZATION_REDIS_KEY_PREFIX}${key}`,
      value,
      ttlSeconds,
    );
  }

  private async setMaxSafeIntegerAtKey(
    physicalKey: string,
    value: number,
    ttlSeconds: number,
  ): Promise<number> {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError('value must be a positive safe integer');
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError('ttlSeconds must be a positive safe integer');
    }

    const script = `
local current = redis.call('GET', KEYS[1])
if current then
  if not string.match(current, '^[1-9][0-9]*$') then
    return redis.error_reply('EXISTING_VALUE_NOT_POSITIVE_INTEGER')
  end
  if string.len(current) > 16 or
     (string.len(current) == 16 and current > '9007199254740991') then
    return redis.error_reply('EXISTING_VALUE_NOT_SAFE_INTEGER')
  end
  local current_number = tonumber(current)
  if current_number >= tonumber(ARGV[1]) then
    return current_number
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return tonumber(ARGV[1])
`;
    const result: unknown = await this.client.eval(
      script,
      1,
      physicalKey,
      String(value),
      String(ttlSeconds),
    );
    if (typeof result !== 'number' || !Number.isSafeInteger(result) || result <= 0) {
      throw new Error('Redis returned an invalid max-integer result');
    }
    return result;
  }

  /**
   * Get a value
   */
  async get(key: string): Promise<string | null> {
    return this.client.get(this.prefixKey(key));
  }

  /** Read a key from the fixed authorization-owned namespace. */
  async getAuthorization(key: AuthorizationRedisKey): Promise<string | null> {
    return this.client.get(`${AUTHORIZATION_REDIS_KEY_PREFIX}${key}`);
  }

  /**
   * Multi-get: fetch several keys in ONE round-trip. Applies the same key
   * prefix as get() to EVERY key (PERF-HIGH-002) — callers MUST use this rather
   * than reaching getClient().mget(), which would read un-prefixed keys, miss
   * every entry, and silently fail (a fail-open hazard on the auth hot path).
   * Result order matches the input key order (ioredis MGET preserves order).
   */
  async mget(...keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) {
      return [];
    }
    return this.client.mget(...keys.map((key) => this.prefixKey(key)));
  }

  /** Read explicitly-scoped keys in one ordered Redis round trip. */
  async mgetScoped(...keys: RedisScopedKey[]): Promise<(string | null)[]> {
    if (keys.length === 0) {
      return [];
    }
    return this.client.mget(...keys.map((key) => this.scopedKey(key)));
  }

  /**
   * Delete a key
   */
  async del(key: string): Promise<number> {
    return this.client.del(this.prefixKey(key));
  }

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(this.prefixKey(key));
    return result === 1;
  }

  /**
   * Set a JSON value
   */
  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  /**
   * Get a JSON value
   */
  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  /**
   * Get all keys matching a pattern using SCAN (non-blocking).
   * Prefer scanKeys() for large datasets; this method collects all results.
   */
  async keys(pattern: string): Promise<string[]> {
    const prefixedPattern = this.prefixKey(pattern);
    const allKeys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        prefixedPattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      allKeys.push(...keys);
    } while (cursor !== '0');

    // SCAN may return a key more than once while the keyspace changes. Expose
    // one canonical logical-key set so mutation receipts and bounded deletes
    // never claim duplicate authorities for the same physical key.
    return [...new Set(allKeys.map((key) => key.slice(this.keyPrefix.length)))].sort();
  }

  /**
   * Delete all keys matching a pattern using cursor-based SCAN
   * with batched DEL. Non-blocking alternative to KEYS + DEL.
   */
  async deletePattern(pattern: string): Promise<number> {
    return (await this.deletePatternWithEvidence(pattern)).deletedCount;
  }

  /**
   * Discover first, then delete the exact discovered logical keys in bounded
   * batches. Deleting while advancing a SCAN cursor can skip entries as the key
   * table changes; this two-phase adapter preserves an inspectable mutation
   * set and keeps physical-prefix construction inside RedisService.
   */
  async deletePatternWithEvidence(pattern: string): Promise<RedisPatternDeletionEvidenceV1> {
    const matchedKeys = Object.freeze(await this.keys(pattern));
    let deletedCount = 0;
    for (let offset = 0; offset < matchedKeys.length; offset += 100) {
      const batch = matchedKeys.slice(offset, offset + 100);
      if (batch.length > 0) {
        deletedCount += await this.client.del(...batch.map((key) => this.prefixKey(key)));
      }
    }
    return Object.freeze({
      schemaVersion: 'redis-pattern-deletion-evidence.v1',
      matchedKeys,
      deletedCount,
    });
  }

  /** Namespace-aware metadata primitives for inspection adapters. */
  async type(key: string): Promise<string> {
    return this.client.type(this.prefixKey(key));
  }

  async memoryUsage(key: string): Promise<number | null> {
    const usage = await this.client.memory('USAGE', this.prefixKey(key));
    return typeof usage === 'number' ? usage : null;
  }

  async objectIdleTime(key: string): Promise<number | null> {
    const idle = await this.client.object('IDLETIME', this.prefixKey(key));
    return typeof idle === 'number' ? idle : null;
  }

  async info(section: 'memory' | 'stats'): Promise<string> {
    return this.client.info(section);
  }

  async dbsize(): Promise<number> {
    return this.client.dbsize();
  }

  /**
   * Set expiry on a key
   */
  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.expire(this.prefixKey(key), ttlSeconds);
    return result === 1;
  }

  /**
   * Get TTL for a key
   */
  async ttl(key: string): Promise<number> {
    return this.client.ttl(this.prefixKey(key));
  }

  /**
   * Hash set
   */
  async hset(key: string, field: string, value: string): Promise<number> {
    return this.client.hset(this.prefixKey(key), field, value);
  }

  /**
   * Hash get
   */
  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(this.prefixKey(key), field);
  }

  /**
   * Hash get all
   */
  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(this.prefixKey(key));
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    return this.client.rpush(this.prefixKey(key), ...values);
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    return this.client.ltrim(this.prefixKey(key), start, stop);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(this.prefixKey(key), start, stop);
  }

  /**
   * Hash delete
   */
  async hdel(key: string, ...fields: string[]): Promise<number> {
    return this.client.hdel(this.prefixKey(key), ...fields);
  }

  /**
   * Increment a value
   */
  async incr(key: string): Promise<number> {
    return this.client.incr(this.prefixKey(key));
  }

  /**
   * Increment a value by a given amount
   */
  async incrby(key: string, increment: number): Promise<number> {
    return this.client.incrby(this.prefixKey(key), increment);
  }

  /**
   * Decrement a value
   */
  async decr(key: string): Promise<number> {
    return this.client.decr(this.prefixKey(key));
  }

  /**
   * Atomically set a key only if it does not already exist, with an expiry.
   * Uses Redis SET NX EX which is a single atomic command – no race window.
   * Returns true if the key was set (lock acquired), false if it already existed.
   */
  async setNx(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    const prefixedKey = this.prefixKey(key);
    let result: string | null;
    if (ttlSeconds && ttlSeconds > 0) {
      result = await this.client.set(prefixedKey, value, 'EX', ttlSeconds, 'NX');
    } else {
      result = await this.client.set(prefixedKey, value, 'NX');
    }
    return result === 'OK';
  }

  /**
   * Get underlying Redis client for advanced operations
   */
  getClient(): Redis {
    return this.client;
  }

  /**
   * Check if Redis is connected
   */
  isConnected(): boolean {
    return this.client.status === 'ready';
  }

  /**
   * Ping Redis to check health
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(this.prefixKey(key));
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.client.sadd(this.prefixKey(key), ...members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return this.client.srem(this.prefixKey(key), ...members);
  }

  async scan(pattern: string, count?: number): Promise<string[]> {
    // ioredis SCAN overloads require const literal tokens; cast to satisfy TypeScript
    const result = await (
      this.client.scan as (
        cursor: string,
        match: string,
        pattern: string,
        count: string,
        limit: number,
      ) => Promise<[string, string[]]>
    )('0', 'MATCH', pattern, 'COUNT', count ?? 100);
    return result[1];
  }
}
