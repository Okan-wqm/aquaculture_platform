/**
 * ParameterConfigCacheService
 *
 * In-memory cache for active parameter configurations per tenant.
 * TTL-based invalidation (5 minutes) with manual invalidation support.
 *
 * @module WaterQuality/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

interface CacheEntry {
  configs: WaterQualityParameterConfig[];
  loadedAt: number;
}

@Injectable()
export class ParameterConfigCacheService {
  private readonly logger = new Logger(ParameterConfigCacheService.name);
  private cache = new Map<string, CacheEntry>();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    @InjectRepository(WaterQualityParameterConfig)
    private readonly repository: Repository<WaterQualityParameterConfig>,
  ) {}

  /**
   * Returns active parameter configs for a tenant.
   * Serves from cache if entry is fresh, otherwise reloads from DB.
   */
  async getActiveConfigs(tenantId: string): Promise<WaterQualityParameterConfig[]> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.loadedAt < this.TTL_MS) {
      return cached.configs;
    }

    this.logger.debug(`Loading active configs from DB for tenant ${tenantId}`);

    const configs = await this.repository.find({
      where: { tenantId, isActive: true },
      order: { displayOrder: 'ASC' },
    });

    this.cache.set(tenantId, { configs, loadedAt: Date.now() });

    return configs;
  }

  /**
   * Invalidates cache for a single tenant.
   * Call after config mutations (create, update, delete).
   */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
    this.logger.debug(`Cache invalidated for tenant ${tenantId}`);
  }

  /**
   * Invalidates all cached entries across all tenants.
   */
  invalidateAll(): void {
    this.cache.clear();
    this.logger.debug('All parameter config caches invalidated');
  }
}
