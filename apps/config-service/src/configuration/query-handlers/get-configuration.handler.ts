import { Injectable, NotFoundException } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

    // Try to find tenant-specific config first
    let configuration = await this.configRepository.findOne({
      where: {
        tenantId,
        service,
        key,
        environment: environment as ConfigEnvironment || ConfigEnvironment.ALL,
        isActive: true,
      },
    });

    // Fall back to global config if tenant-specific not found
    if (!configuration && tenantId !== 'global') {
      configuration = await this.configRepository.findOne({
        where: {
          tenantId: 'global',
          service,
          key,
          environment: environment as ConfigEnvironment || ConfigEnvironment.ALL,
          isActive: true,
        },
      });
    }

    if (!configuration) {
      throw new NotFoundException(
        `Configuration not found: ${service}/${key}`,
      );
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
      where: { id, tenantId },
    });

    if (!configuration) {
      throw new NotFoundException(`Configuration not found: ${id}`);
    }

    return configuration;
  }
}
