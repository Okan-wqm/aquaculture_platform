import { RedisService } from '@aquaculture/backend-common/redis';
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';

import { SYSTEM_TENANT_ID } from '../configuration.constants';
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
/** Redis cache TTL in seconds — longer than in-memory because Redis is shared across pods */
const REDIS_CACHE_TTL_SECONDS = 120;

@Injectable()
export class ConfigurationService implements OnModuleInit {
  private readonly logger = new Logger(ConfigurationService.name);
  /** L1 in-memory cache (per-pod, fast) */
  private cache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(Configuration)
    private readonly configRepository: Repository<Configuration>,
    private readonly encryptionService: EncryptionService,
    /** L2 Redis cache (shared across pods). @Optional to allow graceful degradation. */
    @Optional() private readonly redisService?: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Configuration service initialized');
  }

  /**
   * Get a single configuration value with caching and system-tenant fallback.
   * Decrypts secret values automatically.
   */
  async get<T = string>(
    tenantId: string,
    service: string,
    key: string,
    defaultValue?: T,
  ): Promise<T> {
    const config = await this.resolveActiveConfig(tenantId, service, key);
    if (!config) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Configuration not found: ${service}/${key}`);
    }
    return this.getDecryptedTypedValue<T>(config);
  }

  /**
   * Resolve the effective value AND its secret classification in one call
   * (SEC-MEDIUM-001). The config-runtime GET (non-secret) handler uses the
   * `isSecret` flag to STRUCTURALLY refuse to return a secret over the
   * non-secret path — independent of any key allowlist. Returns null when the
   * row is absent/inactive (never throws for not-found).
   */
  async getEffectiveWithMeta(
    tenantId: string,
    service: string,
    key: string,
  ): Promise<{ value: string; isSecret: boolean } | null> {
    const config = await this.resolveActiveConfig(tenantId, service, key);
    if (!config) {
      return null;
    }
    return {
      value: this.getDecryptedTypedValue<string>(config),
      isSecret: this.isSecretConfig(config),
    };
  }

  /**
   * Resolve the active Configuration ENTITY (L1 → L2 → L3 with tenant/system
   * fallback + tombstone), or null when absent/inactive. The single lookup path
   * shared by `get()` and `getEffectiveWithMeta()` so the two can never drift.
   */
  private async resolveActiveConfig(
    tenantId: string,
    service: string,
    key: string,
  ): Promise<Configuration | null> {
    const cacheKey = this.cacheKey(tenantId, service, key, ConfigEnvironment.ALL);

    // ── L1: in-memory cache ──
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      cached.lastAccessed = Date.now();
      return cached.value;
    }

    // ── L2: Redis cache (cross-pod) ──
    if (this.redisService) {
      try {
        const redisKey = `config:${cacheKey}`;
        const redisValue = await this.redisService.get(redisKey);
        if (redisValue) {
          const config = JSON.parse(redisValue) as Configuration;
          // Promote to L1
          this.setCacheEntry(cacheKey, config);
          return config;
        }
      } catch (err) {
        // Redis unavailable: fall through to DB — graceful degradation
        this.logger.debug(`Redis cache miss/error for ${cacheKey}: ${err}`);
      }
    }

    // ── L3: Database ──
    // Single query with tenant + system fallback
    const whereConditions: FindOptionsWhere<Configuration>[] = [
      { tenantId, service, key },
      ...(tenantId !== SYSTEM_TENANT_ID
        ? [{ tenantId: SYSTEM_TENANT_ID, service, key, isActive: true }]
        : []),
    ];

    const configs = await this.configRepository.find({
      where: whereConditions,
      take: 2,
    });

    // Prefer tenant-specific over system fallback.
    const tenantConfig = configs.find((c) => c.tenantId === tenantId);
    const systemConfig = configs.find((c) => c.tenantId === SYSTEM_TENANT_ID);
    const config =
      tenantConfig?.isActive === false && tenantConfig.suppressFallback
        ? tenantConfig
        : tenantConfig?.isActive === true
          ? tenantConfig
          : systemConfig;

    if (!config || config.isActive === false) {
      return null;
    }

    // Update cache with LRU eviction
    this.setCacheEntry(cacheKey, config);

    return config;
  }

  /**
   * Get all configurations for a service, filtered by environment.
   * Tenant-specific values override system fallback values.
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
        ...(environment && { environment }),
      },
      ...(tenantId !== SYSTEM_TENANT_ID
        ? [
            {
              tenantId: SYSTEM_TENANT_ID,
              service,
              isActive: true,
              ...(environment && { environment }),
            },
          ]
        : []),
    ];

    const configs = await this.configRepository.find({
      where: whereConditions,
      take: 500,
    });

    const result: Record<string, unknown> = {};
    const tenantTombstones = new Set(
      configs
        .filter((c) => c.tenantId === tenantId && c.isActive === false && c.suppressFallback)
        .map((c) => c.key),
    );

    // First add system fallback configs — secrets masked to prevent bulk plaintext exposure.
    // Single-key get() decrypts for authorized callers; getAll() is a bulk operation
    // used for config bootstrapping where plaintext secrets must not appear.
    configs
      .filter((c) => c.tenantId === SYSTEM_TENANT_ID)
      .forEach((c) => {
        if (tenantTombstones.has(c.key)) {
          return;
        }
        result[c.key] = this.isSecretConfig(c) ? '[ENCRYPTED]' : this.getDecryptedTypedValue(c);
      });

    // Then override with tenant-specific
    configs
      .filter((c) => c.tenantId !== SYSTEM_TENANT_ID && c.isActive === true)
      .forEach((c) => {
        result[c.key] = this.isSecretConfig(c) ? '[ENCRYPTED]' : this.getDecryptedTypedValue(c);
      });

    return result;
  }

  /**
   * Invalidate cache for a specific configuration.
   * Called by command handlers after successful writes.
   * When a system config is updated, all per-tenant entries caching that system
   * fallback are also purged to prevent stale reads across tenants.
   *
   * Invalidates both L1 (in-memory) and L2 (Redis) caches so that
   * config updates on one pod are visible to other pods immediately.
   * @see PLAT-MEDIUM-007 (config cache is local-only per-pod)
   */
  invalidateCache(tenantId: string, service: string, key: string): void {
    const cacheKey = this.cacheKey(tenantId, service, key, ConfigEnvironment.ALL);

    // ── L1: in-memory ──
    this.cache.delete(cacheKey);

    if (tenantId === SYSTEM_TENANT_ID) {
      // System update: purge all per-tenant cache entries that may hold this fallback value
      const suffix = `:${service}:${key}:${ConfigEnvironment.ALL}`;
      for (const k of this.cache.keys()) {
        if (k.endsWith(suffix)) {
          this.cache.delete(k);
        }
      }
    } else {
      // Tenant-specific update: also purge the system fallback cache entry
      this.cache.delete(this.cacheKey(SYSTEM_TENANT_ID, service, key, ConfigEnvironment.ALL));
    }

    // ── L2: Redis (cross-pod) ──
    if (this.redisService) {
      const redisKey = `config:${cacheKey}`;
      this.redisService.del(redisKey).catch((err) => {
        this.logger.warn(`Failed to invalidate Redis cache for ${redisKey}: ${err}`);
      });

      if (tenantId === SYSTEM_TENANT_ID) {
        // Purge all tenant-specific Redis entries for this service:key
        this.redisService
          .deletePattern(`config:*:${service}:${key}:${ConfigEnvironment.ALL}`)
          .catch((err) => {
            this.logger.warn(`Failed to invalidate Redis pattern for ${service}:${key}: ${err}`);
          });
      } else {
        this.redisService
          .del(`config:${this.cacheKey(SYSTEM_TENANT_ID, service, key, ConfigEnvironment.ALL)}`)
          .catch((err) => {
            this.logger.warn(
              `Failed to invalidate Redis system cache for ${service}:${key}: ${err}`,
            );
          });
      }
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
            tenantId: SYSTEM_TENANT_ID,
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
    if (
      this.isSecretConfig(config) &&
      this.encryptionService.isAvailable() &&
      this.encryptionService.isEncrypted(rawValue)
    ) {
      try {
        // PLAT-HIGH-003: AAD binding validates tenant + key context
        rawValue = this.encryptionService.decrypt(rawValue, config.tenantId, config.key);
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
      if (value.isActive !== false && !this.isSecretConfig(value)) {
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

  private isSecretConfig(config: Configuration): boolean {
    return config.valueType === ConfigValueType.SECRET || config.isSecret === true;
  }
}
