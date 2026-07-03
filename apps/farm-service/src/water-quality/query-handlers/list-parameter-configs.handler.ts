/**
 * ListParameterConfigsHandler
 *
 * ListParameterConfigsQuery'yi isler ve filtrelenmis parametre
 * konfigurasyonlarini doner.
 *
 * @module WaterQuality/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { ListParameterConfigsQuery } from '../queries/list-parameter-configs.query';
import { WaterQualityParameterConfig, ParameterGroup } from '../entities/water-quality-parameter-config.entity';

@Injectable()
@QueryHandler(ListParameterConfigsQuery)
export class ListParameterConfigsHandler
  implements IQueryHandler<ListParameterConfigsQuery, WaterQualityParameterConfig[]>
{
  private readonly logger = new Logger(ListParameterConfigsHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListParameterConfigsQuery): Promise<WaterQualityParameterConfig[]> {
    const { tenantId, filters } = query;

    this.logger.debug(`Listing parameter configs for tenant ${tenantId}`);

    const where: FindOptionsWhere<WaterQualityParameterConfig> = { tenantId };

    if (filters) {
      if (filters.group) {
        where.group = filters.group as ParameterGroup;
      }
      if (filters.isActive !== undefined) {
        where.isActive = filters.isActive;
      }
      if (filters.isVisible !== undefined) {
        where.isVisible = filters.isVisible;
      }
    }

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(WaterQualityParameterConfig, {
        where,
        order: { displayOrder: 'ASC' },
      }),
    );
  }
}
