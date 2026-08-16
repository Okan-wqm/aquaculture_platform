/**
 * UpdateBatchWeightFromSampleHandler
 *
 * UpdateBatchWeightFromSampleCommand'ı işler ve batch ağırlığını günceller.
 *
 * @module Growth/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateBatchWeightFromSampleCommand } from '../commands/update-batch-weight-from-sample.command';
import { GrowthMeasurement } from '../entities/growth-measurement.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { BatchAggregateMutationPort } from '../../batch/batch-aggregate-mutation.port';

// Growth statistics are computed at a 95% confidence interval, so applying a
// sample stamps the batch weight provenance with a 95% confidence level.
const WEIGHT_SAMPLE_CONFIDENCE_PERCENT = 95;

@Injectable()
@CommandHandler(UpdateBatchWeightFromSampleCommand)
export class UpdateBatchWeightFromSampleHandler
  implements ICommandHandler<UpdateBatchWeightFromSampleCommand, Batch>
{
  constructor(
    private readonly batchMutations: BatchAggregateMutationPort,
    private readonly dataSource: DataSource,
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
  ) {}

  async execute(command: UpdateBatchWeightFromSampleCommand): Promise<Batch> {
    const { tenantId, batchId, measurementId } = command;

    // Measurement'ı bul (non-tx validation read; immutable wrt the batch row)
    const measurement = await this.measurementRepository.findOne({
      where: { id: measurementId, tenantId, batchId },
    });

    if (!measurement) {
      throw new NotFoundException(`Measurement ${measurementId} bulunamadı`);
    }

    if (measurement.isProcessed) {
      throw new BadRequestException('Bu ölçüm zaten batch ağırlığına uygulanmış');
    }

    // Atomic + locked: re-read the batch under pessimistic_write INSIDE the tx
    // and mutate ONLY the weight.actual provenance fields, mirroring
    // record-growth-sample. Saving an externally-loaded full snapshot could
    // revert a concurrent mortality/cull/harvest's currentQuantity/feed
    // decrements (lost-update). Locking + field-scoped write prevents it, and
    // the isProcessed flip commits atomically with the weight update.
    // runInTenantTransaction pins search_path to tenant_<uuid> for the whole tx
    // (pool-checkout routing alone is not sufficient for transactional writes).
    return runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        const lockedBatch = await queryRunner.manager.findOne(Batch, {
          where: { id: batchId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });

        if (!lockedBatch) {
          throw new NotFoundException(`Batch ${batchId} bulunamadı`);
        }

        if (lockedBatch.weight?.actual) {
          lockedBatch.weight.actual.avgWeight = measurement.averageWeight;
          // Provenance snapshot; current biomass derives on read from the live
          // count × avgWeight, not from this stored figure.
          lockedBatch.weight.actual.totalBiomass = measurement.estimatedBiomass;
          lockedBatch.weight.actual.lastMeasuredAt = measurement.measurementDate;
          lockedBatch.weight.actual.sampleSize = measurement.sampleSize;
          lockedBatch.weight.actual.confidencePercent = WEIGHT_SAMPLE_CONFIDENCE_PERCENT;
        }

        await this.batchMutations.commitBatchTransition(mutationSession, {
          intent: 'growth_applied',
          aggregate: lockedBatch,
        });

        measurement.isProcessed = true;
        await queryRunner.manager.save(GrowthMeasurement, measurement);

        return lockedBatch;
      },
    );
  }
}
