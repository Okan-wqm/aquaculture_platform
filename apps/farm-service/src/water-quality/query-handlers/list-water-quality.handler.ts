/**
 * List Water Quality Measurements Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-076 / FARM-HIGH-060).
 *
 * Every unit filter (`unitId`, `tankId`, a system's tanks) matches a
 * measurement by its unit (measurementUnitMatchSql), not by the `tankId`
 * column: a biofilter's row has no `tankId`, and a tank entered through the
 * batch form was filed only as `equipmentId`. The filters combine with AND.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import {
  IStandardPaginatedResult,
  createStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, FindOptionsWhere } from 'typeorm';

import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { ListWaterQualityQuery } from '../queries/list-water-quality.query';
import { measurementUnitMatchSql } from '../services/measurement-unit-reader';

@QueryHandler(ListWaterQualityQuery)
export class ListWaterQualityHandler implements IQueryHandler<ListWaterQualityQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    query: ListWaterQualityQuery,
  ): Promise<IStandardPaginatedResult<WaterQualityMeasurement>> {
    const { tenantId, filters } = query;
    const {
      unitId,
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

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(WaterQualityMeasurement, 'wq')
        .leftJoinAndSelect('wq.tank', 'tank')
        .where('wq.tenantId = :tenantId', { tenantId });

      // System-level: resolve the system's tanks, then match their measurements.
      if (systemId) {
        const tanks = await queryRunner.manager.find(Tank, {
          where: { tenantId, systemId } as FindOptionsWhere<Tank>,
          select: ['id'],
        });
        const systemUnitIds = tanks.map((t) => t.id);
        if (systemUnitIds.length === 0) {
          return createStandardPaginatedResult([], 0, 1, limit);
        }
        qb.andWhere(measurementUnitMatchSql('wq', 'IN (:...systemUnitIds)'), { systemUnitIds });
      }
      if (unitId) qb.andWhere(measurementUnitMatchSql('wq', '= :unitId'), { unitId });
      if (tankId) qb.andWhere(measurementUnitMatchSql('wq', '= :tankId'), { tankId });
      if (pondId) qb.andWhere('wq.pondId = :pondId', { pondId });
      if (siteId) qb.andWhere('wq.siteId = :siteId', { siteId });
      if (batchId) qb.andWhere('wq.batchId = :batchId', { batchId });
      if (status) qb.andWhere('wq.overallStatus = :status', { status });
      if (source) qb.andWhere('wq.source = :source', { source });
      if (fromDate) qb.andWhere('wq.measuredAt >= :fromDate', { fromDate });
      if (toDate) qb.andWhere('wq.measuredAt <= :toDate', { toDate });

      const [items, total] = await qb
        .orderBy('wq.measuredAt', 'DESC')
        .take(limit)
        .skip(offset)
        .getManyAndCount();

      const page = Math.floor(offset / limit) + 1;
      return createStandardPaginatedResult(items, total, page, limit);
    });
  }
}
