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
import { randomUUID } from 'crypto';
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import type { BatchStatusChangedEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { UpdateBatchStatusCommand } from '../commands/update-batch-status.command';
import { Batch, BatchStatus } from '../entities/batch.entity';

@Injectable()
@CommandHandler(UpdateBatchStatusCommand)
export class UpdateBatchStatusHandler implements ICommandHandler<UpdateBatchStatusCommand, Batch> {
  private readonly logger = new Logger(UpdateBatchStatusHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateBatchStatusCommand): Promise<Batch> {
    const { tenantId, batchId, newStatus, reason, updatedBy } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedBatch: Batch;
    try {
      // Pessimistic lock: prevents concurrent status transitions racing through
      // canTransitionTo() check before either commits (same pattern as CloseBatchHandler).
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }

      if (!batch.canTransitionTo(newStatus)) {
        throw new BadRequestException(
          `Geçersiz status geçişi: ${batch.status} -> ${newStatus}. ` +
          `Bu batch ${batch.status} durumundan ${newStatus} durumuna geçemez.`
        );
      }

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
          break;
        case BatchStatus.FAILED:
        case BatchStatus.CLOSED:
          break;
        case BatchStatus.ACTIVE:
          break;
      }

      savedBatch = await queryRunner.manager.save(Batch, batch);

      // Enqueue BatchStatusChangedEvent into the transactional outbox BEFORE commit.
      const statusEvent: BatchStatusChangedEvent = {
        ...createBaseEvent<BatchStatusChangedEvent>('BatchStatusChanged', tenantId, { aggregateId: savedBatch.id, aggregateType: 'Batch' }),
        timestamp: statusChangedAt.toISOString(),
        userId: updatedBy,
        batchId: savedBatch.id,
        previousStatus,
        newStatus,
        reason,
      };
      await this.outboxPublisher.enqueue(statusEvent, queryRunner.manager);

      await queryRunner.commitTransaction();

      this.logger.log(`Batch ${batchId} status: ${previousStatus} → ${newStatus}, tenant: ${tenantId}`);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    return savedBatch;
  }
}
