/**
 * Get Water Quality Chart (single tank, date range) Query Handler — fail-closed
 * tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { Between, DataSource } from 'typeorm';

import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { GetWaterQualityChartQuery } from '../queries/get-water-quality-chart.query';

@QueryHandler(GetWaterQualityChartQuery)
export class GetWaterQualityChartHandler implements IQueryHandler<GetWaterQualityChartQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetWaterQualityChartQuery): Promise<WaterQualityMeasurement[]> {
    const { tenantId, tankId, fromDate, toDate } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(WaterQualityMeasurement, {
        where: { tenantId, tankId, measuredAt: Between(fromDate, toDate) },
        order: { measuredAt: 'ASC' },
        select: [
          'id',
          'measuredAt',
          'temperature',
          'dissolvedOxygen',
          'pH',
          'ammonia',
          'nitrite',
          'overallStatus',
        ],
      }),
    );
  }
}
