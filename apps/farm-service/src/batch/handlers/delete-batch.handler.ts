import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent } from '@platform/event-contracts';
import type { BatchStatusChangedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { DeleteBatchCommand } from '../commands/delete-batch.command';
import { Batch, BatchStatus } from '../entities/batch.entity';

@Injectable()
@CommandHandler(DeleteBatchCommand)
export class DeleteBatchHandler implements ICommandHandler<DeleteBatchCommand, void> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: DeleteBatchCommand): Promise<void> {
    const { tenantId, batchId, actorUserId, reason } = command;

    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const batchRepo = tenantManagerRepo(queryRunner.manager, Batch, tenantId);
      const batch = await batchRepo.findOne({
        where: { id: batchId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadi`);
      }

      const previousStatus = batch.status;
      const statusChangedAt = new Date();

      batch.isActive = false;
      batch.status = BatchStatus.CLOSED;
      batch.statusChangedAt = statusChangedAt;
      batch.statusReason = reason ?? 'deleted';
      batch.updatedBy = actorUserId;
      await batchRepo.save(batch);

      const statusEvent: BatchStatusChangedEvent = {
        ...createBaseEvent<BatchStatusChangedEvent>('BatchStatusChanged', tenantId, {
          aggregateId: batch.id,
          aggregateType: 'Batch',
        }),
        timestamp: statusChangedAt.toISOString(),
        userId: actorUserId,
        batchId: batch.id,
        previousStatus,
        newStatus: BatchStatus.CLOSED,
        reason: batch.statusReason,
      };
      await this.outboxPublisher.enqueue(statusEvent, queryRunner.manager);
    });
  }
}
