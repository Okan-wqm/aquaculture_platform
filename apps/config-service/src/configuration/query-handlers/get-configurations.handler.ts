import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, FindOptionsWhere } from 'typeorm';

import { runInRlsScopedRead } from '../../database/rls-scoped-session';
import { SYSTEM_TENANT_ID } from '../configuration.constants';
import {
  Configuration,
  ConfigurationHistory,
  ConfigEnvironment,
} from '../entities/configuration.entity';
import {
  GetConfigurationsQuery,
  GetConfigurationsByServiceQuery,
  GetConfigurationHistoryQuery,
} from '../queries/get-configurations.query';

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

    qb.orderBy('config.service', 'ASC')
      .addOrderBy('config.key', 'ASC')
      .take(limit)
      .skip(offset);

    return qb.getMany();
  }
}

@Injectable()
@QueryHandler(GetConfigurationsByServiceQuery)
export class GetConfigurationsByServiceHandler
  implements IQueryHandler<GetConfigurationsByServiceQuery, Configuration[]>
{
  constructor(private readonly dataSource: DataSource) {}

  async execute(query: GetConfigurationsByServiceQuery): Promise<Configuration[]> {
    const { tenantId, service, environment } = query;

    const serviceScopedWhere: FindOptionsWhere<Configuration> = {
      service,
      ...(environment && { environment: environment as ConfigEnvironment }),
    };

    // WHY two explicitly-scoped reads instead of one pooled query: FORCE RLS on
    // config.configurations exposes only the partition matching the
    // app.current_tenant GUC, so a single query can never see both the tenant's
    // own rows and the SYSTEM fallback rows. Each read owns its RLS scope
    // transaction-locally — the tenant read is scoped to the resolved tenant
    // (which IS the system tenant for a tenantless platform admin), and the
    // system-fallback read is scoped to SYSTEM_TENANT_ID because platform
    // defaults are cross-tenant-readable BY DESIGN.
    const tenantRows = await runInRlsScopedRead(this.dataSource, tenantId, (manager) =>
      tenantManagerRepo(manager, Configuration, tenantId).find({
        where: serviceScopedWhere,
        order: { key: 'ASC' },
        take: 500,
      }),
    );

    const systemRows =
      tenantId === SYSTEM_TENANT_ID
        ? []
        : await runInRlsScopedRead(this.dataSource, SYSTEM_TENANT_ID, (manager) =>
            tenantManagerRepo(manager, Configuration, SYSTEM_TENANT_ID).find({
              where: { ...serviceScopedWhere, isActive: true },
              order: { key: 'ASC' },
              take: 500,
            }),
          );

    const configurations = [...tenantRows, ...systemRows];

    // Merge: tenant-specific overrides system fallback.
    const configMap = new Map<string, Configuration>();

    const tenantTombstones = new Set(
      configurations
        .filter((c) => c.tenantId === tenantId && c.isActive === false && c.suppressFallback)
        .map((c) => `${c.key}-${c.environment}`),
    );

    // First add system fallback configs, except keys explicitly tombstoned by the tenant.
    configurations
      .filter((c) => c.tenantId === SYSTEM_TENANT_ID)
      .forEach((c) => {
        const mapKey = `${c.key}-${c.environment}`;
        if (!tenantTombstones.has(mapKey)) {
          configMap.set(mapKey, c);
        }
      });

    // Then override with tenant-specific
    configurations
      .filter((c) => c.tenantId !== SYSTEM_TENANT_ID && c.isActive === true)
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
