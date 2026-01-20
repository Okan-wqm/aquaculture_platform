/**
 * UpdateFeedingRecordHandler
 *
 * UpdateFeedingRecordCommand'ı işler ve yemleme kaydını günceller.
 *
 * @module Feeding/Handlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateFeedingRecordCommand } from '../commands/update-feeding-record.command';
import { FeedingRecord } from '../entities/feeding-record.entity';
import { Batch } from '../../batch/entities/batch.entity';

@Injectable()
@CommandHandler(UpdateFeedingRecordCommand)
export class UpdateFeedingRecordHandler implements ICommandHandler<UpdateFeedingRecordCommand, FeedingRecord> {
  constructor(
    @InjectRepository(FeedingRecord)
    private readonly feedingRecordRepository: Repository<FeedingRecord>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
  ) {}

  async execute(command: UpdateFeedingRecordCommand): Promise<FeedingRecord> {
    const { tenantId, feedingRecordId, payload, userId } = command;

    // Mevcut kaydı bul
    const feedingRecord = await this.feedingRecordRepository.findOne({
      where: { id: feedingRecordId, tenantId },
    });

    if (!feedingRecord) {
      throw new NotFoundException(`Feeding record ${feedingRecordId} bulunamadı`);
    }

    const oldActualAmount = Number(feedingRecord.actualAmount);
    const oldFeedCost = Number(feedingRecord.feedCost || 0);

    // Güncelle
    if (payload.actualAmount !== undefined) {
      feedingRecord.actualAmount = payload.actualAmount;
    }
    if (payload.wasteAmount !== undefined) {
      feedingRecord.wasteAmount = payload.wasteAmount;
    }
    if (payload.environment !== undefined) {
      feedingRecord.environment = payload.environment;
    }
    if (payload.fishBehavior !== undefined) {
      feedingRecord.fishBehavior = payload.fishBehavior;
    }
    if (payload.feedingMethod !== undefined) {
      feedingRecord.feedingMethod = payload.feedingMethod;
    }
    if (payload.feedingDurationMinutes !== undefined) {
      feedingRecord.feedingDurationMinutes = payload.feedingDurationMinutes;
    }
    if (payload.feedCost !== undefined) {
      feedingRecord.feedCost = payload.feedCost;
    }
    if (payload.notes !== undefined) {
      feedingRecord.notes = payload.notes;
    }
    if (payload.skipReason !== undefined) {
      feedingRecord.skipReason = payload.skipReason;
    }

    // Varyans yeniden hesapla
    feedingRecord.calculateVariance();

    // Kaydet
    const saved = await this.feedingRecordRepository.save(feedingRecord);

    // Batch'in yem tüketimini güncelle (eğer miktar değiştiyse)
    if (payload.actualAmount !== undefined || payload.feedCost !== undefined) {
      const newActualAmount = Number(saved.actualAmount);
      const newFeedCost = Number(saved.feedCost || 0);

      const amountDiff = newActualAmount - oldActualAmount;
      const costDiff = newFeedCost - oldFeedCost;

      if (amountDiff !== 0 || costDiff !== 0) {
        await this.updateBatchFeedConsumption(saved.batchId, tenantId, amountDiff, costDiff);
      }
    }

    return saved;
  }

  private async updateBatchFeedConsumption(
    batchId: string,
    tenantId: string,
    amountDiff: number,
    costDiff: number,
  ): Promise<void> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    if (batch) {
      batch.totalFeedConsumed = Number(batch.totalFeedConsumed || 0) + amountDiff;
      batch.totalFeedCost = Number(batch.totalFeedCost || 0) + costDiff;

      await this.batchRepository.save(batch);
    }
  }
}
