import { Injectable, NotFoundException } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import {
  GetConfigurationQuery,
  GetConfigurationByIdQuery,
} from '../queries/get-configuration.query';
import { Configuration, ConfigEnvironment } from '../entities/configuration.entity';
import { SYSTEM_TENANT_ID } from '../configuration.constants';

@Injectable()
@QueryHandler(GetConfigurationQuery)
export class GetConfigurationHandler
  implements IQueryHandler<GetConfigurationQuery, Configuration>
{
  constructor(
    @InjectRepository(Configuration)
    private readonly configRepository: Repository<Configuration>,
  ) {}

  async execute(query: GetConfigurationQuery): Promise<Configuration> {
    const { tenantId, service, key, environment } = query;
    const env = (environment as ConfigEnvironment) || ConfigEnvironment.ALL;

    // Single query with both tenant-specific and system-wide fallback.
    // Include inactive tenant rows so tombstones can suppress system fallback.
    const whereConditions: FindOptionsWhere<Configuration>[] = [
      { tenantId, service, key, environment: env },
    ];

    if (tenantId !== SYSTEM_TENANT_ID) {
      whereConditions.push({
        tenantId: SYSTEM_TENANT_ID,
        service,
        key,
        environment: env,
        isActive: true,
      });
    }

    const configurations = await this.configRepository.find({
      where: whereConditions,
      take: 2,
    });

    // Prefer tenant-specific over system-wide
    const tenantConfiguration = configurations.find((c) => c.tenantId === tenantId);
    const systemConfiguration = configurations.find((c) => c.tenantId === SYSTEM_TENANT_ID);
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
