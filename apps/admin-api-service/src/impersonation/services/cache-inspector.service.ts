import { RedisService } from '@aquaculture/backend-common/redis';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import {
  CacheKeyEntry,
  CacheKeyValue,
  CacheNamespaceListing,
  CacheStats,
} from './debug-tools-types';

/**
 * Cache Inspector — reads and clears the cache that actually exists.
 *
 * # What this replaced
 *
 * The previous version inspected `admin.cache_entries_snapshot`, a table whose
 * only writer was `POST /debug/cache/capture` — an endpoint nothing in the repo
 * has ever called. The table was structurally empty, and a daily cron deleted
 * rows older than a week from it, so the "cache inspector" listed a permanently
 * empty set while Redis sat one injection away.
 *
 * Two things followed from that. `getCacheStats` reported
 * `hitRate = totalHits / (totalHits + totalEntries)` — mixing hit counts with a
 * ROW COUNT, a formula with no meaning, rendered under the label "Hit Rate %".
 * And all three invalidation methods were bodies that logged
 * `[Cache] Invalidated key: …` and returned; `invalidateCachePattern` returned
 * a hard-coded 0. A SUPER_ADMIN clearing cache during an incident was told it
 * worked, the log recorded that it worked, and nothing was cleared.
 *
 * # Scope, stated rather than implied
 *
 * `RedisService` prefixes every key with its owning service's namespace
 * (`admin:`), so what this inspects and clears is admin-api's own cache — the
 * report cache, the rate-limit windows, the token blacklist. Instance-wide
 * counters (`INFO stats`) cannot be attributed to a namespace, so they are
 * returned under `instance` and never blended into a namespace figure. The
 * previous version's single "Hit Rate %" was exactly such a blend.
 *
 * # Fail closed
 *
 * Redis is registered in `optional` mode, so the client exists but may not be
 * connected. Every method here throws `ServiceUnavailableException` in that
 * case rather than returning zeros: a destructive control that silently does
 * nothing is the defect this file was rewritten to remove, and "0 keys cleared"
 * is indistinguishable from "cleared everything, there was nothing".
 */
@Injectable()
export class CacheInspectorService {
  private readonly logger = new Logger(CacheInspectorService.name);

  constructor(private readonly redis: RedisService) {}

  /** Keys matching `keyPattern` inside this service's namespace, with metadata. */
  async listEntries(keyPattern: string, limit: number): Promise<CacheNamespaceListing> {
    this.requireRedis();

    // `keys()` is SCAN-based and namespace-aware: it prefixes the pattern and
    // strips the prefix off what it returns, so callers see the key they wrote.
    const matched = await this.redis.keys(keyPattern);
    const keys = matched.slice(0, limit);

    const entries: CacheKeyEntry[] = [];
    for (const key of keys) {
      entries.push({
        key,
        type: await this.typeOf(key),
        ttlSeconds: await this.redis.ttl(key),
        sizeBytes: await this.sizeOf(key),
        idleSeconds: await this.idleSecondsOf(key),
      });
    }

    return {
      namespace: this.namespace(),
      entries,
      matchedCount: matched.length,
      truncated: matched.length > keys.length,
    };
  }

  /** One key's stored value, or null when the key does not exist. */
  async getEntry(key: string): Promise<CacheKeyValue | null> {
    this.requireRedis();

    const type = await this.typeOf(key);
    if (type === 'none') {
      return null;
    }

    return {
      key,
      type,
      ttlSeconds: await this.redis.ttl(key),
      sizeBytes: await this.sizeOf(key),
      // Only string values are returned verbatim. A hash or a list would need a
      // type-specific read, and rendering a partial view of one as "the value"
      // is the kind of half-truth this surface is being cured of.
      value: type === 'string' ? await this.redis.get(key) : null,
    };
  }

  /** Delete one key. Returns how many keys Redis actually removed: 0 or 1. */
  async invalidateKey(key: string): Promise<number> {
    this.requireRedis();
    const deleted = await this.redis.del(key);
    this.logger.log(
      `cache invalidate key=${key} deleted=${deleted} namespace=${this.namespace()}`,
    );
    return deleted;
  }

  /** Delete every key matching `pattern`. Returns the real count. */
  async invalidatePattern(pattern: string): Promise<number> {
    this.requireRedis();
    const deleted = await this.redis.deletePattern(pattern);
    this.logger.log(
      `cache invalidate pattern=${pattern} deleted=${deleted} namespace=${this.namespace()}`,
    );
    return deleted;
  }

  /**
   * Namespace key count plus the instance counters Redis itself keeps.
   *
   * The two are reported separately because they are different measurements:
   * `keysInNamespace` is this service's, `instance` is the whole Redis. Merging
   * them is how the previous version produced a hit rate that described nothing.
   */
  async getStats(): Promise<CacheStats> {
    this.requireRedis();

    const client = this.redis.getClient();
    const [statsInfo, memoryInfo] = await Promise.all([
      client.info('stats'),
      client.info('memory'),
    ]);

    const keyspaceHits = this.readInfoNumber(statsInfo, 'keyspace_hits');
    const keyspaceMisses = this.readInfoNumber(statsInfo, 'keyspace_misses');
    const lookups = keyspaceHits + keyspaceMisses;

    return {
      namespace: this.namespace(),
      keysInNamespace: (await this.redis.keys('*')).length,
      instance: {
        keyspaceHits,
        keyspaceMisses,
        // Null, not zero, when Redis has served no lookup since it started.
        // A rate over no observations is not 0% — it is unmeasured, and the
        // surface this replaced drew 100% miss rate out of exactly that.
        hitRatePercent: lookups === 0 ? null : Math.round((keyspaceHits / lookups) * 1000) / 10,
        usedMemoryBytes: this.readInfoNumber(memoryInfo, 'used_memory'),
        totalKeys: await client.dbsize(),
      },
    };
  }

  /** `admin:` — the prefix `RedisService` puts on every key it writes. */
  private namespace(): string {
    return this.redis.getKeyPrefix();
  }

  private requireRedis(): void {
    if (!this.redis.isConnected()) {
      throw new ServiceUnavailableException(
        'Redis is not connected; cache inspection and invalidation are unavailable',
      );
    }
  }

  private async typeOf(key: string): Promise<string> {
    return this.redis.getClient().type(this.namespace() + key);
  }

  /**
   * `MEMORY USAGE`, or null where the build does not support it.
   *
   * Null rather than 0: a key whose footprint could not be measured has an
   * unknown size, and rendering 0 bytes for it would be a made-up number.
   */
  private async sizeOf(key: string): Promise<number | null> {
    const usage = await this.redis.getClient().memory('USAGE', this.namespace() + key);
    return typeof usage === 'number' ? usage : null;
  }

  private async idleSecondsOf(key: string): Promise<number | null> {
    const idle = await this.redis.getClient().object('IDLETIME', this.namespace() + key);
    return typeof idle === 'number' ? idle : null;
  }

  /** One `field:value` line out of a Redis `INFO` section. */
  private readInfoNumber(info: string, field: string): number {
    const match = new RegExp(`^${field}:(\\d+)`, 'm').exec(info);
    return match ? Number(match[1]) : 0;
  }
}
