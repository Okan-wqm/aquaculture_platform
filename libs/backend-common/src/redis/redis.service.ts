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
    this.keyPrefix = options.keyPrefix || 'aqua:';

    if (options.url) {
      this.client = new Redis(options.url);
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
   * Get all keys matching a pattern
   */
  async keys(pattern: string): Promise<string[]> {
    const prefixedPattern = this.prefixKey(pattern);
    const keys = await this.client.keys(prefixedPattern);
    // Remove prefix from returned keys
    return keys.map((k) => k.slice(this.keyPrefix.length));
  }

  /**
   * Delete all keys matching a pattern
   */
  async deletePattern(pattern: string): Promise<number> {
    const keys = await this.keys(pattern);
    if (keys.length === 0) return 0;
    return this.client.del(...keys.map((k) => this.prefixKey(k)));
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
   * Decrement a value
   */
  async decr(key: string): Promise<number> {
    return this.client.decr(this.prefixKey(key));
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
}
