import { Injectable } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import {
  GetConfigurationsQuery,
  GetConfigurationsByServiceQuery,
  GetConfigurationHistoryQuery,
} from '../queries/get-configurations.query';
import {
  Configuration,
  ConfigurationHistory,
  ConfigEnvironment,
} from '../entities/configuration.entity';
import { GLOBAL_TENANT_UUID } from '@aquaculture/backend-common/tenant';

@Injectable()
@QueryHandler(GetConfigurationsQuery)
export class GetConfigurationsHandler
  implements IQueryHandler<GetConfigurationsQuery, Configuration[]>
{
  constructor(
    @InjectRepository(Configuration)
    private readonly configRepository: Repository<Configuration>,
  ) {}

  async execute(query: GetConfigurationsQuery): Promise<Configuration[]> {
    const { tenantId, filter } = query;

    // Use query builder for tag filtering and pagination support
    const qb = this.configRepository
      .createQueryBuilder('config')
      .where('config.tenantId = :tenantId', { tenantId });

    // Default to active only unless explicitly overridden
    if (filter?.isActive !== undefined) {
      qb.andWhere('config.isActive = :isActive', { isActive: filter.isActive });
    } else {
      qb.andWhere('config.isActive = :isActive', { isActive: true });
    }

    if (filter) {
      if (filter.service) {
        qb.andWhere('config.service = :service', { service: filter.service });
      }
      if (filter.key) {
        qb.andWhere('config.key = :key', { key: filter.key });
      }
      if (filter.environment) {
        qb.andWhere('config.environment = :environment', { environment: filter.environment });
      }
      if (filter.category) {
        qb.andWhere('config.category = :category', { category: filter.category });
      }
      if (filter.isSecret !== undefined) {
        qb.andWhere('config.isSecret = :isSecret', { isSecret: filter.isSecret });
      }
      // Push tag filtering to PostgreSQL using native array overlap operator
      if (filter.tags && filter.tags.length > 0) {
        qb.andWhere('config.tags && :tags', { tags: filter.tags });
      }
    }

    const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 500);
    const offset = Math.max(filter?.offset ?? 0, 0);

    qb.orderBy('config.service', 'ASC').addOrderBy('config.key', 'ASC').take(limit).skip(offset);

    return qb.getMany();
  }
}

@Injectable()
@QueryHandler(GetConfigurationsByServiceQuery)
export class GetConfigurationsByServiceHandler
  implements IQueryHandler<GetConfigurationsByServiceQuery, Configuration[]>
{
  constructor(
    @InjectRepository(Configuration)
    private readonly configRepository: Repository<Configuration>,
  ) {}

  async execute(query: GetConfigurationsByServiceQuery): Promise<Configuration[]> {
    const { tenantId, service, environment } = query;

    const where: FindOptionsWhere<Configuration>[] = [
      {
        tenantId,
        service,
        isActive: true,
        ...(environment && { environment: environment as ConfigEnvironment }),
      },
    ];

    // Also include system-wide configs
    if (tenantId !== GLOBAL_TENANT_UUID) {
      where.push({
        tenantId: GLOBAL_TENANT_UUID,
        service,
        isActive: true,
        ...(environment && { environment: environment as ConfigEnvironment }),
      });
    }

    const configurations = await this.configRepository.find({
      where,
      order: { key: 'ASC' },
      take: 500,
    });

    // Merge: tenant-specific overrides system-wide
    const configMap = new Map<string, Configuration>();

    // First add system-wide configs
    configurations
      .filter((c) => c.tenantId === GLOBAL_TENANT_UUID)
      .forEach((c) => configMap.set(`${c.key}-${c.environment}`, c));

    // Then override with tenant-specific
    configurations
      .filter((c) => c.tenantId !== GLOBAL_TENANT_UUID)
      .forEach((c) => configMap.set(`${c.key}-${c.environment}`, c));

    return Array.from(configMap.values());
  }
}

@Injectable()
@QueryHandler(GetConfigurationHistoryQuery)
export class GetConfigurationHistoryHandler
  implements IQueryHandler<GetConfigurationHistoryQuery, ConfigurationHistory[]>
{
  constructor(
    @InjectRepository(ConfigurationHistory)
    private readonly historyRepository: Repository<ConfigurationHistory>,
  ) {}

  async execute(query: GetConfigurationHistoryQuery): Promise<ConfigurationHistory[]> {
    const { tenantId, configurationId, limit } = query;

    // Cap limit to prevent abuse
    const cappedLimit = Math.min(Math.max(limit || 50, 1), 500);

    return this.historyRepository.find({
      where: { configurationId, tenantId },
      order: { changedAt: 'DESC' },
      take: cappedLimit,
    });
  }
}
