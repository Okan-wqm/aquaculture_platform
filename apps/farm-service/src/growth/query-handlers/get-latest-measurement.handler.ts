/**
 * GetLatestMeasurementHandler
 *
 * GetLatestMeasurementQuery'yi işler ve son ölçümü döner.
 *
 * @module Growth/QueryHandlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetLatestMeasurementQuery } from '../queries/get-latest-measurement.query';
import { GrowthMeasurement } from '../entities/growth-measurement.entity';
import { Batch } from '../../batch/entities/batch.entity';

@Injectable()
@QueryHandler(GetLatestMeasurementQuery)
export class GetLatestMeasurementHandler implements IQueryHandler<GetLatestMeasurementQuery, GrowthMeasurement | null> {
  constructor(
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
  ) {}

  async execute(query: GetLatestMeasurementQuery): Promise<GrowthMeasurement | null> {
    const { tenantId, batchId } = query;

    // Batch'i doğrula
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    // En son ölçümü bul
    const measurement = await this.measurementRepository.findOne({
      where: { tenantId, batchId },
      order: { measurementDate: 'DESC' },
      relations: ['batch'],
    });

    return measurement;
  }
}
