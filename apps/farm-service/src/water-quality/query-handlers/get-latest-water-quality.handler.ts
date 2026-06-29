/**
 * Get Latest Water Quality (by tank) Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { GetLatestWaterQualityQuery } from '../queries/get-latest-water-quality.query';

@QueryHandler(GetLatestWaterQualityQuery)
export class GetLatestWaterQualityHandler implements IQueryHandler<GetLatestWaterQualityQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetLatestWaterQualityQuery): Promise<WaterQualityMeasurement | null> {
    const { tenantId, tankId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.findOne(WaterQualityMeasurement, {
        where: { tenantId, tankId },
        order: { measuredAt: 'DESC' },
      }),
    );
  }
}
