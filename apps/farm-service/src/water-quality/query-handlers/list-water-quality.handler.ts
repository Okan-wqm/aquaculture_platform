/**
 * List Water Quality Measurements Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-076 / FARM-HIGH-060).
 */
import {
  IStandardPaginatedResult,
  createStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { Between, FindOptionsWhere, In, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';

import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { ListWaterQualityQuery } from '../queries/list-water-quality.query';

@QueryHandler(ListWaterQualityQuery)
export class ListWaterQualityHandler implements IQueryHandler<ListWaterQualityQuery> {
  async execute(
    query: ListWaterQualityQuery,
  ): Promise<IStandardPaginatedResult<WaterQualityMeasurement>> {
    const { scope, filters } = query;
    const tenantId = scope.tenantId;
    const {
      tankId,
      pondId,
      siteId,
      batchId,
      systemId,
      status,
      source,
      fromDate,
      toDate,
      limit = 50,
      offset = 0,
    } = filters;

    const where: FindOptionsWhere<WaterQualityMeasurement> = { tenantId };

    // System-level: resolve the system's tanks, then filter by those tankIds.
    if (systemId) {
      const tanks = await scope.manager.find(Tank, {
        where: { tenantId, systemId } as FindOptionsWhere<Tank>,
        select: ['id'],
      });
      const tankIds = tanks.map((t) => t.id);
      if (tankIds.length === 0) {
        return createStandardPaginatedResult([], 0, 1, limit);
      }
      where.tankId = In(tankIds);
    } else if (tankId) {
      where.tankId = tankId;
    }
    if (pondId) where.pondId = pondId;
    if (siteId) where.siteId = siteId;
    if (batchId) where.batchId = batchId;
    if (status) where.overallStatus = status;
    if (source) where.source = source;

    if (fromDate && toDate) {
      where.measuredAt = Between(fromDate, toDate);
    } else if (fromDate) {
      where.measuredAt = MoreThanOrEqual(fromDate);
    } else if (toDate) {
      where.measuredAt = LessThanOrEqual(toDate);
    }

    const [items, total] = await scope.manager.findAndCount(WaterQualityMeasurement, {
      where,
      order: { measuredAt: 'DESC' },
      take: limit,
      skip: offset,
      relations: ['tank'],
    });

    const page = Math.floor(offset / limit) + 1;
    return createStandardPaginatedResult(items, total, page, limit);
  }
}
