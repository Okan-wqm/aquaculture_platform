import { Injectable, NotFoundException } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import {
  GetConfigurationQuery,
  GetConfigurationByIdQuery,
} from '../queries/get-configuration.query';
import { Configuration, ConfigEnvironment } from '../entities/configuration.entity';

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

    // Single query with both tenant-specific and global fallback
    const whereConditions: FindOptionsWhere<Configuration>[] = [
      { tenantId, service, key, environment: env, isActive: true },
    ];

    if (tenantId !== 'global') {
      whereConditions.push({
        tenantId: 'global',
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

    // Prefer tenant-specific over global
    const configuration =
      configurations.find((c) => c.tenantId === tenantId) ||
      configurations.find((c) => c.tenantId === 'global');

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
