/**
 * GetParameterConfigHandler
 *
 * GetParameterConfigQuery'yi isler ve tek bir parametre
 * konfigurasyonunu ID ile doner.
 *
 * @module WaterQuality/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetParameterConfigQuery): Promise<WaterQualityParameterConfig> {
    const { tenantId, configId } = query;

    this.logger.debug(`Getting parameter config ${configId} for tenant ${tenantId}`);

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const config = await queryRunner.manager.findOne(WaterQualityParameterConfig, {
        where: { id: configId, tenantId },
      });

      if (!config) {
        throw new NotFoundException(
          `Parameter config with id "${configId}" not found for tenant "${tenantId}"`,
        );
      }

      return config;
    });
  }
}
