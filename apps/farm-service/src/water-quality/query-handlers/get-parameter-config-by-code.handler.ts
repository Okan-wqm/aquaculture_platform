/**
 * GetParameterConfigByCodeHandler
 *
 * GetParameterConfigByCodeQuery'yi isler ve tek bir parametre
 * konfigurasyonunu code ile doner.
 *
 * @module WaterQuality/QueryHandlers
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetParameterConfigByCodeQuery } from '../queries/get-parameter-config-by-code.query';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

@Injectable()
@QueryHandler(GetParameterConfigByCodeQuery)
export class GetParameterConfigByCodeHandler
  implements IQueryHandler<GetParameterConfigByCodeQuery, WaterQualityParameterConfig>
{
  private readonly logger = new Logger(GetParameterConfigByCodeHandler.name);

  constructor(
    @InjectRepository(WaterQualityParameterConfig)
    private readonly repository: Repository<WaterQualityParameterConfig>,
  ) {}

  async execute(query: GetParameterConfigByCodeQuery): Promise<WaterQualityParameterConfig> {
    const { tenantId, code } = query;

    this.logger.debug(`Getting parameter config by code "${code}" for tenant ${tenantId}`);

    const config = await this.repository.findOne({
      where: { code, tenantId },
    });

    if (!config) {
      throw new NotFoundException(
        `Parameter config with code "${code}" not found for tenant "${tenantId}"`,
      );
    }

    return config;
  }
}
