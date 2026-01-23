import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

import { CacheEntrySnapshot } from '../entities/debug-session.entity';
import { CacheInspectorResult, CacheStats } from './debug-tools-types';

/**
 * Cache Inspector Service
 * Handles cache monitoring and inspection
 * SRP: Only responsible for cache debugging operations
 */
@Injectable()
export class CacheInspectorService {
  private readonly logger = new Logger(CacheInspectorService.name);

  constructor(
    @InjectRepository(CacheEntrySnapshot)
    private readonly cacheSnapshotRepo: Repository<CacheEntrySnapshot>,
  ) {}

  /**
   * Snapshot cache entries for inspection
   */
  async snapshotCache(
    tenantId: string,
    debugSessionId?: string,
    cacheStore?: string,
  ): Promise<CacheInspectorResult> {
    const query = this.cacheSnapshotRepo.createQueryBuilder('c');

    if (tenantId) {
      query.where('c.tenantId = :tenantId', { tenantId });
    }
    if (debugSessionId) {
      query.andWhere('c.debugSessionId = :debugSessionId', { debugSessionId });
    }
    if (cacheStore) {
      query.andWhere('c.cacheStore = :cacheStore', { cacheStore });
    }

    query.orderBy('c.capturedAt', 'DESC').limit(500);

    const entries = await query.getMany();

    const now = new Date();
    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

    const storeBreakdown: Record<string, number> = {};
    let totalSizeBytes = 0;
    let totalTtl = 0;
    let expiringInHour = 0;

    for (const entry of entries) {
      totalSizeBytes += entry.sizeBytes || 0;
      totalTtl += entry.ttlSeconds || 0;

      if (entry.expiresAt && entry.expiresAt <= inOneHour) {
        expiringInHour++;
      }

      const store = entry.cacheStore || 'default';
      storeBreakdown[store] = (storeBreakdown[store] || 0) + 1;
    }

    return {
      entries,
      summary: {
        totalKeys: entries.length,
        totalSizeBytes,
        avgTtlSeconds: entries.length > 0 ? totalTtl / entries.length : 0,
        expiringInHour,
        storeBreakdown,
      },
    };
  }

  /**
   * Capture a cache entry snapshot
   */
  async captureCacheEntry(data: {
    tenantId?: string;
    debugSessionId?: string;
    key: string;
    value?: unknown;
    sizeBytes?: number;
    ttlSeconds?: number;
    expiresAt?: Date;
    hitCount?: number;
    lastAccessedAt?: Date;
    cacheStore?: string;
    tags?: string[];
  }): Promise<CacheEntrySnapshot> {
    const snapshot = this.cacheSnapshotRepo.create({
      ...data,
      capturedAt: new Date(),
    });

    return this.cacheSnapshotRepo.save(snapshot);
  }

  /**
   * Get cache entry by key
   */
  async getCacheEntry(key: string): Promise<CacheEntrySnapshot | null> {
    const entry = await this.cacheSnapshotRepo.findOne({
      where: { key },
      order: { capturedAt: 'DESC' },
    });
    return entry;
  }

  /**
   * Invalidate cache by key (placeholder for actual implementation)
   */
  async invalidateCacheByKey(key: string): Promise<void> {
    // In production, this would invalidate the actual cache key
    this.logger.log(`[Cache] Invalidated key: ${key}`);
  }

  /**
   * Invalidate cache key for a tenant
   */
  async invalidateCacheKey(tenantId: string, key: string): Promise<void> {
    // In production, this would invalidate the actual cache key
    this.logger.log(`[Cache] Invalidated key: ${key} for tenant: ${tenantId}`);
  }

  /**
   * Invalidate cache keys by pattern
   */
  async invalidateCachePattern(tenantId: string, pattern: string): Promise<number> {
    // In production, this would use SCAN and DEL on Redis
    this.logger.log(`[Cache] Invalidated pattern: ${pattern} for tenant: ${tenantId}`);
    return 0;
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(tenantId?: string): Promise<CacheStats> {
    const query = this.cacheSnapshotRepo.createQueryBuilder('c');

    if (tenantId) {
      query.where('c.tenantId = :tenantId', { tenantId });
    }

    const entries = await query.getMany();

    const storeStats: Record<string, { entries: number; size: number }> = {};
    let totalSize = 0;
    let totalHits = 0;

    for (const entry of entries) {
      totalSize += entry.sizeBytes || 0;
      totalHits += entry.hitCount || 0;

      const store = entry.cacheStore || 'default';
      if (!storeStats[store]) {
        storeStats[store] = { entries: 0, size: 0 };
      }
      storeStats[store].entries++;
      storeStats[store].size += entry.sizeBytes || 0;
    }

    const totalEntries = entries.length;
    const hitRate = totalEntries > 0 ? (totalHits / (totalHits + totalEntries)) * 100 : 0;
    const missRate = 100 - hitRate;

    return {
      totalEntries,
      totalSize,
      hitRate: Math.round(hitRate * 10) / 10,
      missRate: Math.round(missRate * 10) / 10,
      byStore: Object.entries(storeStats).map(([store, stats]) => ({
        store,
        entries: stats.entries,
        size: stats.size,
      })),
    };
  }

  /**
   * Cleanup old cache snapshot data
   */
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async cleanupOldData(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    await this.cacheSnapshotRepo.delete({ capturedAt: LessThan(cutoff) });
    this.logger.log('Cleaned up old cache snapshot data');
  }
}
