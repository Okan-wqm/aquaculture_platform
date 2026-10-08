/**
 * Get Water Quality Chart (single unit, date range) Query Handler — fail-closed
 * tenant boundary. The unit is matched by measurementUnitMatchSql, so a tank's
 * batch-entered rows and a water-equipment unit's rows are charted too.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { GetWaterQualityChartQuery } from '../queries/get-water-quality-chart.query';
import { measurementUnitMatchSql } from '../services/measurement-unit-reader';

@QueryHandler(GetWaterQualityChartQuery)
export class GetWaterQualityChartHandler implements IQueryHandler<GetWaterQualityChartQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetWaterQualityChartQuery): Promise<WaterQualityMeasurement[]> {
    const { tenantId, unitId, fromDate, toDate } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager
        .createQueryBuilder(WaterQualityMeasurement, 'wq')
        .select([
          'wq.id',
          'wq.measuredAt',
          'wq.temperature',
          'wq.dissolvedOxygen',
          'wq.pH',
          'wq.ammonia',
          'wq.nitrite',
          'wq.overallStatus',
        ])
        .where('wq.tenantId = :tenantId', { tenantId })
        .andWhere(measurementUnitMatchSql('wq', '= :unitId'), { unitId })
        .andWhere('wq.measuredAt BETWEEN :fromDate AND :toDate', { fromDate, toDate })
        .orderBy('wq.measuredAt', 'ASC')
        .getMany(),
    );
  }
}
