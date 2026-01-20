/**
 * UpdateBatchWeightFromSampleHandler
 *
 * UpdateBatchWeightFromSampleCommand'ı işler ve batch ağırlığını günceller.
 *
 * @module Growth/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateBatchWeightFromSampleCommand } from '../commands/update-batch-weight-from-sample.command';
import { GrowthMeasurement } from '../entities/growth-measurement.entity';
import { Batch } from '../../batch/entities/batch.entity';

@Injectable()
@CommandHandler(UpdateBatchWeightFromSampleCommand)
export class UpdateBatchWeightFromSampleHandler implements ICommandHandler<UpdateBatchWeightFromSampleCommand, Batch> {
  constructor(
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
  ) {}

  async execute(command: UpdateBatchWeightFromSampleCommand): Promise<Batch> {
    const { tenantId, batchId, measurementId, userId } = command;

    // Batch'i bul
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    // Measurement'ı bul
    const measurement = await this.measurementRepository.findOne({
      where: { id: measurementId, tenantId, batchId },
    });

    if (!measurement) {
      throw new NotFoundException(`Measurement ${measurementId} bulunamadı`);
    }

    if (measurement.isProcessed) {
      throw new BadRequestException('Bu ölçüm zaten batch ağırlığına uygulanmış');
    }

    // Batch'in actual weight tracking'ini güncelle
    if (batch.weight && batch.weight.actual) {
      batch.weight.actual.avgWeight = measurement.averageWeight;
      batch.weight.actual.totalBiomass = measurement.estimatedBiomass;
      batch.weight.actual.lastMeasuredAt = measurement.measurementDate;
    }

    await this.batchRepository.save(batch);

    // Measurement'ı işlenmiş olarak işaretle
    measurement.isProcessed = true;
    await this.measurementRepository.save(measurement);

    return batch;
  }
}
