/**
 * CloseBatchHandler
 *
 * CloseBatchCommand'ı işler ve batch'i kapatır.
 *
 * @module Batch/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { CloseBatchCommand, BatchCloseReason } from '../commands/close-batch.command';
import { Batch, BatchStatus } from '../entities/batch.entity';

@Injectable()
@CommandHandler(CloseBatchCommand)
export class CloseBatchHandler implements ICommandHandler<CloseBatchCommand, Batch> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
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

    // Final metrikleri hesapla
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
    batch.statusChangedAt = new Date();
    batch.statusReason = `${reason}: ${notes || ''}`.trim();
    batch.updatedBy = closedBy;

    // Growth metrics güncelle
    batch.growthMetrics.daysInProduction = finalMetrics.daysInProduction;

    // Hasat tarihi yoksa ve harvest completed ise şimdi ata
    if (reason === BatchCloseReason.HARVEST_COMPLETED && !batch.actualHarvestDate) {
      batch.actualHarvestDate = new Date();
    }

    return this.batchRepository.save(batch);
  }
}
