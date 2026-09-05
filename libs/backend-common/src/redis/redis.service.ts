import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export interface RedisModuleOptions {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  /**
   * SEC-HIGH-108 (2026-08-23 scan №53): dedicated noeviction Redis for the
   * authorization namespace (jti blacklist, user epoch). When set, every
   * *Authorization* method routes to this client; unset, they share the
   * primary client (dev shape). Production deployments set this to the
   * redis-auth instance — an allkeys-lru eviction on the shared cache must
   * never resurrect a revoked token.
   */
  authorizationUrl?: string;
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
 * One key of a split `mgetScoped` fetch: the fully-resolved Redis key and the
 * position it occupies in the caller's argument order, so the two client
 * round trips can be reassembled without re-indexing the input.
 */
interface ScopedFetchEntry {
  readonly position: number;
  readonly key: string;
}

/**
 * Redis Service
 * Provides Redis connection and operations for the platform
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private readonly keyPrefix: string;

  private readonly authClient: Redis | null;

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

    // SEC-HIGH-108 (№53): dedicated noeviction instance for authorization
    // state; when unset, authorization shares the primary client (dev).
    if (options.authorizationUrl) {
      const isAuthTls = options.authorizationUrl.startsWith('rediss://');
      this.authClient = new Redis(
        options.authorizationUrl,
        isAuthTls ? { tls: { rejectUnauthorized: false } } : {},
      );
      this.authClient.on('error', (err) => {
        this.logger.error('Redis AUTH connection error', err);
      });
    } else {
      this.authClient = null;
    }
  }

  /** Client that owns the authorization namespace (dedicated or primary). */
  private authorizationClient(): Redis {
    return this.authClient ?? this.client;
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
    // SEC-HIGH-108 (№53): authorization namespace lives on the dedicated
    // noeviction client when configured. Mirrors setAtKey's
    // SETEX-vs-SET branching on the routed client.
    if (ttlSeconds) {
      await this.authorizationClient().setex(
        `${AUTHORIZATION_REDIS_KEY_PREFIX}${key}`,
        ttlSeconds,
        value,
      );
    } else {
      await this.authorizationClient().set(`${AUTHORIZATION_REDIS_KEY_PREFIX}${key}`, value);
    }
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
    // SEC-HIGH-108 (№53): dedicated noeviction client when configured.
    return this.setAuthorizationMaxSafeIntegerAtClient(
      this.authorizationClient(),
      `${AUTHORIZATION_REDIS_KEY_PREFIX}${key}`,
      value,
      ttlSeconds,
    );
  }

  private async setAuthorizationMaxSafeIntegerAtClient(
    client: Redis,
    physicalKey: string,
    value: number,
    ttlSeconds: number,
  ): Promise<number> {
    this.assertMaxSafeIntegerInputs(value, ttlSeconds);
    // SEC-HIGH-108 (№53): same monotonic-max Lua as setMaxSafeIntegerAtKey,
    // routed to the caller-provided (authorization) client so the value
    // lives on the noeviction instance when one is configured.
    return this.evalMaxSafeInteger(client, physicalKey, value, ttlSeconds);
  }

  private async setMaxSafeIntegerAtKey(
    physicalKey: string,
    value: number,
    ttlSeconds: number,
  ): Promise<number> {
    this.assertMaxSafeIntegerInputs(value, ttlSeconds);
    return this.evalMaxSafeInteger(this.client, physicalKey, value, ttlSeconds);
  }

  /** Shared input guard for the max-safe-integer writers. */
  private assertMaxSafeIntegerInputs(value: number, ttlSeconds: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError('value must be a positive safe integer');
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError('ttlSeconds must be a positive safe integer');
    }
  }

  /** Shared monotonic-max SET-with-EX Lua (SSoT for both client routes). */
  private async evalMaxSafeInteger(
    client: Redis,
    physicalKey: string,
    value: number,
    ttlSeconds: number,
  ): Promise<number> {
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
    const result = await client.eval(script, 1, physicalKey, String(value), String(ttlSeconds));
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
    // SEC-HIGH-108 (№53): dedicated noeviction client when configured.
    return this.authorizationClient().get(`${AUTHORIZATION_REDIS_KEY_PREFIX}${key}`);
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

  /**
   * Read explicitly-scoped keys in one ordered Redis round trip.
   *
   * SEC-HIGH-108 (№53): authorization-scoped entries route to the dedicated
   * noeviction client when one is configured; the result order still matches
   * the input key order (split-fetch then reassemble).
   */
  async mgetScoped(...keys: RedisScopedKey[]): Promise<(string | null)[]> {
    if (keys.length === 0) {
      return [];
    }
    if (!this.authClient) {
      return this.client.mget(...keys.map((key) => this.scopedKey(key)));
    }
    // Each entry carries its own resolved key and the caller-visible position it
    // must land in, so neither the split nor the reassembly indexes back into
    // `keys` — the reason the previous shape needed non-null assertions.
    const results: (string | null)[] = Array.from({ length: keys.length }, () => null);
    const primary: ScopedFetchEntry[] = [];
    const authorization: ScopedFetchEntry[] = [];
    for (const [position, key] of keys.entries()) {
      const bucket = key.scope === 'authorization' ? authorization : primary;
      bucket.push({ position, key: this.scopedKey(key) });
    }
    const fetch = async (entries: ScopedFetchEntry[], client: Redis): Promise<void> => {
      if (entries.length === 0) return;
      const values = await client.mget(...entries.map((entry) => entry.key));
      entries.forEach((entry, offset) => {
        results[entry.position] = values[offset] ?? null;
      });
    };
    await Promise.all([fetch(primary, this.client), fetch(authorization, this.authClient)]);
    return results;
  }

  /**
   * Delete a key
   */
  async del(key: string): Promise<number> {
    return this.client.del(this.prefixKey(key));
  }

  /**
   * Atomically return a key's value and delete it (Redis GETDEL, 6.2+).
   *
   * Single-use token consumption (WebAuthn challenges, one-time codes):
   * a separate GET + DEL pair lets two concurrent ceremonies both observe
   * the stored value — GETDEL makes single-use structurally guaranteed.
   */
  async getdel(key: string): Promise<string | null> {
    return this.client.getdel(this.prefixKey(key));
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

    // Remove prefix from returned keys
    return allKeys.map((k) => k.slice(this.keyPrefix.length));
  }

  /**
   * Delete all keys matching a pattern using cursor-based SCAN
   * with batched DEL. Non-blocking alternative to KEYS + DEL.
   */
  async deletePattern(pattern: string): Promise<number> {
    const prefixedPattern = this.prefixKey(pattern);
    let cursor = '0';
    let totalDeleted = 0;

    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        prefixedPattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        const deleted = await this.client.del(...keys);
        totalDeleted += deleted;
      }
    } while (cursor !== '0');

    return totalDeleted;
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
