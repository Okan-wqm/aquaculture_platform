/**
 * Get Latest Water Quality (by unit) Query Handler — fail-closed tenant boundary.
 * The unit is matched by measurementUnitMatchSql, so a tank's batch-entered
 * rows and a water-equipment unit's rows are found too.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { GetLatestWaterQualityQuery } from '../queries/get-latest-water-quality.query';
import { measurementUnitMatchSql } from '../services/measurement-unit-reader';

@QueryHandler(GetLatestWaterQualityQuery)
export class GetLatestWaterQualityHandler implements IQueryHandler<GetLatestWaterQualityQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetLatestWaterQualityQuery): Promise<WaterQualityMeasurement | null> {
    const { tenantId, unitId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager
        .createQueryBuilder(WaterQualityMeasurement, 'wq')
        .where('wq.tenantId = :tenantId', { tenantId })
        .andWhere(measurementUnitMatchSql('wq', '= :unitId'), { unitId })
        .orderBy('wq.measuredAt', 'DESC')
        .getOne(),
    );
  }
}
