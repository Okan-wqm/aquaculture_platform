/**
 * UpdateBatchWeightFromSampleHandler
 *
 * UpdateBatchWeightFromSampleCommand'ı işler: a stored sample recorded with
 * `updateBatchWeight = false` is applied as current weight later.
 *
 * The sample is applied through GrowthSampleApplierService, the same path
 * RecordGrowthSampleHandler uses, so a sample applied later reaches the tank
 * and its live day plan exactly like one applied at recording
 * (FARM-CRITICAL-454), and a sample older than the batch's last weighing does
 * not move it back (FARM-MEDIUM-453). The unit is locked first in the
 * canonical order (`lockUnitForGrowth`), and a membership change between the
 * lock's preview and its locked read is retried by `withUnitLockRetry` around
 * the whole command.
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
import { GrowthSampleApplierService } from '../services/growth-sample-applier.service';
import { BiomassGrowthApplierService } from '../../feeding-protocol/services/biomass-growth-applier.service';
import { withUnitLockRetry } from '../../feeding-protocol/services/unit-lock-retry.util';

@Injectable()
@CommandHandler(UpdateBatchWeightFromSampleCommand)
export class UpdateBatchWeightFromSampleHandler
  implements ICommandHandler<UpdateBatchWeightFromSampleCommand, Batch>
{
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly sampleApplier: GrowthSampleApplierService,
  ) {}

  async execute(command: UpdateBatchWeightFromSampleCommand): Promise<Batch> {
    return withUnitLockRetry(() => this.executeOnce(command));
  }

  private async executeOnce(command: UpdateBatchWeightFromSampleCommand): Promise<Batch> {
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

    // Atomic + locked: the sample is applied onto freshly locked rows (never a
    // full externally loaded snapshot, which could revert a concurrent
    // mortality/cull/harvest), and the isProcessed flip commits with it.
    // runInTenantTransaction pins search_path to tenant_<uuid> for the whole tx
    // (pool-checkout routing alone is not sufficient for transactional writes).
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const unitId = await this.sampleApplier.unitOf(manager, tenantId, measurement);
      const locked =
        unitId === null
          ? null
          : await this.growthApplier.lockUnitForGrowth(manager, tenantId, unitId);
      const lockedBatch = await this.sampleApplier.apply(
        manager,
        tenantId,
        measurement,
        unitId,
        locked,
      );

      measurement.isProcessed = true;
      await manager.save(GrowthMeasurement, measurement);

      return lockedBatch;
    });
  }
}
