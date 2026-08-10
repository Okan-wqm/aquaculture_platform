/**
 * UpdateBatchWeightFromSampleHandler
 *
 * Applies a PREVIOUSLY RECORDED measurement (one saved with
 * `updateBatchWeight = false`) to the stock it describes.
 *
 * Like RecordGrowthSampleHandler, this used to write `Batch.weight.actual` and
 * stop — so a sample applied after the fact re-based nothing the feeding plan
 * reads (`TankBatch.avgWeightG`). Both entry points now converge on the SAME
 * primitive, `BiomassGrowthApplierService`, with measurement provenance: there
 * is exactly one way a measured weight reaches a unit, whether it is applied
 * at recording time or later.
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
import {
  BiomassGrowthApplierService,
  type MeasurementProvenance,
} from '../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { resolveUnitHoldingBatch } from '../../batch/utils/unit-for-batch.util';

// Growth statistics are computed at a 95% confidence interval, so applying a
// sample stamps the batch weight provenance with a 95% confidence level.
const WEIGHT_SAMPLE_CONFIDENCE_PERCENT = 95;

@Injectable()
@CommandHandler(UpdateBatchWeightFromSampleCommand)
export class UpdateBatchWeightFromSampleHandler implements ICommandHandler<UpdateBatchWeightFromSampleCommand, Batch> {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly recalcService: DayPlanRecalcService,
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
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const provenance: MeasurementProvenance = {
        source: 'measurement',
        measurementId: measurement.id,
        measuredAt: measurement.measurementDate,
        sampleSize: measurement.sampleSize,
        confidencePercent: WEIGHT_SAMPLE_CONFIDENCE_PERCENT,
      };

      // The measurement recorded which tank it sampled; fall back to resolving
      // it from the stock when the record predates that (fail-closed if the
      // batch spans several tanks — one sample sizes ONE tank).
      const unitId = await resolveUnitHoldingBatch(
        manager,
        tenantId,
        batchId,
        measurement.tankId,
      );
      // K-1 canonical lock order: unit batches (batchId ASC) → TankBatch.
      const locked = unitId
        ? await this.growthApplier.lockUnitForGrowth(manager, tenantId, unitId)
        : null;

      let lockedBatch: Batch | null;
      if (locked) {
        if (!locked.batches.has(batchId)) {
          throw new BadRequestException(
            `Batch ${batchId} is not stocked in unit ${unitId} — the measurement ` +
              'cannot be applied to a tank that does not hold it.',
          );
        }
        // Re-bases the unit onto the MEASURED track and stamps every affected
        // batch's weight.actual + variance from its cross-unit shares.
        await this.growthApplier.reconcileMeasuredWeight(
          manager,
          tenantId,
          locked,
          measurement.averageWeight,
          provenance,
        );
        lockedBatch = locked.batches.get(batchId) ?? null;
      } else {
        // Batch is in no unit (pond-held / unallocated): record the measured
        // provenance on the batch through the same single writer.
        lockedBatch = await manager.findOne(Batch, {
          where: { id: batchId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (lockedBatch) {
          this.growthApplier.stampBatchWeight(
            lockedBatch,
            {
              biomassKg: measurement.estimatedBiomass,
              quantity: measurement.populationSize,
            },
            provenance,
          );
          await manager.save(Batch, lockedBatch);
        }
      }

      if (!lockedBatch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }

      measurement.isProcessed = true;
      await manager.save(GrowthMeasurement, measurement);

      if (unitId && locked) {
        await this.recalcService.recalcForUnit(manager, tenantId, unitId, {
          reason: 'growth_sample',
        });
      }

      return lockedBatch;
    });
  }
}
