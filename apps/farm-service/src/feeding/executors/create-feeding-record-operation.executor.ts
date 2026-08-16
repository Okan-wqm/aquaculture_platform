/**
 * CreateFeedingRecordOperationExecutor
 *
 * CreateFeedingRecordCommand'ı işler ve yeni yemleme kaydı oluşturur.
 * Faz 5 (P-05): kayıt + batch aggregate + storage düşümü + outbox event'i
 * TEK yem yazma yolu olan `FeedingLedgerService.recordFeed`'e delege edilir —
 * v2 öğün motoru ve (drain penceresinde) legacy execution kaydı AYNI yoldan
 * geçer; bu handler yalnız doğrulama (backdate, kilitli batch feedable, feed
 * varlığı) + transaction sınırını sahiplenir.
 *
 * Phase A refactor:
 *  - Replaced fire-and-forget eventBus.publish() (post-commit, @Optional
 *    injection that silently dropped events) with OutboxPublisher.enqueue()
 *    inside the same transaction as the domain write.
 *  - Moved Batch + Feed validation reads INSIDE the transaction with
 *    pessimistic_write lock on Batch to eliminate the TOCTOU race where the
 *    batch could be deactivated between the pre-check and the feeding write.
 *
 * Feed stock authority:
 *  - Asserts the locked batch is feedable (BatchDomainService.assertFeedable)
 *    INSIDE the tx — feeding an empty / non-feedable batch is rejected before
 *    any stock is touched.
 *  - Delegates tracked classification, complete-pool FEFO allocation and
 *    immutable movement writes to StockMovementService.recordFeedDeduction on
 *    the SAME queryRunner.manager. Immutable movement history keeps a depleted
 *    feed classified as tracked; insufficient stock therefore fails closed and
 *    rolls back the entire feeding operation.
 *  - Only feeds with neither immutable movement history nor a legacy bootstrap
 *    projection are treated as untracked. That compatibility boundary is
 *    observable and cannot reappear merely because stock reached zero.
 *
 * @module Feeding/Handlers
 */
import { feedingClockSnapshot } from '@aquaculture/feeding-contracts';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FeedingMethod, FishAppetite, type FishBehavior } from '../entities/feeding-record.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { BatchDomainService } from '../../batch/services/batch-domain.service';
import { BackdatePolicyService } from '../../common/services/backdate-policy.service';
import { FeedingLedgerService } from '../services/feeding-ledger.service';
import { BiomassGrowthApplierService } from '../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import {
  FeedingDayPlan,
  FeedingDayPlanStatus,
} from '../../feeding-protocol/entities/feeding-day-plan.entity';
import type {
  FeedingRecordOperationResult,
  ManualFeedingRecordOperationCommand,
} from '../../feeding-protocol/feeding-operation-command';
import type { FeedingRecordCreateOperationHandler } from '../../feeding-protocol/feeding-operation-handler';
import type { FeedingOperationSession } from '../../feeding-protocol/feeding-operation-session';
import {
  feedingOperationObservedAt,
  readFeedingOperationSession,
} from '../../feeding-protocol/feeding-operation-session';
import { projectFeedingRecordOperationResult } from './feeding-record-operation-result';
import { FeedingAggregateMutationPort } from '../../feeding-protocol/feeding-aggregate-mutation.writer';

type WireFeedingMethod = NonNullable<
  ManualFeedingRecordOperationCommand['payload']['feedingMethod']
>;
type WireFishBehavior = NonNullable<ManualFeedingRecordOperationCommand['payload']['fishBehavior']>;

const FEEDING_METHOD_BY_WIRE = Object.freeze({
  manual: FeedingMethod.MANUAL,
  automatic: FeedingMethod.AUTOMATIC,
  demand: FeedingMethod.DEMAND,
  broadcast: FeedingMethod.BROADCAST,
  spot: FeedingMethod.SPOT,
} satisfies Readonly<Record<WireFeedingMethod, FeedingMethod>>);

const FISH_APPETITE_BY_WIRE = Object.freeze({
  excellent: FishAppetite.EXCELLENT,
  good: FishAppetite.GOOD,
  moderate: FishAppetite.MODERATE,
  poor: FishAppetite.POOR,
  none: FishAppetite.NONE,
} satisfies Readonly<Record<WireFishBehavior['appetite'], FishAppetite>>);

