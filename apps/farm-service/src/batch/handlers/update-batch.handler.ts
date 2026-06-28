/**
 * UpdateBatchHandler
 *
 * Updates batch descriptive / target fields (name, description,
 * strain, targetFCR, expectedHarvestDate, notes). Status transitions
 * go through `UpdateBatchStatusHandler` — separate handler, separate
 * event.
 *
 * Atomic boundary:
 *   - batch row save
 *   - `BatchMetadataUpdated` outbox enqueue
 * commit together. Without atomicity, a target-FCR edit could land
 * on the DB while the FCR-drift projection on the consumer side
 * never updates — producing a false-alarm trend on dashboards.
 *
 * @module Batch/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso,
  createBaseEvent,
  type BatchMetadataUpdatedEvent,
} from '@platform/event-contracts';
import { UpdateBatchCommand } from '../commands/update-batch.command';
import { Batch } from '../entities/batch.entity';

@Injectable()
@CommandHandler(UpdateBatchCommand)
export class UpdateBatchHandler implements ICommandHandler<UpdateBatchCommand, Batch> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateBatchCommand): Promise<Batch> {
    const { tenantId, batchId, payload, updatedBy } = command;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId, isActive: true },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }

      const changedFields: string[] = [];

      if (payload.name !== undefined) {
        batch.name = payload.name;
        changedFields.push('name');
      }

      if (payload.description !== undefined) {
        batch.description = payload.description;
        changedFields.push('description');
      }

      if (payload.strain !== undefined) {
        batch.strain = payload.strain;
        changedFields.push('strain');
      }

      if (payload.targetFCR !== undefined) {
        batch.fcr.target = payload.targetFCR;
        batch.fcr.isUserOverride = true;
        batch.fcr.lastUpdatedAt = new Date();
        changedFields.push('targetFCR');
      }

      if (payload.expectedHarvestDate !== undefined) {
        batch.expectedHarvestDate = payload.expectedHarvestDate;
        batch.growthMetrics.projections.harvestDate = payload.expectedHarvestDate;
        changedFields.push('expectedHarvestDate');
      }

      if (payload.notes !== undefined) {
        batch.notes = payload.notes;
        changedFields.push('notes');
      }

      batch.updatedBy = updatedBy;

      const saved = await queryRunner.manager.save(Batch, batch);

      const event: BatchMetadataUpdatedEvent = {
        ...createBaseEvent<BatchMetadataUpdatedEvent>('BatchMetadataUpdated', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'Batch',
        }),
        batchId: saved.id,
        changedFields,
        newTargetFCR: saved.fcr?.target,
        newExpectedHarvestDate: toEventIso(saved.expectedHarvestDate),
        updatedAt: toEventIso(new Date()),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);

      return saved;
    });
  }
}
