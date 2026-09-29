/**
 * Get System Water Quality Statistics Query Handler — fail-closed tenant
 * boundary. Aggregates over all tanks in a system + the latest measurement.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { FindOptionsWhere, In } from 'typeorm';

import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { GetSystemWaterQualityStatisticsQuery } from '../queries/get-system-water-quality-statistics.query';
import { WaterQualityStatsResult } from './water-quality-stats.result';

const EMPTY_STATS: WaterQualityStatsResult = {
  avgTemperature: null,
  avgDO: null,
  avgPH: null,
  avgAmmonia: null,
  avgNitrite: null,
  measurementCount: 0,
  criticalCount: 0,
  warningCount: 0,
  lastMeasurement: null,
};

@QueryHandler(GetSystemWaterQualityStatisticsQuery)
export class GetSystemWaterQualityStatisticsHandler
  implements IQueryHandler<GetSystemWaterQualityStatisticsQuery>
{
  async execute(query: GetSystemWaterQualityStatisticsQuery): Promise<WaterQualityStatsResult> {
    const { scope, systemId, days } = query;
    const tenantId = scope.tenantId;
    const tanks = await scope.manager.find(Tank, {
      where: { tenantId, systemId } as FindOptionsWhere<Tank>,
      select: ['id'],
    });
    const tankIds = tanks.map((t) => t.id);
    if (tankIds.length === 0) {
      return { ...EMPTY_STATS };
    }

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    const stats = await scope.manager
      .createQueryBuilder(WaterQualityMeasurement, 'wq')
      .select('AVG(wq.temperature)', 'avgTemperature')
      .addSelect('AVG(wq.dissolvedOxygen)', 'avgDO')
      .addSelect('AVG(wq.pH)', 'avgPH')
      .addSelect('AVG(wq.ammonia)', 'avgAmmonia')
      .addSelect('AVG(wq.nitrite)', 'avgNitrite')
      .addSelect('COUNT(*)', 'measurementCount')
      .addSelect("SUM(CASE WHEN wq.\"overallStatus\" = 'critical' THEN 1 ELSE 0 END)", 'criticalCount')
      .addSelect("SUM(CASE WHEN wq.\"overallStatus\" = 'warning' THEN 1 ELSE 0 END)", 'warningCount')
      .where('wq.tenantId = :tenantId', { tenantId })
      .andWhere('wq.tankId IN (:...tankIds)', { tankIds })
      .andWhere('wq.measuredAt >= :fromDate', { fromDate })
      .getRawOne();

    const lastMeasurement = await scope.manager.findOne(WaterQualityMeasurement, {
      where: { tenantId, tankId: In(tankIds) },
      order: { measuredAt: 'DESC' },
    });

    return {
      avgTemperature: stats?.avgTemperature ? parseFloat(stats.avgTemperature) : null,
      avgDO: stats?.avgDO ? parseFloat(stats.avgDO) : null,
      avgPH: stats?.avgPH ? parseFloat(stats.avgPH) : null,
      avgAmmonia: stats?.avgAmmonia ? parseFloat(stats.avgAmmonia) : null,
      avgNitrite: stats?.avgNitrite ? parseFloat(stats.avgNitrite) : null,
      measurementCount: parseInt(stats?.measurementCount, 10) || 0,
      criticalCount: parseInt(stats?.criticalCount, 10) || 0,
      warningCount: parseInt(stats?.warningCount, 10) || 0,
      lastMeasurement,
    };
  }
}
