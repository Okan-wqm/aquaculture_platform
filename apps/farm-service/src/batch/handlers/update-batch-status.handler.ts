/**
 * UpdateBatchStatusHandler
 *
 * UpdateBatchStatusCommand'ı işler ve batch durumunu değiştirir.
 * Status transition validasyonu yapar.
 *
 * Phase D refactor: DomainEventPublisher → OutboxPublisher (pre-commit,
 * transactional). BatchStatusChanged events now ship with at-least-once
 * delivery guarantee.
 *
 * @module Batch/Handlers
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent } from '@platform/event-contracts';
import type { BatchStatusChangedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { UpdateBatchStatusCommand } from '../commands/update-batch-status.command';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { BatchLifecyclePolicyService } from '../services/batch-lifecycle-policy.service';
import { BatchAggregateMutationPort } from '../batch-aggregate-mutation.port';

@Injectable()
@CommandHandler(UpdateBatchStatusCommand)
export class UpdateBatchStatusHandler implements ICommandHandler<UpdateBatchStatusCommand, Batch> {
  private readonly logger = new Logger(UpdateBatchStatusHandler.name);

  constructor(
    private readonly batchMutations: BatchAggregateMutationPort,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly lifecyclePolicy: BatchLifecyclePolicyService,
  ) {}

  async execute(command: UpdateBatchStatusCommand): Promise<Batch> {
    const { tenantId, batchId, newStatus, reason, updatedBy } = command;

    const savedBatch = await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        const batchRepo = tenantManagerRepo(queryRunner.manager, Batch, tenantId);
        // Pessimistic lock: prevents concurrent status transitions racing through
        // canTransitionTo() check before either commits (same pattern as CloseBatchHandler).
        const batch = await batchRepo.findOne({
          where: { id: batchId, tenantId, isActive: true },
          lock: { mode: 'pessimistic_write' },
        });

        if (!batch) {
          throw new NotFoundException(`Batch ${batchId} bulunamadı`);
        }

        this.lifecyclePolicy.assertCanTransitionStatus(batch, newStatus);

        const previousStatus = batch.status;
        const statusChangedAt = new Date();

        batch.status = newStatus;
        batch.statusChangedAt = statusChangedAt;
        batch.statusReason = reason;
        batch.updatedBy = updatedBy;

        switch (newStatus) {
          case BatchStatus.HARVESTED:
            if (!batch.actualHarvestDate) {
              batch.actualHarvestDate = statusChangedAt;
            }
            // FARM-CRITICAL-050 (defense-in-depth): a terminal status retires the
            // batch — converge the overloaded isActive soft-delete flag with the
            // operational reality so any read that still filters on isActive:true
            // stops surfacing a closed cycle. isOperational() remains the PRIMARY
            // mortality/cull gate; this is make-it-automatic belt-and-braces.
            batch.isActive = false;
            break;
          case BatchStatus.FAILED:
          case BatchStatus.CLOSED:
          case BatchStatus.TRANSFERRED:
            batch.isActive = false;
            break;
          case BatchStatus.ACTIVE:
            break;
        }

        const savedBatch = await this.batchMutations.commitBatchTransition(mutationSession, {
          intent: 'batch_status_change',
          aggregate: batch,
        });

        // Enqueue BatchStatusChangedEvent into the transactional outbox BEFORE commit.
        const statusEvent: BatchStatusChangedEvent = {
          ...createBaseEvent<BatchStatusChangedEvent>('BatchStatusChanged', tenantId, {
            aggregateId: savedBatch.id,
            aggregateType: 'Batch',
          }),
          timestamp: statusChangedAt.toISOString(),
          userId: updatedBy,
          batchId: savedBatch.id,
          previousStatus,
          newStatus,
          reason,
        };
        await this.outboxPublisher.enqueue(statusEvent, queryRunner.manager);

        this.logger.log(
          `Batch ${batchId} status: ${previousStatus} → ${newStatus}, tenant: ${tenantId}`,
        );
        return savedBatch;
      },
    );

    return savedBatch;
  }
}
