/**
 * UpdateFeedingRecordHandler
 *
 * UpdateFeedingRecordCommand'ı işler ve yemleme kaydını günceller.
 *
 * @module Feeding/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso,
  createBaseEvent,
  type FeedingRecordUpdatedEvent,
} from '@platform/event-contracts';
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
    private readonly outboxPublisher: OutboxPublisher,
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
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const saved = await queryRunner.manager.save(feedingRecord);

      const newActualAmount = Number(saved.actualAmount);
      const newFeedCost = Number(saved.feedCost || 0);
      const amountDiff = newActualAmount - oldActualAmount;
      const costDiff = newFeedCost - oldFeedCost;

      // Batch'in yem tüketimini güncelle (eğer miktar değiştiyse)
      if (
        (payload.actualAmount !== undefined || payload.feedCost !== undefined) &&
        (amountDiff !== 0 || costDiff !== 0)
      ) {
        await this.updateBatchFeedConsumption(queryRunner.manager, saved.batchId, tenantId, amountDiff, costDiff);
      }

      // Always-fire event: downstream FCR / feed-cost projections
      // need to know EVERY correction to stay in sync. We emit even
      // when amountDiff/costDiff are zero because behaviour /
      // environment / notes corrections still matter to AI insights.
      const event: FeedingRecordUpdatedEvent = {
        ...createBaseEvent<FeedingRecordUpdatedEvent>('FeedingRecordUpdated', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'FeedingRecord',
        }),
        feedingRecordId: saved.id,
        batchId: saved.batchId,
        previousActualAmountKg: oldActualAmount,
        newActualAmountKg: newActualAmount,
        amountDiffKg: amountDiff,
        previousFeedCost: oldFeedCost,
        newFeedCost: newFeedCost,
        costDiff,
        updatedAt: toEventIso(new Date()),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);

      return saved;
    });
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
