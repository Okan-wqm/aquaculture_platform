import { RedisService } from '@aquaculture/backend-common/redis';
import {
  ADMIN_CACHE_INVALIDATION_RECEIPT_SCHEMA_VERSION,
  adminCacheInvalidationReceiptSha256V1,
  adminCacheKeySetSha256V1,
  type AdminCacheInvalidationEvidenceV1,
} from '@aquaculture/shared-contracts';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import type {
  CacheInvalidationReceiptV1,
  CacheKeyEntry,
  CacheKeyValue,
  CacheNamespaceListing,
  CacheStats,
} from './debug-tools-types';

/** Live, namespace-bound Redis inspection and mutation authority. */
@Injectable()
export class CacheInspectorService {
  constructor(private readonly redis: RedisService) {}

  async listEntries(keyPattern: string, limit: number): Promise<CacheNamespaceListing> {
    this.requireRedis();
    const matched = await this.redis.keys(keyPattern);
    const keys = matched.slice(0, limit);
    const entries: CacheKeyEntry[] = [];
    for (const key of keys) {
      entries.push(
        Object.freeze({
          key,
          type: await this.redis.type(key),
          ttlSeconds: await this.redis.ttl(key),
          sizeBytes: await this.redis.memoryUsage(key),
          idleSeconds: await this.redis.objectIdleTime(key),
        }),
      );
    }
    return Object.freeze({
      namespace: this.redis.getKeyPrefix(),
      entries: Object.freeze(entries),
      matchedCount: matched.length,
      truncated: matched.length > keys.length,
    });
  }

  async getEntry(key: string): Promise<CacheKeyValue | null> {
    this.requireRedis();
    const type = await this.redis.type(key);
    if (type === 'none') return null;
    return Object.freeze({
      key,
      type,
      ttlSeconds: await this.redis.ttl(key),
      sizeBytes: await this.redis.memoryUsage(key),
      value: type === 'string' ? await this.redis.get(key) : null,
    });
  }

  async invalidateKey(key: string): Promise<CacheInvalidationReceiptV1> {
    this.requireRedis();
    const discovered = (await this.redis.exists(key)) ? [key] : [];
    const deletedCount = await this.redis.del(key);
    const residual = (await this.redis.exists(key)) ? [key] : [];
    return this.receipt('KEY', key, discovered, deletedCount, residual);
  }

  async invalidatePattern(pattern: string): Promise<CacheInvalidationReceiptV1> {
    this.requireRedis();
    const evidence = await this.redis.deletePatternWithEvidence(pattern);
    const residual = await this.redis.keys(pattern);
    return this.receipt('PATTERN', pattern, evidence.matchedKeys, evidence.deletedCount, residual);
  }

  async getStats(): Promise<CacheStats> {
    this.requireRedis();
    const [statsInfo, memoryInfo, keysInNamespace, totalKeys] = await Promise.all([
      this.redis.info('stats'),
      this.redis.info('memory'),
      this.redis.keys('*').then((keys) => keys.length),
      this.redis.dbsize(),
    ]);
    const keyspaceHits = this.readInfoNumber(statsInfo, 'keyspace_hits');
    const keyspaceMisses = this.readInfoNumber(statsInfo, 'keyspace_misses');
    const lookups = keyspaceHits + keyspaceMisses;
    return Object.freeze({
      namespace: this.redis.getKeyPrefix(),
      keysInNamespace,
      instance: Object.freeze({
        keyspaceHits,
        keyspaceMisses,
        hitRatePercent: lookups === 0 ? null : Math.round((keyspaceHits / lookups) * 1000) / 10,
        usedMemoryBytes: this.readInfoNumber(memoryInfo, 'used_memory'),
        totalKeys,
      }),
    });
  }

  private receipt(
    kind: 'KEY' | 'PATTERN',
    value: string,
    discoveredKeys: readonly string[],
    deletedCount: number,
    residualKeys: readonly string[],
  ): CacheInvalidationReceiptV1 {
    const discovered = Object.freeze([...new Set(discoveredKeys)].sort());
    const residual = Object.freeze([...new Set(residualKeys)].sort());
    const namespace = this.redis.getKeyPrefix();
    const selector = Object.freeze({ kind, value });
    const evidence: AdminCacheInvalidationEvidenceV1 = Object.freeze({
      schemaVersion: ADMIN_CACHE_INVALIDATION_RECEIPT_SCHEMA_VERSION,
      namespace,
      selector,
      discoveredCount: discovered.length,
      discoveredKeysDigest: adminCacheKeySetSha256V1({
        namespace,
        selector,
        phase: 'DISCOVERED',
        keys: discovered,
      }),
      deletedCount,
      residualCount: residual.length,
      residualKeysDigest: adminCacheKeySetSha256V1({
        namespace,
        selector,
        phase: 'RESIDUAL',
        keys: residual,
      }),
      outcome:
        residual.length === 0 ? ('FULLY_INVALIDATED' as const) : ('RESIDUAL_KEYS_PRESENT' as const),
    });
    return Object.freeze({
      ...evidence,
      receiptId: adminCacheInvalidationReceiptSha256V1(evidence),
    });
  }

  private requireRedis(): void {
    if (!this.redis.isConnected()) {
      throw new ServiceUnavailableException(
        'Redis is not connected; cache inspection and invalidation are unavailable',
      );
    }
  }

  private readInfoNumber(info: string, field: string): number {
    const match = new RegExp(`^${field}:([0-9]+)\\r?$`, 'mu').exec(info);
    const value = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ServiceUnavailableException(
        `Redis INFO did not provide a canonical non-negative ${field} counter`,
      );
    }
    return value;
  }
}
