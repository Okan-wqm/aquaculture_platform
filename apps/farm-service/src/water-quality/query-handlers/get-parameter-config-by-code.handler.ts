/**
 * GetParameterConfigByCodeHandler
 *
 * GetParameterConfigByCodeQuery'yi isler ve tek bir parametre
 * konfigurasyonunu code ile doner.
 *
 * @module WaterQuality/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetParameterConfigByCodeQuery): Promise<WaterQualityParameterConfig> {
    const { tenantId, code } = query;

    this.logger.debug(`Getting parameter config by code "${code}" for tenant ${tenantId}`);

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const config = await queryRunner.manager.findOne(WaterQualityParameterConfig, {
        where: { code, tenantId },
      });

      if (!config) {
        throw new NotFoundException(
          `Parameter config with code "${code}" not found for tenant "${tenantId}"`,
        );
      }

      return config;
    });
  }
}
