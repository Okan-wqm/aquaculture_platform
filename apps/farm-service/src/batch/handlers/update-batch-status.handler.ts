/**
 * UpdateBatchStatusHandler
 *
 * UpdateBatchStatusCommand'ı işler ve batch durumunu değiştirir.
 * Status transition validasyonu yapar.
 *
 * @module Batch/Handlers
 */
import { Injectable, NotFoundException, BadRequestException, Optional, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { UpdateBatchStatusCommand } from '../commands/update-batch-status.command';
import { Batch, BatchStatus } from '../entities/batch.entity';

@Injectable()
@CommandHandler(UpdateBatchStatusCommand)
export class UpdateBatchStatusHandler implements ICommandHandler<UpdateBatchStatusCommand, Batch> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
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

    // Domain event yayınla
    // await this.eventBus.publish(new BatchStatusChangedEvent({
    //   tenantId,
    //   batchId: savedBatch.id,
    //   batchNumber: savedBatch.batchNumber,
    //   previousStatus,
    //   newStatus,
    //   reason,
    //   changedBy: updatedBy,
    // }));

    return savedBatch;
  }
}
