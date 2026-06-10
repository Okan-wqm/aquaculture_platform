import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Configuration,
  ConfigValueType,
  ConfigEnvironment,
} from '../entities/configuration.entity';
import { EncryptionService } from './encryption.service';
import { RedisService } from '@aquaculture/backend-common/redis';
import { GLOBAL_TENANT_UUID } from '@aquaculture/backend-common/tenant';
import { ConfigurationResolutionService } from './configuration-resolution.service';

interface CacheEntry {
  value: Configuration;
  expiry: number;
  lastAccessed: number;
}

const MAX_CACHE_SIZE = 1000;
const CACHE_TTL_MS = 60_000; // 1 minute
/** Redis cache TTL in seconds. Redis is optional; DB remains the SSOT. */
const REDIS_CACHE_TTL_SECONDS = 120;

function isSecretConfiguration(config: Pick<Configuration, 'isSecret' | 'valueType'>): boolean {
  return config.valueType === ConfigValueType.SECRET || config.isSecret;
}

@Injectable()
export class ConfigurationService implements OnModuleInit {
  private readonly logger = new Logger(ConfigurationService.name);
  /** L1 in-memory cache (per-pod, fast) */
  private cache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(Configuration)
    private readonly configRepository: Repository<Configuration>,
    private readonly encryptionService: EncryptionService,
    private readonly resolutionService: ConfigurationResolutionService,
    /** L2 Redis cache (shared across pods). @Optional to allow graceful degradation. */
    @Optional() private readonly redisService?: RedisService,
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
    environment: ConfigEnvironment = ConfigEnvironment.ALL,
  ): Promise<T> {
    const config = await this.resolveConfiguration(
      tenantId,
      service,
      key,
      environment,
    );

    if (!config) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Configuration not found: ${service}/${key}`);
    }

    return this.getDecryptedTypedValue<T>(config);
  }

  async resolveConfiguration(
    tenantId: string,
    service: string,
    key: string,
    environment: ConfigEnvironment = ConfigEnvironment.ALL,
  ): Promise<Configuration | null> {
    const cacheKey = this.cacheKey(tenantId, service, key, environment);

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      cached.lastAccessed = Date.now();
      return cached.value;
    }

    if (this.redisService) {
      try {
        const redisKey = `config:${cacheKey}`;
        const redisValue = await this.redisService.get(redisKey);
        if (redisValue) {
          const config = JSON.parse(redisValue) as Configuration;
          this.setCacheEntry(cacheKey, config);
          return config;
        }
      } catch (err) {
        // Redis unavailable: fall through to DB. Redis is not the config SSOT.
        this.logger.debug(`Redis cache miss/error for ${cacheKey}: ${err}`);
      }
    }

    const config = await this.resolutionService.resolveConfiguration(
      tenantId,
      service,
      key,
      environment,
    );

    if (config) {
      this.setCacheEntry(cacheKey, config);
    }

    return config ?? null;
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
    const configs = await this.resolveConfigurationsByService(
      tenantId,
      service,
      environment ?? ConfigEnvironment.ALL,
    );

    const result: Record<string, unknown> = {};

    for (const config of configs) {
      result[config.key] = isSecretConfiguration(config)
        ? '[ENCRYPTED]'
        : this.getDecryptedTypedValue(config);
    }

    return result;
  }

  async resolveConfigurationsByService(
    tenantId: string,
    service: string,
    environment: ConfigEnvironment = ConfigEnvironment.ALL,
  ): Promise<Configuration[]> {
    return this.resolutionService.resolveConfigurationsByService(
      tenantId,
      service,
      environment,
    );
  }

  /**
   * Invalidate cache for a specific configuration.
   * Called by command handlers after successful writes.
   * When a global config is updated, all per-tenant entries caching that global
   * fallback are also purged to prevent stale reads across tenants.
   *
   * Invalidates both L1 (in-memory) and L2 (Redis) caches so that
   * config updates on one pod are visible to other pods immediately.
   * @see PLAT-MEDIUM-007 (config cache is local-only per-pod)
   */
  invalidateCache(
    tenantId: string,
    service: string,
    key: string,
    environment?: ConfigEnvironment,
  ): void {
    for (const k of this.cache.keys()) {
      const [cachedTenant, cachedService, cachedKey, cachedEnvironment] = k.split(':');
      if (
        cachedService === service &&
        cachedKey === key &&
        (!environment || cachedEnvironment === environment)
      ) {
        if (tenantId === GLOBAL_TENANT_UUID || cachedTenant === tenantId) {
          this.cache.delete(k);
        }
      }
    }

    if (this.redisService) {
      const envPattern = environment ? `:${environment}` : ':*';
      this.redisService.deletePattern(`config:*:${service}:${key}${envPattern}`).catch((err) => {
        this.logger.warn(`Failed to invalidate Redis pattern for ${service}:${key}: ${err}`);
      });
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
            tenantId: GLOBAL_TENANT_UUID,
            service: def.service,
            key: def.key,
            value: def.value,
            valueType: def.valueType || ConfigValueType.STRING,
            description: def.description,
            category: def.category,
            environment: ConfigEnvironment.ALL,
            isActive: true,
            isSecret: def.valueType === ConfigValueType.SECRET,
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
   *
   * PLAT-HIGH-003: Passes tenantId and configKey as AAD context to the
   * decryption call. This ensures V2-encrypted values cannot be silently
   * copied between tenants or config keys without detection.
   */
  private getDecryptedTypedValue<T = unknown>(config: Configuration): T {
    let rawValue = config.value;

    // Decrypt if secret and encryption is available
    if (isSecretConfiguration(config) && this.encryptionService.isAvailable() && this.encryptionService.isEncrypted(rawValue)) {
      try {
        rawValue = this.encryptionService.decrypt(rawValue, {
          tenantId: config.tenantId,
          service: config.service,
          key: config.key,
          environment: config.environment,
          classification: config.valueType,
        });
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
   * Writes to both L1 (in-memory) and L2 (Redis) for cross-pod consistency.
   * @see PLAT-MEDIUM-007 (config cache is local-only per-pod)
   */
  private setCacheEntry(key: string, value: Configuration): void {
    // ── L1: in-memory with LRU eviction ──
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

    // ── L2: Redis (cross-pod, longer TTL) ──
    if (this.redisService) {
      const redisKey = `config:${key}`;
      // SECURITY: Do not cache secret values in Redis — they are decrypted on read
      // and should not be stored in a shared cache in plaintext.
      if (!isSecretConfiguration(value)) {
        this.redisService
          .set(redisKey, JSON.stringify(value), REDIS_CACHE_TTL_SECONDS)
          .catch((err) => {
            this.logger.debug(`Failed to write Redis cache for ${redisKey}: ${err}`);
          });
      }
    }
  }

  private cacheKey(
    tenantId: string,
    service: string,
    key: string,
    environment: ConfigEnvironment,
  ): string {
    return `${tenantId}:${service}:${key}:${environment}`;
  }
}
