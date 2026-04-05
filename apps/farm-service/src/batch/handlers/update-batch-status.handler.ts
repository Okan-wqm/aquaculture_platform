/**
 * UpdateBatchStatusHandler
 *
 * UpdateBatchStatusCommand'ı işler ve batch durumunu değiştirir.
 * Status transition validasyonu yapar.
 *
 * @module Batch/Handlers
 */
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateBatchStatusCommand } from '../commands/update-batch-status.command';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { DomainEventPublisher } from '../../common/services/domain-event-publisher.service';

@Injectable()
@CommandHandler(UpdateBatchStatusCommand)
export class UpdateBatchStatusHandler implements ICommandHandler<UpdateBatchStatusCommand, Batch> {
  private readonly logger = new Logger(UpdateBatchStatusHandler.name);

  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    private readonly eventPublisher: DomainEventPublisher,
  ) {}

  async execute(command: UpdateBatchStatusCommand): Promise<Batch> {
    const { tenantId, batchId, newStatus, reason, updatedBy } = command;

    // Batch bul
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId, isActive: true },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    // Status transition validasyonu
    if (!batch.canTransitionTo(newStatus)) {
      throw new BadRequestException(
        `Geçersiz status geçişi: ${batch.status} -> ${newStatus}. ` +
        `Bu batch ${batch.status} durumundan ${newStatus} durumuna geçemez.`
      );
    }

    const previousStatus = batch.status;

    // Status güncelle
    batch.status = newStatus;
    batch.statusChangedAt = new Date();
    batch.statusReason = reason;
    batch.updatedBy = updatedBy;

    // Status'a göre ek işlemler
    switch (newStatus) {
      case BatchStatus.HARVESTED:
        if (!batch.actualHarvestDate) {
          batch.actualHarvestDate = new Date();
        }
        break;

      case BatchStatus.FAILED:
      case BatchStatus.CLOSED:
        // Batch kapatıldı, isActive false yapılabilir
        // batch.isActive = false; // İsteğe bağlı
        break;

      case BatchStatus.ACTIVE:
        // Karantina'dan çıkış
        if (previousStatus === BatchStatus.QUARANTINE) {
          // İlk operasyonel gün başlangıcı
        }
        break;
    }

    const savedBatch = await this.batchRepository.save(batch);

    this.logger.log(`Batch ${batchId} status: ${previousStatus} → ${newStatus}, tenant: ${tenantId}`);

    // Publish domain event via DomainEventPublisher (handles errors with structured logging)
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

    return savedBatch;
  }
}
