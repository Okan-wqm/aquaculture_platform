/**
 * MealOperationExecutor — verified operation sessions için öğün domain executor'ı.
 *
 * `recordMealFeeding` TEK tenant transaction'ında KANONİK KİLİT SIRASINA uyar
 * (K-1): Batch(ler, batchId asc) → TankBatch (BiomassGrowthApplier kilit
 * yardımcısı) → FeedingDayPlan → FeedingMeal → (gerekirse) ProtocolAssignment →
 * storage EN SON (FeedingLedgerService içinde). Site yetkisi yazma tx'i
 * İÇİNDE fail-closed doğrulanır (SEC-HIGH-051).
 *
 * Kısmi öğün (D-8): her döküm `pours[]`'a eklenir ve ledger üzerinden BİR
 * `feeding_records` satırı üretir (idempotency `meal-deduct-<mealId>-<pourIndex>`
 * — replay çift düşüm YAPAMAZ; operation ledger bu executor çağrılmadan önce
 * terminal sonucu döndürür, ledger idempotency anahtarı da ikinci katmandır).
 * Öğün operatör onayıyla (`finalize`) kapanır: varyans hesaplanır, `per_meal`
 * modda büyüme uygulanır (growthKg = actualKg / beklenenFCR — snapshot'taki
 * OVERRIDE çözümü aynen kullanılır), kalan öğünler AYNI tx'te yeniden
 * fiyatlanır ve az-atım eşiği aşıldıysa `MealUnderfed` yazılır (P-21).
 *
 * C-17: stok-azaltan bu akış legacy (envelope'suz) modu REDDeder — eski
 * `recordDailyFeeding`'in drain-penceresi toleransı bu yola taşınmaz.
 *
 * Öğün kaydında paralel mortality alanı YOKTUR (P-31) — UI kanonik mortality
 * komutuna yönlendirir; o komut recalc'ı zaten tetikler.
 *
 * @module FeedingProtocol/Services
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  toEventIso,
  MealFedEvent,
  MealSkippedEvent,
} from '@platform/event-contracts';

import { round3 } from '../../common/utils/rounding.util';

import { FeedingMeal, FeedingMealStatus, MealPour } from '../entities/feeding-meal.entity';
import { FeedingDayPlan } from '../entities/feeding-day-plan.entity';
import { FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { FeedingLedgerService } from '../../feeding/services/feeding-ledger.service';
import { FeedingMethod, FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { BatchDomainService } from '../../batch/services/batch-domain.service';
import { resolveTankSiteId } from '../../batch/utils/tank-lookup.util';
import { FeedingStorageCorrectionService } from '../../feeding/services/feeding-storage-correction.service';
import type { FeedingRecordUpdatedEvent } from '@platform/event-contracts';
import type {
  CorrectMealOperationCommand,
  FinalizeMealOperationCommand,
  MealOperationResult,
  RecordMealOperationCommand,
  SkipMealOperationCommand,
} from '../feeding-operation-command';
import type { FeedingMealOperationHandler } from '../feeding-operation-handler';
import type { FeedingOperationSession } from '../feeding-operation-session';
import {
  feedingOperationObservedAt,
  readFeedingOperationSession,
} from '../feeding-operation-session';
import { FeedingAggregateMutationPort } from '../feeding-aggregate-mutation.writer';
import { BatchAggregateMutationPort } from '../../batch/batch-aggregate-mutation.port';
import { MealFinalizationAuthority } from '../services/meal-finalization.authority';

// ============================================================================
// TYPES
// ============================================================================

type MealFeedingResult = MealOperationResult;

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class MealOperationExecutor implements FeedingMealOperationHandler {
  constructor(
    private readonly feedingMutations: FeedingAggregateMutationPort,
    private readonly batchMutations: BatchAggregateMutationPort,
    private readonly siteAuth: SiteAuthorizationService,
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly recalcService: DayPlanRecalcService,
    private readonly mealFinalization: MealFinalizationAuthority,
    private readonly feedingLedger: FeedingLedgerService,
    private readonly batchDomainService: BatchDomainService,
    private readonly storageCorrection: FeedingStorageCorrectionService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async executeRecordMealOperation(
    session: FeedingOperationSession,
    command: RecordMealOperationCommand,
  ): Promise<MealFeedingResult> {
    const context = readFeedingOperationSession(session);
    const manager = context.manager;
    const observedAt = feedingOperationObservedAt(context);
    const params = {
      tenantId: command.tenantId,
      userId: command.actorId,
      caller: {
        sub: command.caller.sub,
        roles: [...command.caller.roles],
        assignedSiteIds: command.caller.assignedSiteIds
          ? [...command.caller.assignedSiteIds]
          : undefined,
      },
      mealId: command.mealId,
      pourKg: command.pourKg,
      finalize: command.finalize,
      feedingMethod: command.feedingMethod,
      notes: command.notes,
    };

    // Operation ledger has already admitted and fenced this envelope. This
    // bounded executor owns only the domain lock/write sequence.
    const preview = await manager.findOne(FeedingMeal, {
      where: { id: params.mealId, tenantId: params.tenantId },
    });
    if (!preview) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);

    // 3) Kanonik kilitler: Batch(asc) → TankBatch (+ TÜM batch'ler feedable, D-2).
    const execution = await this.growthApplier.withUnitGrowthMutation(
      manager,
      context.mutationSession,
      params.tenantId,
      preview.unitId,
      context.mutationInstant,
      async (locked) => {
        // Every aggregate read/write below executes while the closed unit-growth
        // capability owns the canonical Batch → TankBatch lock composition.
        for (const batch of locked.batches.values()) {
          this.batchDomainService.assertFeedable(batch);
        }

        // 4) DayPlan → Meal kilitleri + durum doğrulaması.
        const dayPlan = await manager.findOne(FeedingDayPlan, {
          where: { id: preview.dayPlanId, tenantId: params.tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!dayPlan) throw new NotFoundException(`Gün planı bulunamadı: ${preview.dayPlanId}`);
        const meal = await manager.findOne(FeedingMeal, {
          where: { id: params.mealId, tenantId: params.tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!meal) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);
        if (
          meal.status !== FeedingMealStatus.SCHEDULED &&
          meal.status !== FeedingMealStatus.PARTIALLY_FED
        ) {
          throw new ConflictException(
            `Öğün '${meal.status}' durumunda — yalnız scheduled/partially_fed öğün beslenebilir`,
          );
        }

        // 5) SEC-HIGH-051: site yetkisi yazma tx'i İÇİNDE, fail-closed.
        const siteId = await resolveTankSiteId(manager, meal.unitId, params.tenantId);
        this.siteAuth.assertSiteAssignment({
          caller: {
            sub: params.caller.sub,
            roles: [...params.caller.roles],
            assignedSiteIds: params.caller.assignedSiteIds
              ? [...params.caller.assignedSiteIds]
              : undefined,
          },
          siteId,
        });

        // 6) Döküm ekle (kümülatif) — ledger tek yem yazma yolu (storage EN SON).
        const pourIndex = (meal.pours ?? []).length;
        const now = observedAt;
        const pour: MealPour = {
          pourIndex,
          kg: round3(params.pourKg),
          at: now.toISOString(),
          by: params.userId,
          feedingMethod: params.feedingMethod,
        };
        meal.pours = [...(meal.pours ?? []), pour];
        meal.actualKg = round3(Number(meal.actualKg || 0) + params.pourKg);
        meal.feedingMethod = params.feedingMethod ?? meal.feedingMethod;
        if (params.notes) meal.notes = params.notes;

        const primaryBatchId = locked.tankBatch.primaryBatchId;
        const primaryBatch = primaryBatchId ? locked.batches.get(primaryBatchId) : undefined;
        if (!primaryBatch) {
          throw new ConflictException(
            `Ünitenin birincil batch'i çözülemedi (${meal.unitId}) — yem kaydı batch'siz yazılamaz`,
          );
        }
        const feed = await manager.findOne(Feed, {
          where: { id: meal.feedId, tenantId: params.tenantId },
        });
        if (!feed) throw new NotFoundException(`Yem bulunamadı: ${meal.feedId}`);

        await this.feedingLedger.recordFeed(
          manager,
          context.mutationSession,
          params.tenantId,
          params.userId,
          primaryBatch,
          feed,
          {
            operationId: context.operationId,
            batchId: primaryBatch.id,
            tankId: meal.unitId,
            feedId: meal.feedId,
            plannedAmountKg: params.finalize ? Number(meal.plannedKg) : undefined,
            actualAmountKg: params.pourKg,
            feedingDate: now,
            feedingTime: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`,
            feedingMethod: params.feedingMethod ?? FeedingMethod.MANUAL,
            fedBy: params.userId,
            mealId: meal.id,
            pourIndex,
            dayPlanId: dayPlan.id,
            siteId: siteId ?? undefined,
          },
        );

        // 7) MealFed — döküm başına durable event (D-8 granülü).
        const fedEvent: MealFedEvent = {
          ...createBaseEvent<MealFedEvent>('MealFed', params.tenantId, {
            aggregateId: meal.id,
            aggregateType: 'FeedingMeal',
          }),
          unitId: meal.unitId,
          mealId: meal.id,
          dayPlanId: dayPlan.id,
          feedId: meal.feedId,
          pourIndex,
          pourKg: pour.kg,
          actualKg: meal.actualKg,
          fedAt: toEventIso(now),
          feedingMethod: params.feedingMethod,
        };
        await this.outboxPublisher.enqueue(fedEvent, manager);

        // 8) Both operator and scheduler closure use the same finalization body.
        if (params.finalize) {
          const protocol = await manager.findOne(FeedingProtocolV2, {
            where: { id: dayPlan.protocolId, tenantId: params.tenantId },
          });
          await this.mealFinalization.finalize(manager, {
            tenantId: params.tenantId,
            mutationSession: context.mutationSession,
            dayPlan,
            meal,
            growthScope: locked,
            operationId: context.operationId,
            finalizedAt: now,
            fedBy: params.userId,
            underfeedThresholdPercent: protocol?.settings.underfeedAlertThresholdPercent,
          });
        } else {
          meal.status = FeedingMealStatus.PARTIALLY_FED;
          await this.feedingMutations.commitMealTransition(context.mutationSession, {
            intent: 'recorded',
            aggregate: meal,
          });
          await this.mealFinalization.settleDayPlanStatus(
            manager,
            context.mutationSession,
            params.tenantId,
            dayPlan,
          );
        }

        return {
          id: meal.id,
          status: meal.status,
          actualKg: meal.actualKg,
          varianceKg: meal.varianceKg ?? null,
          variancePercent: meal.variancePercent ?? null,
        } satisfies MealFeedingResult;
      },
    );
    if (!execution) {
      throw new ConflictException(`Ünitede stok kaydı yok: ${preview.unitId}`);
    }
    return execution;
  }

  /**
   * Closes a genuinely partial meal without manufacturing another pour.
   * The same catalogued transaction, canonical lock order, site authorization
   * and finalization authority used by record/finalize and the scheduler apply.
   */
  async executeFinalizeMealOperation(
    session: FeedingOperationSession,
    command: FinalizeMealOperationCommand,
  ): Promise<MealFeedingResult> {
    const context = readFeedingOperationSession(session);
    const manager = context.manager;
    const observedAt = feedingOperationObservedAt(context);
    const preview = await manager.findOne(FeedingMeal, {
      where: { id: command.mealId, tenantId: command.tenantId },
    });
    if (!preview) throw new NotFoundException(`Öğün bulunamadı: ${command.mealId}`);

    const result = await this.growthApplier.withUnitGrowthMutation(
      manager,
      context.mutationSession,
      command.tenantId,
      preview.unitId,
      context.mutationInstant,
      async (growthScope) => {
        for (const batch of growthScope.batches.values()) {
          this.batchDomainService.assertFeedable(batch);
        }

        const dayPlan = await manager.findOne(FeedingDayPlan, {
          where: { id: preview.dayPlanId, tenantId: command.tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!dayPlan) throw new NotFoundException(`Gün planı bulunamadı: ${preview.dayPlanId}`);
        const meal = await manager.findOne(FeedingMeal, {
          where: { id: command.mealId, tenantId: command.tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!meal) throw new NotFoundException(`Öğün bulunamadı: ${command.mealId}`);
        if (meal.status !== FeedingMealStatus.PARTIALLY_FED) {
          throw new ConflictException(
            `Öğün '${meal.status}' durumunda — döküm eklemeden yalnız partially_fed öğün kapatılabilir; hiç dökümü olmayan öğün için skipMeal kullanın`,
          );
        }

        const siteId = await resolveTankSiteId(manager, meal.unitId, command.tenantId);
        this.siteAuth.assertSiteAssignment({
          caller: {
            sub: command.caller.sub,
            roles: [...command.caller.roles],
            assignedSiteIds: command.caller.assignedSiteIds
              ? [...command.caller.assignedSiteIds]
              : undefined,
          },
          siteId,
        });

        const protocol = await manager.findOne(FeedingProtocolV2, {
          where: { id: dayPlan.protocolId, tenantId: command.tenantId },
        });
        await this.mealFinalization.finalize(manager, {
          tenantId: command.tenantId,
          mutationSession: context.mutationSession,
          dayPlan,
          meal,
          growthScope,
          operationId: context.operationId,
          finalizedAt: observedAt,
          fedBy: command.actorId,
          underfeedThresholdPercent: protocol?.settings.underfeedAlertThresholdPercent,
        });

        return {
          id: meal.id,
          status: meal.status,
          actualKg: Number(meal.actualKg),
          varianceKg: meal.varianceKg ?? null,
          variancePercent: meal.variancePercent ?? null,
        } satisfies MealFeedingResult;
      },
    );
    if (!result) throw new ConflictException(`Ünitede stok kaydı yok: ${preview.unitId}`);
    return result;
  }

  /**
   * Döküm düzeltmesi (C-11): fark kadar stok hareketi (IN iade / ek OUT) +
   * kayıt/öğün varyansı + growth-delta AYNI transaction'da. `updateFeedingRecord`
   * öğün-bağlı kayıtları buraya yönlendirir — P-05 invariantı düzeltmede de
   * bütündür. Düzeltme geçmişi pour üzerinde denetlenebilir (originalKg,
   * correctedAt/By, corrections sayacı).
   */

  async executeCorrectMealOperation(
    session: FeedingOperationSession,
    command: CorrectMealOperationCommand,
  ): Promise<MealFeedingResult> {
    const context = readFeedingOperationSession(session);
    const manager = context.manager;
    const observedAt = feedingOperationObservedAt(context);
    const params = {
      tenantId: command.tenantId,
      userId: command.actorId,
      caller: command.caller,
      mealId: command.mealId,
      pourIndex: command.pourIndex,
      correctedKg: command.correctedKg,
    };

    const preview = await manager.findOne(FeedingMeal, {
      where: { id: params.mealId, tenantId: params.tenantId },
    });
    if (!preview) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);

    // Kanonik kilitler (recordMealFeeding ile aynı sıra).
    const execution = await this.growthApplier.withUnitGrowthMutation(
      manager,
      context.mutationSession,
      params.tenantId,
      preview.unitId,
      context.mutationInstant,
      async (locked) => {
        const dayPlan = await manager.findOne(FeedingDayPlan, {
          where: { id: preview.dayPlanId, tenantId: params.tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!dayPlan) throw new NotFoundException(`Gün planı bulunamadı: ${preview.dayPlanId}`);
        const meal = await manager.findOne(FeedingMeal, {
          where: { id: params.mealId, tenantId: params.tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!meal) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);

        const siteId = await resolveTankSiteId(manager, meal.unitId, params.tenantId);
        this.siteAuth.assertSiteAssignment({
          caller: {
            sub: params.caller.sub,
            roles: [...params.caller.roles],
            assignedSiteIds: params.caller.assignedSiteIds
              ? [...params.caller.assignedSiteIds]
              : undefined,
          },
          siteId,
        });

        const pour = (meal.pours ?? []).find((entry) => entry.pourIndex === params.pourIndex);
        if (!pour) {
          throw new NotFoundException(
            `Öğün ${params.mealId} üzerinde ${params.pourIndex} numaralı döküm yok`,
          );
        }
        const delta = round3(params.correctedKg - pour.kg);
        const currentResult: MealFeedingResult = {
          id: meal.id,
          status: meal.status,
          actualKg: Number(meal.actualKg || 0),
          varianceKg: meal.varianceKg ?? null,
          variancePercent: meal.variancePercent ?? null,
        };
        if (delta === 0) return currentResult; // no-op düzeltme

        // Pour + öğün güncellemesi (denetim izi korunur).
        const now = observedAt;
        pour.originalKg = pour.originalKg ?? pour.kg;
        pour.kg = params.correctedKg;
        pour.correctedAt = now.toISOString();
        pour.correctedBy = params.userId;
        pour.corrections = (pour.corrections ?? 0) + 1;
        meal.pours = [...(meal.pours ?? [])];
        meal.actualKg = round3(Number(meal.actualKg || 0) + delta);
        if (meal.status === FeedingMealStatus.FED) {
          meal.varianceKg = round3(meal.actualKg - Number(meal.plannedKg));
          meal.variancePercent =
            Number(meal.plannedKg) > 0
              ? round3(((meal.actualKg - Number(meal.plannedKg)) / Number(meal.plannedKg)) * 100)
              : 0;
        }
        await this.feedingMutations.commitMealTransition(context.mutationSession, {
          intent: 'corrected',
          aggregate: meal,
        });

        // Ledger kaydı: (mealId, pourIndex) unique — döküm başına TAM bir satır (P-05).
        const record = await manager.findOne(FeedingRecord, {
          where: { tenantId: params.tenantId, mealId: meal.id, pourIndex: params.pourIndex },
        });
        if (!record) {
          throw new ConflictException(
            `Döküm kaydı bulunamadı (meal ${meal.id}, pour ${params.pourIndex}) — ledger tutarsız`,
          );
        }
        const previousAmount = Number(record.actualAmount);
        const previousCost = Number(record.feedCost || 0);
        if (
          !Number.isFinite(previousAmount) ||
          previousAmount <= 0 ||
          !Number.isFinite(previousCost) ||
          previousCost < 0
        ) {
          throw new ConflictException(
            `Döküm kaydı ${record.id} geçerli tarihsel miktar/maliyet provenance'ı taşımıyor`,
          );
        }
        // A correction reprices the original economic fact at its historical
        // unit cost. Looking up today's Feed.pricePerKg would silently rewrite
        // history whenever the catalogue price changed after the pour.
        const historicalUnitCost = previousCost / previousAmount;
        const newCost = round3(historicalUnitCost * params.correctedKg);
        record.actualAmount = params.correctedKg;
        record.feedCost = newCost;
        record.calculateVariance();
        await this.feedingMutations.commitFeedingRecordTransition(context.mutationSession, {
          intent: 'corrected',
          aggregate: record,
        });

        // Batch aggregate delta'ları (kayıttaki batch kilitli set'te olmalı).
        const batch = locked.batches.get(record.batchId);
        if (!batch) {
          throw new ConflictException(
            `Kayıt batch'i (${record.batchId}) ünitenin kilitli batch kümesinde değil — üyelik değişti, yeniden deneyin`,
          );
        }
        batch.totalFeedConsumed = round3(Number(batch.totalFeedConsumed || 0) + delta);
        batch.totalFeedCost = round3(Number(batch.totalFeedCost || 0) + (newCost - previousCost));
        await this.batchMutations.commitBatchTransition(context.mutationSession, {
          intent: 'feeding_corrected',
          aggregate: batch,
        });

        // Storage düzeltmesi — fark kadar; Phase-A (storage izi olmayan feed) atlanır.
        await this.storageCorrection.apply(context.mutationSession, {
          tenantId: params.tenantId,
          userId: params.userId,
          feedId: meal.feedId,
          deltaKg: delta,
          siteId: siteId ?? undefined,
          movementDate: now,
          sourceDeductionKey: `meal-deduct-${params.mealId}-${params.pourIndex}`,
          correctionIdempotencyKey: `meal-correct-${params.mealId}-${params.pourIndex}-${pour.corrections}`,
          reference: `MEAL-CORRECTION: ${params.mealId}#${params.pourIndex}`,
        });

        // Growth delta (finalize edilmiş + per_meal protokol) + kalan öğün recalc'ı.
        if (meal.status === FeedingMealStatus.FED) {
          if (dayPlan.growthApplicationMode === 'per_meal') {
            const expectedFcr = dayPlan.resolution.expectedFcr;
            const growthDelta = expectedFcr > 0 ? delta / expectedFcr : 0;
            const growth = await locked.applyGrowth(growthDelta, expectedFcr);
            await this.feedingMutations.recordDayPlanGrowthApplication(context.mutationSession, {
              dayPlanId: dayPlan.id,
              applicationMode: 'MEAL_CORRECTION',
              appliedAt: now,
              expectedFcr,
              feedDeltaKg: delta,
              growthDeltaKg: growth.appliedGrowthKg,
              operationId: context.operationId,
              idempotencyKey: `growth:${dayPlan.id}:meal-correction:${context.operationId}`,
              recordedBy: params.userId,
              sourceRef: `feeding-meal:${meal.id}:pour:${params.pourIndex}`,
            });
            await this.recalcService.recalcForUnit(
              manager,
              context.mutationSession,
              params.tenantId,
              meal.unitId,
              'pour_correction',
              { mutationInstant: locked.mutationInstant },
            );
          }
        }

        // Düzeltme, mevcut FeedingRecordUpdated kontratıyla duyurulur (ek tip yok).
        const event: FeedingRecordUpdatedEvent = {
          ...createBaseEvent<FeedingRecordUpdatedEvent>('FeedingRecordUpdated', params.tenantId, {
            aggregateId: record.batchId,
            aggregateType: 'Batch',
          }),
          feedingRecordId: record.id,
          batchId: record.batchId,
          previousActualAmountKg: previousAmount,
          newActualAmountKg: params.correctedKg,
          amountDiffKg: delta,
          previousFeedCost: previousCost,
          newFeedCost: newCost,
          costDiff: round3(newCost - previousCost),
          updatedAt: toEventIso(now),
        };
        await this.outboxPublisher.enqueue(event, manager);

        return {
          id: meal.id,
          status: meal.status,
          actualKg: meal.actualKg,
          varianceKg: meal.varianceKg ?? null,
          variancePercent: meal.variancePercent ?? null,
        } satisfies MealFeedingResult;
      },
    );
    if (!execution) throw new ConflictException(`Ünitede stok kaydı yok: ${preview.unitId}`);
    return execution;
  }

  /**
   * Öğünü atla — biomass/stok dokunuşu yok; MealSkipped durable event (P-12).
   * Kilitler kanonik sırada (K-1): DayPlan → Meal — record/correct ile aynı yön.
   */

  async executeSkipMealOperation(
    session: FeedingOperationSession,
    command: SkipMealOperationCommand,
  ): Promise<MealFeedingResult> {
    const context = readFeedingOperationSession(session);
    const manager = context.manager;
    const observedAt = feedingOperationObservedAt(context);
    const params = {
      tenantId: command.tenantId,
      userId: command.actorId,
      caller: command.caller,
      mealId: command.mealId,
      reason: command.reason,
    };

    // Kilitsiz ön-okuma: dayPlan kimliği (kanonik sıra K-1 — DayPlan → Meal).
    const preview = await manager.findOne(FeedingMeal, {
      where: { id: params.mealId, tenantId: params.tenantId },
    });
    if (!preview) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);

    const dayPlan = await manager.findOne(FeedingDayPlan, {
      where: { id: preview.dayPlanId, tenantId: params.tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!dayPlan) throw new NotFoundException(`Gün planı bulunamadı: ${preview.dayPlanId}`);
    const meal = await manager.findOne(FeedingMeal, {
      where: { id: params.mealId, tenantId: params.tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!meal) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);
    if (meal.status !== FeedingMealStatus.SCHEDULED) {
      throw new ConflictException(`Yalnız scheduled öğün atlanabilir (durum: ${meal.status})`);
    }

    const siteId = await resolveTankSiteId(manager, meal.unitId, params.tenantId);
    this.siteAuth.assertSiteAssignment({
      caller: {
        sub: params.caller.sub,
        roles: [...params.caller.roles],
        assignedSiteIds: params.caller.assignedSiteIds
          ? [...params.caller.assignedSiteIds]
          : undefined,
      },
      siteId,
    });

    meal.status = FeedingMealStatus.SKIPPED;
    meal.notes = params.reason;
    await this.feedingMutations.commitMealTransition(context.mutationSession, {
      intent: 'skipped',
      aggregate: meal,
    });

    const event: MealSkippedEvent = {
      ...createBaseEvent<MealSkippedEvent>('MealSkipped', params.tenantId, {
        aggregateId: meal.id,
        aggregateType: 'FeedingMeal',
      }),
      unitId: meal.unitId,
      mealId: meal.id,
      dayPlanId: meal.dayPlanId,
      reason: params.reason,
      skippedAt: toEventIso(observedAt),
    };
    await this.outboxPublisher.enqueue(event, manager);

    await this.mealFinalization.settleDayPlanStatus(
      manager,
      context.mutationSession,
      params.tenantId,
      dayPlan,
    );

    return {
      id: meal.id,
      status: meal.status,
      actualKg: Number(meal.actualKg || 0),
      varianceKg: null,
      variancePercent: null,
    };
  }
}
