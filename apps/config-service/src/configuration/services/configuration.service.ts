import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Configuration,
  ConfigValueType,
  ConfigEnvironment,
} from '../entities/configuration.entity';
import { EncryptionService } from './encryption.service';

interface CacheEntry {
  value: Configuration;
  expiry: number;
  lastAccessed: number;
}

const MAX_CACHE_SIZE = 1000;
const CACHE_TTL_MS = 60_000; // 1 minute

@Injectable()
export class ConfigurationService implements OnModuleInit {
  private readonly logger = new Logger(ConfigurationService.name);
  private cache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(Configuration)
    private readonly configRepository: Repository<Configuration>,
    private readonly encryptionService: EncryptionService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Configuration service initialized');
  }

  /**
   * Get a single configuration value with caching and global fallback.
   * Decrypts secret values automatically.
   */
  async get<T = string>(
    tenantId: string,
    service: string,
    key: string,
    defaultValue?: T,
  ): Promise<T> {
    const cacheKey = `${tenantId}:${service}:${key}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      cached.lastAccessed = Date.now();
      return this.getDecryptedTypedValue<T>(cached.value);
    }

    // Single query with tenant + global fallback
    const whereConditions = [
      { tenantId, service, key, isActive: true },
      ...(tenantId !== 'global'
        ? [{ tenantId: 'global', service, key, isActive: true }]
        : []),
    ];

    const configs = await this.configRepository.find({
      where: whereConditions as any,
      take: 2,
    });

    // Prefer tenant-specific over global
    const config =
      configs.find((c) => c.tenantId === tenantId) ||
      configs.find((c) => c.tenantId === 'global');

    if (!config) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Configuration not found: ${service}/${key}`);
    }

    // Update cache with LRU eviction
    this.setCacheEntry(cacheKey, config);

    return this.getDecryptedTypedValue<T>(config);
  }

  /**
   * Get all configurations for a service, filtered by environment.
   * Tenant-specific values override global values.
   */
  async getAll(
    tenantId: string,
    service: string,
    environment?: ConfigEnvironment,
  ): Promise<Record<string, unknown>> {
    const whereConditions: any[] = [
      {
        tenantId,
        service,
        isActive: true,
        ...(environment && { environment }),
      },
      ...(tenantId !== 'global'
        ? [{
            tenantId: 'global',
            service,
            isActive: true,
            ...(environment && { environment }),
          }]
        : []),
    ];

    const configs = await this.configRepository.find({
      where: whereConditions,
      take: 500,
    });

    const result: Record<string, unknown> = {};

    // First add global configs
    configs
      .filter((c) => c.tenantId === 'global')
      .forEach((c) => {
        result[c.key] = this.getDecryptedTypedValue(c);
      });

    // Then override with tenant-specific
    configs
      .filter((c) => c.tenantId !== 'global')
      .forEach((c) => {
        result[c.key] = this.getDecryptedTypedValue(c);
      });

    return result;
  }

  /**
   * Invalidate cache for a specific configuration.
   * Called by command handlers after successful writes.
   * When a global config is updated, all per-tenant entries caching that global
   * fallback are also purged to prevent stale reads across tenants.
   */
  invalidateCache(tenantId: string, service: string, key: string): void {
    const cacheKey = `${tenantId}:${service}:${key}`;
    this.cache.delete(cacheKey);

    if (tenantId === 'global') {
      // Global update: purge all per-tenant cache entries that may hold this fallback value
      const suffix = `:${service}:${key}`;
      for (const k of this.cache.keys()) {
        if (k.endsWith(suffix)) {
          this.cache.delete(k);
        }
      }
    } else {
      // Tenant-specific update: also purge the global cache entry
      this.cache.delete(`global:${service}:${key}`);
    }
  }

  /**
   * Clear entire cache.
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.log('Configuration cache cleared');
  }

  /**
   * Seed default configurations using bulk INSERT ON CONFLICT DO NOTHING.
   */
  async seedDefaults(
    defaults: Array<{
      service: string;
      key: string;
      value: string;
      valueType?: ConfigValueType;
      description?: string;
      category?: string;
    }>,
  ): Promise<void> {
    if (defaults.length === 0) return;

    try {
      await this.configRepository
        .createQueryBuilder()
        .insert()
        .into(Configuration)
        .values(
          defaults.map((def) => ({
            tenantId: 'global',
            service: def.service,
            key: def.key,
            value: def.value,
            valueType: def.valueType || ConfigValueType.STRING,
            description: def.description,
            category: def.category,
            environment: ConfigEnvironment.ALL,
            isActive: true,
            isSecret: false,
            createdBy: 'system',
            updatedBy: 'system',
          })),
        )
        .orIgnore() // INSERT ... ON CONFLICT DO NOTHING
        .execute();

      this.logger.log(`Seeded ${defaults.length} default configurations (skipped existing)`);
    } catch (error) {
      this.logger.error(
        `Failed to seed defaults: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Decrypt secret values and return typed value.
   */
  private getDecryptedTypedValue<T = unknown>(config: Configuration): T {
    let rawValue = config.value;

    // Decrypt if secret and encryption is available
    if (config.isSecret && this.encryptionService.isAvailable() && this.encryptionService.isEncrypted(rawValue)) {
      try {
        rawValue = this.encryptionService.decrypt(rawValue);
      } catch (error) {
        this.logger.error(`Failed to decrypt config ${config.service}/${config.key}: ${error}`);
        throw new Error(`Failed to decrypt configuration: ${config.service}/${config.key}`);
      }
    }

    switch (config.valueType) {
      case ConfigValueType.NUMBER: {
        const trimmed = rawValue.trim();
        const num = Number(trimmed);
        return (Number.isFinite(num) ? num : NaN) as T;
      }
      case ConfigValueType.BOOLEAN:
        return (rawValue === 'true' || rawValue === '1') as T;
      case ConfigValueType.JSON:
        return JSON.parse(rawValue) as T;
      case ConfigValueType.SECRET:
      case ConfigValueType.STRING:
      default:
        return rawValue as T;
    }
  }

  /**
   * Set cache entry with LRU eviction when max size is exceeded.
   */
  private setCacheEntry(key: string, value: Configuration): void {
    // Evict oldest entry if cache is full
    if (this.cache.size >= MAX_CACHE_SIZE) {
      let oldestKey = '';
      let oldestAccess = Infinity;

      for (const [k, entry] of this.cache.entries()) {
        if (entry.lastAccessed < oldestAccess) {
          oldestAccess = entry.lastAccessed;
          oldestKey = k;
        }
      }

      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const now = Date.now();
    this.cache.set(key, {
      value,
      expiry: now + CACHE_TTL_MS,
      lastAccessed: now,
    });
  }
}
