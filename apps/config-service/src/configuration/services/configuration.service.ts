import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Configuration,
  ConfigValueType,
  ConfigEnvironment,
} from '../entities/configuration.entity';

/**
 * Configuration Service
 * Provides programmatic access to configurations for other services
 */
@Injectable()
export class ConfigurationService implements OnModuleInit {
  private readonly logger = new Logger(ConfigurationService.name);
  private cache = new Map<string, { value: Configuration; expiry: number }>();
  private readonly cacheTTL = 60000; // 1 minute cache

  constructor(
    @InjectRepository(Configuration)
    private readonly configRepository: Repository<Configuration>,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Configuration service initialized');
  }

  /**
   * Get configuration value with caching
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
      return cached.value.getTypedValue<T>();
    }

    // Query database
    let config = await this.configRepository.findOne({
      where: { tenantId, service, key, isActive: true },
    });

    // Fall back to global config
    if (!config && tenantId !== 'global') {
      config = await this.configRepository.findOne({
        where: { tenantId: 'global', service, key, isActive: true },
      });
    }

    if (!config) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Configuration not found: ${service}/${key}`);
    }

    // Update cache
    this.cache.set(cacheKey, {
      value: config,
      expiry: Date.now() + this.cacheTTL,
    });

    return config.getTypedValue<T>();
  }

  /**
   * Get all configurations for a service
   */
  async getAll(
    tenantId: string,
    service: string,
  ): Promise<Record<string, unknown>> {
    const configs = await this.configRepository.find({
      where: [
        { tenantId, service, isActive: true },
        { tenantId: 'global', service, isActive: true },
      ],
    });

    // Build config object, tenant-specific overrides global
    const result: Record<string, unknown> = {};

    // First add global configs
    configs
      .filter((c) => c.tenantId === 'global')
      .forEach((c) => {
        result[c.key] = c.getTypedValue();
      });

    // Then override with tenant-specific
    configs
      .filter((c) => c.tenantId !== 'global')
      .forEach((c) => {
        result[c.key] = c.getTypedValue();
      });

    return result;
  }

  /**
   * Set configuration value (creates or updates)
   */
  async set(
    tenantId: string,
    service: string,
    key: string,
    value: string,
    options?: {
      valueType?: ConfigValueType;
      description?: string;
      isSecret?: boolean;
      userId?: string;
    },
  ): Promise<Configuration> {
    let config = await this.configRepository.findOne({
      where: { tenantId, service, key },
    });

    if (config) {
      config.value = value;
      if (options?.valueType) config.valueType = options.valueType;
      if (options?.description) config.description = options.description;
      if (options?.userId) config.updatedBy = options.userId;
    } else {
      config = this.configRepository.create({
        tenantId,
        service,
        key,
        value,
        valueType: options?.valueType || ConfigValueType.STRING,
        description: options?.description,
        isSecret: options?.isSecret || false,
        isActive: true,
        createdBy: options?.userId,
        updatedBy: options?.userId,
      });
    }

    const saved = await this.configRepository.save(config);

    // Invalidate cache
    this.cache.delete(`${tenantId}:${service}:${key}`);

    return saved;
  }

  /**
   * Delete configuration
   */
  async delete(tenantId: string, service: string, key: string): Promise<void> {
    await this.configRepository.update(
      { tenantId, service, key },
      { isActive: false },
    );

    // Invalidate cache
    this.cache.delete(`${tenantId}:${service}:${key}`);
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.log('Configuration cache cleared');
  }

  /**
   * Seed default configurations
   */
  async seedDefaults(defaults: Array<{
    service: string;
    key: string;
    value: string;
    valueType?: ConfigValueType;
    description?: string;
    category?: string;
  }>): Promise<void> {
    for (const def of defaults) {
      const exists = await this.configRepository.findOne({
        where: {
          tenantId: 'global',
          service: def.service,
          key: def.key,
        },
      });

      if (!exists) {
        await this.configRepository.save(
          this.configRepository.create({
            tenantId: 'global',
            service: def.service,
            key: def.key,
            value: def.value,
            valueType: def.valueType || ConfigValueType.STRING,
            description: def.description,
            category: def.category,
            environment: ConfigEnvironment.ALL,
            isActive: true,
            createdBy: 'system',
            updatedBy: 'system',
          }),
        );

        this.logger.log(`Seeded default config: ${def.service}/${def.key}`);
      }
    }
  }
}
