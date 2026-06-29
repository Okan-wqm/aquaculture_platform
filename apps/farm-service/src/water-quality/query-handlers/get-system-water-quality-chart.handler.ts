/**
 * Get System Water Quality Chart Query Handler — fail-closed tenant boundary.
 * Resolves the system's tanks then returns their measurements in the window.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { Between, DataSource, FindOptionsWhere, In } from 'typeorm';

import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { GetSystemWaterQualityChartQuery } from '../queries/get-system-water-quality-chart.query';

@QueryHandler(GetSystemWaterQualityChartQuery)
export class GetSystemWaterQualityChartHandler
  implements IQueryHandler<GetSystemWaterQualityChartQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetSystemWaterQualityChartQuery): Promise<WaterQualityMeasurement[]> {
    const { tenantId, systemId, fromDate, toDate } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const tanks = await queryRunner.manager.find(Tank, {
        where: { tenantId, systemId } as FindOptionsWhere<Tank>,
        select: ['id'],
      });
      const tankIds = tanks.map((t) => t.id);
      if (tankIds.length === 0) return [];

      return queryRunner.manager.find(WaterQualityMeasurement, {
        where: { tenantId, tankId: In(tankIds), measuredAt: Between(fromDate, toDate) },
        order: { measuredAt: 'ASC' },
        select: [
          'id',
          'measuredAt',
          'tankId',
          'temperature',
          'dissolvedOxygen',
          'pH',
          'ammonia',
          'nitrite',
          'overallStatus',
          'parameters',
        ],
        relations: ['tank'],
      });
    });
  }
}
