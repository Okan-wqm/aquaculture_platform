/**
 * List Critical Water Quality Tanks Query Handler (life-safety surface) —
 * fail-closed tenant boundary (FARM-HIGH-076 / FARM-HIGH-060). Returns the
 * latest measurement per unit (a tank or water equipment, named by
 * measurementUnitIdSql) whose overall status is CRITICAL or WARNING.
 *
 * Keyed on the unit, not on `tankId`: a biofilter's or sump's row has no
 * `tankId`, and a tank entered through the batch form was filed only as
 * `equipmentId` — a tank-keyed list dropped both from the life-safety view.
 * The subquery's columns are quoted: Postgres folds an unquoted
 * `latest.maxDate` to `latest.maxdate`, which the subquery does not have.
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
import { measurementUnitIdSql } from '../services/measurement-unit-reader';

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
      const unitId = measurementUnitIdSql('wq');
      const subQuery = queryRunner.manager
        .createQueryBuilder(WaterQualityMeasurement, 'wq')
        .select('MAX(wq.measuredAt)', 'maxDate')
        .addSelect(unitId, 'unitId')
        .where('wq.tenantId = :tenantId', { tenantId })
        .andWhere(`${unitId} IS NOT NULL`)
        .groupBy(unitId);

      return queryRunner.manager
        .createQueryBuilder(WaterQualityMeasurement, 'measurement')
        .innerJoin(
          `(${subQuery.getQuery()})`,
          'latest',
          `${measurementUnitIdSql('measurement')} = "latest"."unitId" ` +
            'AND measurement.measuredAt = "latest"."maxDate"',
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
