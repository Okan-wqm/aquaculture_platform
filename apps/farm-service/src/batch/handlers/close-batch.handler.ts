/**
 * CloseBatchHandler
 *
 * CloseBatchCommand'ı işler ve batch'i kapatır.
 *
 * Enterprise fixes (HIGH-001):
 * - QueryRunner transaction prevents partial-commit on optimistic lock retry
 * - BatchClosed domain event published after commit via DomainEventPublisher
 * - Logger added for operational visibility
 *
 * @module Batch/Handlers
 */
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { CloseBatchCommand, BatchCloseReason } from '../commands/close-batch.command';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { DomainEventPublisher } from '../../common/services/domain-event-publisher.service';

@Injectable()
@CommandHandler(CloseBatchCommand)
export class CloseBatchHandler implements ICommandHandler<CloseBatchCommand, Batch> {
  private readonly logger = new Logger(CloseBatchHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    private readonly eventPublisher: DomainEventPublisher,
  ) {}

  async execute(command: CloseBatchCommand): Promise<Batch> {
    const { tenantId, batchId, reason, notes, closedBy } = command;

    // Batch bul
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
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

    // Batch'i kapat
    batch.status = BatchStatus.CLOSED;
    batch.isActive = false;
    batch.statusChangedAt = new Date();
    batch.statusReason = `${reason}: ${notes || ''}`.trim();
    batch.updatedBy = closedBy;

    // Growth metrics güncelle
    batch.growthMetrics.daysInProduction = finalMetrics.daysInProduction;

    // Hasat tarihi yoksa ve harvest completed ise şimdi ata
    if (reason === BatchCloseReason.HARVEST_COMPLETED && !batch.actualHarvestDate) {
      batch.actualHarvestDate = new Date();
    }

    // Transaction — prevents partial-commit on optimistic lock retry
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedBatch: Batch;
    try {
      savedBatch = await queryRunner.manager.save(Batch, batch);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.logger.log(`Batch ${batchId} closed — reason: ${reason}, tenant: ${tenantId}`);

    // Publish BatchClosed event AFTER transaction commit
    await this.eventPublisher.publish(
      {
        eventId: crypto.randomUUID(),
        eventType: 'BatchClosed',
        timestamp: new Date(),
        tenantId,
        batchId: savedBatch.id,
        closeReason: reason,
        closedBy,
        finalQuantity: finalMetrics.finalQuantity,
        finalBiomassKg: finalMetrics.finalBiomass,
        finalFCR: finalMetrics.fcr,
        mortalityRate: finalMetrics.mortalityRate,
        daysInProduction: finalMetrics.daysInProduction,
        version: 1,
      },
      { handler: CloseBatchHandler.name, tenantId, aggregateId: batchId },
    );

    return savedBatch;
  }
}
