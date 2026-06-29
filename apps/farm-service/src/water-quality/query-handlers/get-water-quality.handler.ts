/**
 * Get Water Quality Measurement Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-076 / FARM-HIGH-060).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { GetWaterQualityQuery } from '../queries/get-water-quality.query';

@QueryHandler(GetWaterQualityQuery)
export class GetWaterQualityHandler implements IQueryHandler<GetWaterQualityQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetWaterQualityQuery): Promise<WaterQualityMeasurement> {
    const { tenantId, id } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const measurement = await queryRunner.manager.findOne(WaterQualityMeasurement, {
        where: { id, tenantId },
        relations: ['tank'],
      });
      if (!measurement) {
        throw new NotFoundException(`Water quality measurement ${id} not found`);
      }
      return measurement;
    });
  }
}