function projectFishBehavior(value: WireFishBehavior | undefined): FishBehavior | undefined {
  return value
    ? {
        ...value,
        appetite: FISH_APPETITE_BY_WIRE[value.appetite],
      }
    : undefined;
}

@Injectable()
export class CreateFeedingRecordOperationExecutor implements FeedingRecordCreateOperationHandler {
  constructor(
    private readonly feedingMutations: FeedingAggregateMutationPort,
    private readonly backdatePolicy: BackdatePolicyService,
    private readonly batchDomainService: BatchDomainService,
    private readonly feedingLedger: FeedingLedgerService,
    // D-7: plan-dışı yem, aktif gün planına bağlanır — growth + recalc aynı tx.
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly recalcService: DayPlanRecalcService,
  ) {}

  async executeFeedingRecordOperation(
    session: FeedingOperationSession,
    command: ManualFeedingRecordOperationCommand,
  ): Promise<FeedingRecordOperationResult> {
    const context = readFeedingOperationSession(session);
    const manager = context.manager;
    const observedAt = feedingOperationObservedAt(context);
    const { tenantId, payload, actorId: userId } = command;
    const proposedDate =
      payload.feedingDate instanceof Date ? payload.feedingDate : new Date(payload.feedingDate);
    this.backdatePolicy.validate({
      context: 'feeding',
      proposedDate,
      subjectLabel: `batch ${payload.batchId}`,
    });

    // D-7: ünitesi bilinen kayıtlar için kanonik kilit sırası — ünitenin TÜM
    // batch'leri (batchId asc) + TankBatch (lockUnitForGrowth) → DayPlan.
    // Önce yalnız payload batch'ini kilitlemek, aynı ünitede eşzamanlı iki
    // kayıtta AB-BA sırası doğururdu.
    const unitId = context.unitId;
    const siteId = context.siteId;
    if (!unitId || !siteId) {
      throw new BadRequestException(
        'Feeding operation claim has no governed physical unit and Site coordinates',
      );
    }
    const localPlanDate = feedingClockSnapshot(proposedDate, context.timezone).localDate;
    const execution = await this.growthApplier.withUnitGrowthMutation(
      manager,
      context.mutationSession,
      tenantId,
      unitId,
      context.mutationInstant,
      async (locked) => {
        // The locked unit projection is the membership authority. Acquiring a
        // payload-only Batch lock after TankBatch would violate the global order.
        const batch = locked.batches.get(payload.batchId);
        if (!batch) {
          throw new BadRequestException(
            `Batch ${payload.batchId} is outside feeding unit ${unitId}'s locked stock projection`,
          );
        }

        if (!batch.isActive) {
          throw new BadRequestException('Aktif olmayan batch için yemleme kaydı oluşturulamaz');
        }

        // Reject feeding an empty (currentQuantity ≤ 0) or non-feedable
        // (HARVESTED / CLOSED / FAILED / …) batch. Recording feed against such
        // a batch inflates totalFeedConsumed with no biomass and corrupts FCR.
        // Runs on the pessimistically-locked batch so the decision cannot race
        // a concurrent CloseBatch / final harvest. Throws BadRequestException.
        this.batchDomainService.assertFeedable(batch);

        // D-7 plan bağlama: ünitenin BUGÜNKÜ (yem tarihinin takvim günü) aktif
        // planı kilitlenir. Gün eşleşmesi UTC günüdür — site-TZ gün sınırındaki
        // dar gece penceresinde bağlama OLMAZ (yanlış plana bağlanmaktansa
        // yalnız-ledger davranışına düşer, fail-safe). Plansız üniteye manuel
        // yem eskisi gibi yalnız ledger yoluyla akar.
        const boundPlan = await manager
          .createQueryBuilder(FeedingDayPlan, 'dp')
          .setLock('pessimistic_write')
          .where('dp.tenantId = :tenantId', { tenantId })
          .andWhere('dp.unitId = :unitId', { unitId })
          .andWhere('dp.siteId = :siteId', { siteId })
          .andWhere('dp.planDate = :day', { day: localPlanDate })
          .andWhere('dp.status IN (:...statuses)', {
            statuses: [FeedingDayPlanStatus.PLANNED, FeedingDayPlanStatus.IN_PROGRESS],
          })
          .getOne();
        if (!boundPlan) {
          throw new BadRequestException(
            `No active feeding plan exists for unit ${unitId} on local day ${localPlanDate}`,
          );
        }

        // Feed'i doğrula (inside TX)
        const feed = await manager.findOne(Feed, {
          where: { id: payload.feedId, tenantId },
        });

        if (!feed) {
          throw new NotFoundException(`Feed ${payload.feedId} bulunamadı`);
        }

        // (1) Plan-dışı toplam atomik artar — gün-sonu varyansı
        // Σ(planlı + plansız actual) vs plannedTotalKg üzerinden okunur (D-16).
        await this.feedingMutations.incrementDayPlanUnplannedActual(context.mutationSession, {
          dayPlanId: boundPlan.id,
          deltaKg: payload.actualAmount,
        });

        // (2) FCR provenance olmadan büyüme üretilemez. Önceki yol burada
        // sessizce ledger-only commit ediyordu; artık plan/FCR eksikliği tüm
        // mutasyonu fail-closed yapar.
        const expectedFcr = Number(boundPlan.resolution.expectedFcr) || 0;
        if (expectedFcr <= 0) {
          throw new BadRequestException(
            `Feeding plan ${boundPlan.id} has no positive immutable FCR snapshot`,
          );
        }
        const growth = await locked.applyGrowth(payload.actualAmount / expectedFcr, expectedFcr);
        await this.feedingMutations.recordDayPlanGrowthApplication(context.mutationSession, {
          dayPlanId: boundPlan.id,
          applicationMode: 'UNPLANNED_FEED',
          appliedAt: observedAt,
          expectedFcr,
          feedDeltaKg: payload.actualAmount,
          growthDeltaKg: growth.appliedGrowthKg,
          operationId: context.operationId,
          idempotencyKey: `growth:${boundPlan.id}:unplanned:${context.operationId}`,
          recordedBy: userId,
          sourceRef: `manual-feeding-operation:${context.operationId}`,
        });

        // (3) Kalan öğünler yeni biomass'tan yeniden fiyatlanır; recalcLog'a
        // 'unplanned_feed' gerekçesi düşer (sessiz recalc yok).
        await this.recalcService.recalcForUnit(
          manager,
          context.mutationSession,
          tenantId,
          unitId,
          'unplanned_feed',
          { mutationInstant: locked.mutationInstant },
        );

        // TEK yem yazma yolu (P-05): kayıt + batch aggregate + storage düşümü
        // (site kapsamlı, D-9) + FeedingRecordedEvent outbox — hepsi ledger'da.
        // Storage düşümü akışın SON yazımıdır (K-1) — plan bağlama yukarıda bitti.
        const saved = await this.feedingLedger.recordFeed(
          manager,
          context.mutationSession,
          tenantId,
          userId,
          batch,
          feed,
          {
            operationId: context.operationId,
            batchId: payload.batchId,
            tankId: payload.tankId,
            pondId: payload.pondId,
            batchLocationId: payload.batchLocationId,
            feedId: payload.feedId,
            plannedAmountKg: payload.plannedAmount,
            actualAmountKg: payload.actualAmount,
            wasteAmountKg: payload.wasteAmount,
            feedingDate: proposedDate,
            feedingTime: payload.feedingTime,
            feedingMethod: payload.feedingMethod
              ? FEEDING_METHOD_BY_WIRE[payload.feedingMethod]
              : FeedingMethod.MANUAL,
            equipmentId: payload.equipmentId,
            feedBatchNumber: payload.feedBatchNumber,
            fedBy: payload.fedBy || userId,
            notes: payload.notes,
            feedCost: payload.feedCost,
            currency: payload.currency,
            // D-7: plan-dışı kayıt plana bağlanır (mealId NULL kalır); site
            // kapsamı plan denormundan gelir (D-9).
            dayPlanId: boundPlan?.id,
            siteId,
            extras: {
              environment: payload.environment,
              fishBehavior: projectFishBehavior(payload.fishBehavior),
              feedingDurationMinutes: payload.feedingDurationMinutes,
              feedingSequence: payload.feedingSequence || 1,
              totalMealsToday: payload.totalMealsToday || 1,
              skipReason: payload.skipReason,
            },
          },
        );

        return projectFeedingRecordOperationResult(saved);
      },
    );
    if (!execution) {
      throw new BadRequestException(`Feeding unit ${unitId} has no active stock projection`);
    }
    return execution;
  }
}
