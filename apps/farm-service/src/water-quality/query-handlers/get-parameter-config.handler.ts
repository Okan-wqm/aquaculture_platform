/**
 * GetParameterConfigHandler
 *
 * GetParameterConfigQuery'yi isler ve tek bir parametre
 * konfigurasyonunu ID ile doner.
 *
 * @module WaterQuality/QueryHandlers
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetParameterConfigQuery } from '../queries/get-parameter-config.query';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

@Injectable()
@QueryHandler(GetParameterConfigQuery)
export class GetParameterConfigHandler
  implements IQueryHandler<GetParameterConfigQuery, WaterQualityParameterConfig>
{
  private readonly logger = new Logger(GetParameterConfigHandler.name);

  constructor(
    @InjectRepository(WaterQualityParameterConfig)
    private readonly repository: Repository<WaterQualityParameterConfig>,
  ) {}

  async execute(query: GetParameterConfigQuery): Promise<WaterQualityParameterConfig> {
    const { tenantId, configId } = query;

    this.logger.debug(`Getting parameter config ${configId} for tenant ${tenantId}`);

    const config = await this.repository.findOne({
      where: { id: configId, tenantId },
    });

    if (!config) {
      throw new NotFoundException(
        `Parameter config with id "${configId}" not found for tenant "${tenantId}"`,
      );
    }

    return config;
  }
}
