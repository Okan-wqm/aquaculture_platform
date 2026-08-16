/**
 * UpdateFeedingRecordHandler
 *
 * UpdateFeedingRecordCommand'ı işler ve yemleme kaydını günceller.
 *
 * @module Feeding/Handlers
 */
import { createHash } from 'crypto';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import {
  toEventIso,
  createBaseEvent,
  type FeedingRecordUpdatedEvent,
} from '@platform/event-contracts';
import { UpdateFeedingRecordCommand } from '../commands/update-feeding-record.command';
import { FeedingRecord } from '../entities/feeding-record.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { FeedingDayPlan } from '../../feeding-protocol/entities/feeding-day-plan.entity';
import { resolveTankSiteId } from '../../batch/utils/tank-lookup.util';
import { StockMovementService } from '../../storage/services/stock-movement.service';

@Injectable()
@CommandHandler(UpdateFeedingRecordCommand)
export class UpdateFeedingRecordHandler
  implements ICommandHandler<UpdateFeedingRecordCommand, FeedingRecord>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly stockMovementService: StockMovementService,
  ) {}

  async execute(command: UpdateFeedingRecordCommand): Promise<FeedingRecord> {
    const { tenantId, feedingRecordId, payload, userId } = command;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const preview = await manager.findOne(FeedingRecord, {
        where: { id: feedingRecordId, tenantId },
      });
      if (!preview) {
        throw new NotFoundException(`Feeding record ${feedingRecordId} bulunamadı`);
      }

      // Canonical lock order: Batch -> FeedingRecord -> stock authority.
      const batch = await manager.findOne(Batch, {
        where: { id: preview.batchId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!batch) {
        throw new NotFoundException(`Batch ${preview.batchId} bulunamadı`);
      }
      const feedingRecord = await manager.findOne(FeedingRecord, {
        where: { id: feedingRecordId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!feedingRecord) {
        throw new NotFoundException(`Feeding record ${feedingRecordId} bulunamadı`);
      }
      if (feedingRecord.mealId != null) {
        throw new BadRequestException(
          `Feeding record ${feedingRecordId} bir öğün dökümüne bağlı (meal ${feedingRecord.mealId}) — ` +
            `updateFeedingRecord ile düzeltilemez; correctMealPour kullanın`,
        );
      }

      const oldActualAmount = Number(feedingRecord.actualAmount);
      const oldFeedCost = Number(feedingRecord.feedCost || 0);
      const previousRevision = feedingRecord.updatedAt.toISOString();

      if (payload.actualAmount !== undefined) feedingRecord.actualAmount = payload.actualAmount;
      if (payload.wasteAmount !== undefined) feedingRecord.wasteAmount = payload.wasteAmount;
      if (payload.environment !== undefined) feedingRecord.environment = payload.environment;
      if (payload.fishBehavior !== undefined) feedingRecord.fishBehavior = payload.fishBehavior;
      if (payload.feedingMethod !== undefined) feedingRecord.feedingMethod = payload.feedingMethod;
      if (payload.feedingDurationMinutes !== undefined) {
        feedingRecord.feedingDurationMinutes = payload.feedingDurationMinutes;
      }
      if (payload.feedCost !== undefined) feedingRecord.feedCost = payload.feedCost;
      if (payload.notes !== undefined) feedingRecord.notes = payload.notes;
      if (payload.skipReason !== undefined) feedingRecord.skipReason = payload.skipReason;
      feedingRecord.calculateVariance();

      const saved = await manager.save(feedingRecord);

      const newActualAmount = Number(saved.actualAmount);
      const newFeedCost = Number(saved.feedCost || 0);
      const amountDiff = newActualAmount - oldActualAmount;
      const costDiff = newFeedCost - oldFeedCost;

      // Batch'in yem tüketimini güncelle (eğer miktar değiştiyse)
      if (
        (payload.actualAmount !== undefined || payload.feedCost !== undefined) &&
        (amountDiff !== 0 || costDiff !== 0)
      ) {
        batch.totalFeedConsumed = Number(batch.totalFeedConsumed || 0) + amountDiff;
        batch.totalFeedCost = Number(batch.totalFeedCost || 0) + costDiff;
        await manager.save(batch);
      }

      if (amountDiff !== 0) {
        let siteId: string | null = null;
        if (saved.dayPlanId) {
          const dayPlan = await manager.findOne(FeedingDayPlan, {
            where: { id: saved.dayPlanId, tenantId },
          });
          siteId = dayPlan?.siteId ?? null;
        }
        if (!siteId && saved.tankId) {
          siteId = await resolveTankSiteId(manager, saved.tankId, tenantId);
        }
        const correctionKey = createHash('sha256')
          .update(
            [
              'feeding-correction-v1',
              saved.id,
              previousRevision,
              oldActualAmount.toString(),
              newActualAmount.toString(),
            ].join('\u0000'),
          )
          .digest('hex');
        await this.stockMovementService.correctFeedDeduction(
          manager,
          {
            feedId: saved.feedId,
            deltaKg: amountDiff,
            sourceDeductionKey: `feeding-deduct-${saved.id}`,
            idempotencyKey: correctionKey,
            preferredSiteId: siteId ?? undefined,
            reference: `FEEDING-CORRECTION: ${saved.id}`,
          },
          { tenantId, userId, userName: 'Feeding' },
        );
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
      await this.outboxPublisher.enqueue(event, manager, {
        aggregateId: saved.id,
        idempotencyKey: `feeding-record-updated:${saved.id}:${saved.updatedAt.getTime()}`,
      });

      return saved;
    });
  }
}
