/**
 * List Critical Water Quality Tanks Query Handler (life-safety surface) —
 * fail-closed tenant boundary (FARM-HIGH-076 / FARM-HIGH-060). Returns the
 * latest measurement per tank whose overall status is CRITICAL or WARNING.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import {
  WaterQualityMeasurement,
  WaterQualityStatus,
} from '../entities/water-quality-measurement.entity';
import { ListCriticalWaterQualityQuery } from '../queries/list-critical-water-quality.query';

@QueryHandler(ListCriticalWaterQualityQuery)
export class ListCriticalWaterQualityHandler
  implements IQueryHandler<ListCriticalWaterQualityQuery>
{
  async execute(query: ListCriticalWaterQualityQuery): Promise<WaterQualityMeasurement[]> {
    const { scope } = query;
    const tenantId = scope.tenantId;
    const subQuery = scope.manager
      .createQueryBuilder(WaterQualityMeasurement, 'wq')
      .select('MAX(wq.measuredAt)', 'maxDate')
      .addSelect('wq.tankId', 'tankId')
      .where('wq.tenantId = :tenantId', { tenantId })
      .andWhere('wq.tankId IS NOT NULL')
      .groupBy('wq.tankId');

    return scope.manager
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
  }
}
