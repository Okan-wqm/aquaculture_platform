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

    const where: FindOptionsWhere<Configuration> = {
      tenantId,
    };

    if (filter) {
      if (filter.service) where.service = filter.service;
      if (filter.key) where.key = filter.key;
      if (filter.environment) where.environment = filter.environment;
      if (filter.category) where.category = filter.category;
      if (filter.isActive !== undefined) where.isActive = filter.isActive;
      if (filter.isSecret !== undefined) where.isSecret = filter.isSecret;
    }

    const configurations = await this.configRepository.find({
      where,
      order: { service: 'ASC', key: 'ASC' },
    });

    // Filter by tags if specified
    if (filter?.tags && filter.tags.length > 0) {
      return configurations.filter(
        (config) =>
          config.tags &&
          filter.tags!.some((tag) => config.tags!.includes(tag)),
      );
    }

    return configurations;
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

    // Also include global configs
    if (tenantId !== 'global') {
      where.push({
        tenantId: 'global',
        service,
        isActive: true,
        ...(environment && { environment: environment as ConfigEnvironment }),
      });
    }

    const configurations = await this.configRepository.find({
      where,
      order: { key: 'ASC' },
    });

    // Merge: tenant-specific overrides global
    const configMap = new Map<string, Configuration>();

    // First add global configs
    configurations
      .filter((c) => c.tenantId === 'global')
      .forEach((c) => configMap.set(`${c.key}-${c.environment}`, c));

    // Then override with tenant-specific
    configurations
      .filter((c) => c.tenantId !== 'global')
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

    return await this.historyRepository.find({
      where: { configurationId, tenantId },
      order: { changedAt: 'DESC' },
      take: limit || 100,
    });
  }
}
