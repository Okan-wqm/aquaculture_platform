/**
 * UpdateBatchStatusHandler
 *
 * UpdateBatchStatusCommand'ı işler ve batch durumunu değiştirir.
 * Status transition validasyonu yapar.
 *
 * @module Batch/Handlers
 */
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateBatchStatusCommand } from '../commands/update-batch-status.command';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { DomainEventPublisher } from '../../common/services/domain-event-publisher.service';

@Injectable()
@CommandHandler(UpdateBatchStatusCommand)
export class UpdateBatchStatusHandler implements ICommandHandler<UpdateBatchStatusCommand, Batch> {
  private readonly logger = new Logger(UpdateBatchStatusHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    private readonly eventPublisher: DomainEventPublisher,
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

      batch.status = newStatus;
      batch.statusChangedAt = new Date();
      batch.statusReason = reason;
      batch.updatedBy = updatedBy;

      switch (newStatus) {
        case BatchStatus.HARVESTED:
          if (!batch.actualHarvestDate) {
            batch.actualHarvestDate = new Date();
          }
          break;
        case BatchStatus.FAILED:
        case BatchStatus.CLOSED:
          break;
        case BatchStatus.ACTIVE:
          break;
      }

      savedBatch = await queryRunner.manager.save(Batch, batch);
      await queryRunner.commitTransaction();

      this.logger.log(`Batch ${batchId} status: ${previousStatus} → ${newStatus}, tenant: ${tenantId}`);

      await this.eventPublisher.publish(
        {
          eventId: crypto.randomUUID(),
          eventType: 'BatchStatusChanged',
          timestamp: new Date(),
          tenantId,
          batchId: savedBatch.id,
          previousStatus,
          newStatus,
          reason,
          userId: updatedBy,
          version: 1,
        },
        { handler: UpdateBatchStatusHandler.name, tenantId, aggregateId: batchId },
      );

    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    return savedBatch;
  }
}
