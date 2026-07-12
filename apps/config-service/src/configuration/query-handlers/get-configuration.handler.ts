import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { runInRlsScopedRead } from '../../database/rls-scoped-session';
import { SYSTEM_TENANT_ID } from '../configuration.constants';
import { Configuration, ConfigEnvironment } from '../entities/configuration.entity';
import {
  GetConfigurationQuery,
  GetConfigurationByIdQuery,
} from '../queries/get-configuration.query';

@Injectable()
@QueryHandler(GetConfigurationQuery)
export class GetConfigurationHandler
  implements IQueryHandler<GetConfigurationQuery, Configuration>
{
  constructor(private readonly dataSource: DataSource) {}

  async execute(query: GetConfigurationQuery): Promise<Configuration> {
    const { tenantId, service, key, environment } = query;
    const env = (environment as ConfigEnvironment) || ConfigEnvironment.ALL;

    // WHY two explicitly-scoped reads: FORCE RLS exposes only the partition
    // matching the app.current_tenant GUC, so the tenant row and the SYSTEM
    // fallback row can never be fetched under one scope. Each read owns its
    // scope transaction-locally (see rls-scoped-session.ts). The tenant read
    // includes inactive rows so tombstones can suppress the system fallback.
    const tenantConfiguration = await runInRlsScopedRead(this.dataSource, tenantId, (manager) =>
      tenantManagerRepo(manager, Configuration, tenantId).findOne({
        where: { service, key, environment: env },
      }),
    );

    const systemConfiguration =
      tenantId === SYSTEM_TENANT_ID
        ? tenantConfiguration
        : await runInRlsScopedRead(this.dataSource, SYSTEM_TENANT_ID, (manager) =>
            tenantManagerRepo(manager, Configuration, SYSTEM_TENANT_ID).findOne({
              where: { service, key, environment: env, isActive: true },
            }),
          );
    const configuration =
      tenantConfiguration?.isActive === false && tenantConfiguration.suppressFallback
        ? tenantConfiguration
        : tenantConfiguration?.isActive === true
          ? tenantConfiguration
          : systemConfiguration;

    if (!configuration) {
      throw new NotFoundException(`Configuration not found: ${service}/${key}`);
    }

    return configuration;
  }
}

@Injectable()
@QueryHandler(GetConfigurationByIdQuery)
export class GetConfigurationByIdHandler
  implements IQueryHandler<GetConfigurationByIdQuery, Configuration>
{
  constructor(
    @InjectRepository(Configuration)
    private readonly configRepository: Repository<Configuration>,
  ) {}

  async execute(query: GetConfigurationByIdQuery): Promise<Configuration> {
    const { tenantId, id } = query;

    const configuration = await this.configRepository.findOne({
      where: { id, tenantId, isActive: true },
    });

    if (!configuration) {
      throw new NotFoundException(`Configuration not found: ${id}`);
    }

    return configuration;
  }
}
