/**
 * Get System Water Quality Chart Query Handler — fail-closed tenant boundary.
 * Resolves the system's tanks then returns their measurements in the window; a
 * tank's measurements are matched by unit (measurementUnitMatchSql), so its
 * batch-entered rows (filed as `equipmentId`) are charted too.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, FindOptionsWhere } from 'typeorm';

import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { GetSystemWaterQualityChartQuery } from '../queries/get-system-water-quality-chart.query';
import { measurementUnitMatchSql } from '../services/measurement-unit-reader';

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
      const unitIds = tanks.map((t) => t.id);
      if (unitIds.length === 0) return [];

      return queryRunner.manager
        .createQueryBuilder(WaterQualityMeasurement, 'wq')
        .select([
          'wq.id',
          'wq.measuredAt',
          'wq.tankId',
          'wq.equipmentId',
          'wq.temperature',
          'wq.dissolvedOxygen',
          'wq.pH',
          'wq.ammonia',
          'wq.nitrite',
          'wq.overallStatus',
          'wq.parameters',
        ])
        .leftJoinAndSelect('wq.tank', 'tank')
        .where('wq.tenantId = :tenantId', { tenantId })
        .andWhere(measurementUnitMatchSql('wq', 'IN (:...unitIds)'), { unitIds })
        .andWhere('wq.measuredAt BETWEEN :fromDate AND :toDate', { fromDate, toDate })
        .orderBy('wq.measuredAt', 'ASC')
        .getMany();
    });
  }
}
