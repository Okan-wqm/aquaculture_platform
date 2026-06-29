/**
 * List Critical Water Quality Tanks Query Handler (life-safety surface) —
 * fail-closed tenant boundary (FARM-HIGH-076 / FARM-HIGH-060). Returns the
 * latest measurement per tank whose overall status is CRITICAL or WARNING.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import {
  WaterQualityMeasurement,
  WaterQualityStatus,
} from '../entities/water-quality-measurement.entity';
import { ListCriticalWaterQualityQuery } from '../queries/list-critical-water-quality.query';

@QueryHandler(ListCriticalWaterQualityQuery)
export class ListCriticalWaterQualityHandler
  implements IQueryHandler<ListCriticalWaterQualityQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListCriticalWaterQualityQuery): Promise<WaterQualityMeasurement[]> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const subQuery = queryRunner.manager
        .createQueryBuilder(WaterQualityMeasurement, 'wq')
        .select('MAX(wq.measuredAt)', 'maxDate')
        .addSelect('wq.tankId', 'tankId')
        .where('wq.tenantId = :tenantId', { tenantId })
        .andWhere('wq.tankId IS NOT NULL')
        .groupBy('wq.tankId');

      return queryRunner.manager
        .createQueryBuilder(WaterQualityMeasurement, 'measurement')
        .innerJoin(
          `(${subQuery.getQuery()})`,
          'latest',
          'measurement.tankId = latest.tankId AND measurement.measuredAt = latest.maxDate',
        )
        .setParameters(subQuery.getParameters())
        .where('measurement.tenantId = :tenantId', { tenantId })
        .andWhere('measurement.overallStatus IN (:...statuses)', {
          statuses: [WaterQualityStatus.CRITICAL, WaterQualityStatus.WARNING],
        })
        .leftJoinAndSelect('measurement.tank', 'tank')
        .orderBy('measurement.overallStatus', 'ASC') // CRITICAL first
        .getMany();
    });
  }
}
