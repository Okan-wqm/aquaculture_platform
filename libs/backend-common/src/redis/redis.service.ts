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
      this.client = new Redis(options.url, isTls ? {
        tls: { rejectUnauthorized: false },
      } : {});
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

  async onModuleDestroy() {
    await this.client.quit();
  }

  /**
   * Get prefixed key
   */
  private prefixKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Set a value with optional TTL (in seconds)
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const prefixedKey = this.prefixKey(key);
    if (ttlSeconds) {
      await this.client.setex(prefixedKey, ttlSeconds, value);
    } else {
      await this.client.set(prefixedKey, value);
    }
  }

  /**
   * Get a value
   */
  async get(key: string): Promise<string | null> {
    return this.client.get(this.prefixKey(key));
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
   * The prefix every key written through this service carries.
   *
   * Exposed because a caller reaching for `getClient()` — to run a command this
   * service does not wrap, such as `MEMORY USAGE` or `OBJECT IDLETIME` — must
   * prefix the key itself or address a different key than `get`/`set` would.
   * Re-deriving `${serviceName}:` at the callsite would be a second author for
   * the namespace, and the two would drift the first time the convention moved.
   */
  getKeyPrefix(): string {
    return this.keyPrefix;
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
    const result = await (this.client.scan as (cursor: string, match: string, pattern: string, count: string, limit: number) => Promise<[string, string[]]>)(
      '0', 'MATCH', pattern, 'COUNT', count ?? 100,
    );
    return result[1];
  }
}
