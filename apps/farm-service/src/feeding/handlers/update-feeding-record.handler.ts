/**
 * UpdateFeedingRecordHandler
 *
 * UpdateFeedingRecordCommand'ı işler ve yemleme kaydını günceller.
 *
 * @module Feeding/Handlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
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
    private readonly dataSource: DataSource,
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

    // Transaction ile hem feeding record hem batch güncellemesi yap
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Kaydet (transaction içinde)
      const saved = await queryRunner.manager.save(feedingRecord);

      // Batch'in yem tüketimini güncelle (eğer miktar değiştiyse)
      if (payload.actualAmount !== undefined || payload.feedCost !== undefined) {
        const newActualAmount = Number(saved.actualAmount);
        const newFeedCost = Number(saved.feedCost || 0);

        const amountDiff = newActualAmount - oldActualAmount;
        const costDiff = newFeedCost - oldFeedCost;

        if (amountDiff !== 0 || costDiff !== 0) {
          await this.updateBatchFeedConsumption(queryRunner.manager, saved.batchId, tenantId, amountDiff, costDiff);
        }
      }

      await queryRunner.commitTransaction();

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async updateBatchFeedConsumption(
    manager: EntityManager,
    batchId: string,
    tenantId: string,
    amountDiff: number,
    costDiff: number,
  ): Promise<void> {
    const batch = await manager.findOne(Batch, {
      where: { id: batchId, tenantId },
    });

    if (batch) {
      batch.totalFeedConsumed = Number(batch.totalFeedConsumed || 0) + amountDiff;
      batch.totalFeedCost = Number(batch.totalFeedCost || 0) + costDiff;

      await manager.save(batch);
    }
  }
}
