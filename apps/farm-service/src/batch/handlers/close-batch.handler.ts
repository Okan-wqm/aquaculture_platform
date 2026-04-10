/**
 * CloseBatchHandler
 *
 * CloseBatchCommand'ı işler ve batch'i kapatır.
 *
 * Phase A refactor:
 * - Replaced DomainEventPublisher (post-commit fire-and-forget) with
 *   OutboxPublisher (pre-commit transactional). BatchClosed events are
 *   now delivered with at-least-once guarantee even when NATS is down.
 * - All reads moved inside the transaction with pessimistic_write lock to
 *   eliminate the TOCTOU race where the batch could mutate between the
 *   pre-read and the actual close.
 * - Event payload now includes ALL contract-required fields:
 *   `closedAt`, `totalMortality`, `mortalityRate`, `daysInProduction`,
 *   `finalFCR`, `finalQuantity`, `finalBiomassKg`. Previous implementation
 *   silently dropped `closedAt` and `totalMortality` due to the loose
 *   `IEvent & Record<string, unknown>` type that bypassed contract checks.
 *
 * @module Batch/Handlers
 */
import { randomUUID } from 'crypto';
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import type { BatchClosedEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { CloseBatchCommand, BatchCloseReason } from '../commands/close-batch.command';
import { Batch, BatchStatus } from '../entities/batch.entity';

@Injectable()
@CommandHandler(CloseBatchCommand)
export class CloseBatchHandler implements ICommandHandler<CloseBatchCommand, Batch> {
  private readonly logger = new Logger(CloseBatchHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: CloseBatchCommand): Promise<Batch> {
    const { tenantId, batchId, reason, notes, closedBy } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedBatch: Batch;
    try {
      // Batch bul (inside TX with pessimistic lock — eliminates TOCTOU race
      // where the batch could be mutated between pre-read and the close write).
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }

      // Zaten kapalı mı kontrol et
      if (batch.status === BatchStatus.CLOSED) {
        throw new BadRequestException(`Batch ${batchId} zaten kapatılmış`);
      }

      // Close reason'a göre önceki status kontrolü
      const allowedPreviousStatuses: Record<BatchCloseReason, BatchStatus[]> = {
        [BatchCloseReason.HARVEST_COMPLETED]: [BatchStatus.HARVESTED, BatchStatus.HARVESTING],
        [BatchCloseReason.TRANSFERRED]: [BatchStatus.TRANSFERRED],
        [BatchCloseReason.FAILED]: [BatchStatus.FAILED, BatchStatus.QUARANTINE, BatchStatus.ACTIVE, BatchStatus.GROWING],
        [BatchCloseReason.CANCELLED]: [BatchStatus.QUARANTINE, BatchStatus.ACTIVE],
        [BatchCloseReason.OTHER]: Object.values(BatchStatus).filter(s => s !== BatchStatus.CLOSED),
      };

      if (!allowedPreviousStatuses[reason].includes(batch.status)) {
        throw new BadRequestException(
          `Batch ${reason} nedeniyle kapatılamaz. Mevcut durum: ${batch.status}`
        );
      }

      // Final metrikleri hesapla (before mutation)
      const finalMetrics = {
        finalQuantity: batch.currentQuantity,
        finalBiomass: batch.getCurrentBiomass(),
        finalAvgWeight: batch.getCurrentAvgWeight(),
        totalMortality: batch.totalMortality,
        mortalityRate: batch.getMortalityRate(),
        survivalRate: batch.getSurvivalRate(),
        retentionRate: batch.getRetentionRate(),
        totalFeedConsumed: batch.totalFeedConsumed,
        fcr: batch.fcr.actual,
        sgr: batch.sgr,
        daysInProduction: batch.getDaysInProduction(),
        costPerKg: batch.costPerKg,
      };

      const closedAt = new Date();

      // Batch'i kapat
      batch.status = BatchStatus.CLOSED;
      batch.isActive = false;
      batch.statusChangedAt = closedAt;
      batch.statusReason = `${reason}: ${notes || ''}`.trim();
      batch.updatedBy = closedBy;

      // Growth metrics güncelle
      batch.growthMetrics.daysInProduction = finalMetrics.daysInProduction;

      // Hasat tarihi yoksa ve harvest completed ise şimdi ata
      if (reason === BatchCloseReason.HARVEST_COMPLETED && !batch.actualHarvestDate) {
        batch.actualHarvestDate = closedAt;
      }

      savedBatch = await queryRunner.manager.save(Batch, batch);

      // Enqueue BatchClosedEvent into the transactional outbox BEFORE commit.
      // All required contract fields are populated — `closedAt` and `totalMortality`
      // were silently dropped by the previous implementation due to type-loose
      // publish API. With OutboxPublisher.enqueue<BaseEvent>, the cast to the
      // typed contract is enforced.
      const closedEvent: BatchClosedEvent = {
        ...createBaseEvent<BatchClosedEvent>('BatchClosed', tenantId, { aggregateId: savedBatch.id, aggregateType: 'Batch' }),
        timestamp: closedAt.toISOString(),
        userId: closedBy,
        batchId: savedBatch.id,
        closeReason: reason,
        finalQuantity: finalMetrics.finalQuantity,
        finalBiomassKg: finalMetrics.finalBiomass,
        finalFCR: finalMetrics.fcr,
        totalMortality: finalMetrics.totalMortality,
        mortalityRate: finalMetrics.mortalityRate,
        daysInProduction: finalMetrics.daysInProduction,
        closedAt,
      };
      await this.outboxPublisher.enqueue(closedEvent, queryRunner.manager);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.logger.log(`Batch ${batchId} closed — reason: ${reason}, tenant: ${tenantId}`);

    return savedBatch;
  }
}
