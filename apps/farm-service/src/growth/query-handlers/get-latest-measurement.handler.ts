/**
 * GetLatestMeasurementHandler
 *
 * GetLatestMeasurementQuery'yi işler ve son ölçümü döner.
 *
 * @module Growth/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetLatestMeasurementQuery } from '../queries/get-latest-measurement.query';
import { GrowthMeasurement } from '../entities/growth-measurement.entity';
import { Batch } from '../../batch/entities/batch.entity';

@Injectable()
@QueryHandler(GetLatestMeasurementQuery)
export class GetLatestMeasurementHandler implements IQueryHandler<GetLatestMeasurementQuery, GrowthMeasurement | null> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetLatestMeasurementQuery): Promise<GrowthMeasurement | null> {
    const { tenantId, batchId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Batch'i doğrula
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }

      // En son ölçümü bul
      return queryRunner.manager.findOne(GrowthMeasurement, {
        where: { tenantId, batchId },
        order: { measurementDate: 'DESC' },
        relations: ['batch'],
      });
    });
  }
}
