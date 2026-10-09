/**
 * Get Water Quality Statistics (one unit) Query Handler — fail-closed tenant
 * boundary. Aggregate averages/counts over the trailing window + the latest
 * measurement, both read on the same tenant-asserted connection. The unit is
 * matched by measurementUnitMatchSql (a tank's batch-entered rows, a
 * water-equipment unit's rows).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import {
  WaterQualityMeasurement,
  WaterQualityStatus,
} from '../entities/water-quality-measurement.entity';
import { GetTankWaterQualityStatisticsQuery } from '../queries/get-tank-water-quality-statistics.query';
import { measurementUnitMatchSql } from '../services/measurement-unit-reader';
import { WaterQualityStatsResult } from './water-quality-stats.result';

@QueryHandler(GetTankWaterQualityStatisticsQuery)
export class GetTankWaterQualityStatisticsHandler
  implements IQueryHandler<GetTankWaterQualityStatisticsQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetTankWaterQualityStatisticsQuery): Promise<WaterQualityStatsResult> {
    const { tenantId, unitId, days } = query;
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const stats = await queryRunner.manager
        .createQueryBuilder(WaterQualityMeasurement, 'wq')
        .select('AVG(wq.temperature)', 'avgTemperature')
        .addSelect('AVG(wq.dissolvedOxygen)', 'avgDO')
        .addSelect('AVG(wq.pH)', 'avgPH')
        .addSelect('AVG(wq.ammonia)', 'avgAmmonia')
        .addSelect('AVG(wq.nitrite)', 'avgNitrite')
        .addSelect('COUNT(*)', 'measurementCount')
        .addSelect(
          'SUM(CASE WHEN wq.overallStatus = :criticalStatus THEN 1 ELSE 0 END)',
          'criticalCount',
        )
        .addSelect(
          'SUM(CASE WHEN wq.overallStatus = :warningStatus THEN 1 ELSE 0 END)',
          'warningCount',
        )
        .where('wq.tenantId = :tenantId', { tenantId })
        .andWhere(measurementUnitMatchSql('wq', '= :unitId'), { unitId })
        .andWhere('wq.measuredAt >= :fromDate', { fromDate })
        .setParameters({
          criticalStatus: WaterQualityStatus.CRITICAL,
          warningStatus: WaterQualityStatus.WARNING,
        })
        .getRawOne();

      const lastMeasurement = await queryRunner.manager
        .createQueryBuilder(WaterQualityMeasurement, 'wq')
        .where('wq.tenantId = :tenantId', { tenantId })
        .andWhere(measurementUnitMatchSql('wq', '= :unitId'), { unitId })
        .orderBy('wq.measuredAt', 'DESC')
        .getOne();

      return {
        avgTemperature: stats.avgTemperature ? parseFloat(stats.avgTemperature) : null,
        avgDO: stats.avgDO ? parseFloat(stats.avgDO) : null,
        avgPH: stats.avgPH ? parseFloat(stats.avgPH) : null,
        avgAmmonia: stats.avgAmmonia ? parseFloat(stats.avgAmmonia) : null,
        avgNitrite: stats.avgNitrite ? parseFloat(stats.avgNitrite) : null,
        measurementCount: parseInt(stats.measurementCount, 10) || 0,
        criticalCount: parseInt(stats.criticalCount, 10) || 0,
        warningCount: parseInt(stats.warningCount, 10) || 0,
        lastMeasurement,
      };
    });
  }
}
