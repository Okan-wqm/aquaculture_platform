/**
 * DayPlanRecalcService — gün içi yeniden hesap (Faz 5, P-31 kökten çözümü).
 *
 * Biyokütle-değiştiren her olay (mortality/cull/harvest/transfer/grading),
 * yeni manuel sıcaklık, protokol/atama değişimi ve plan-dışı yem AYNI
 * transaction'da bu servisi çağırır: bugünkü planın HENÜZ beslenmemiş
 * öğünleri güncel TankBatch durumu üzerinden yeniden fiyatlanır, gerekçe
 * `recalcLog`'a işlenir — v1'in "yarına kadar eski plan" davranışı ölür.
 *
 * Kilit disiplini (K-1): removal handler'ları Batch → TankBatch kilitlerini
 * ZATEN tutarken çağırır; bu servis DayPlan → Meals → (gerekirse)
 * ProtocolAssignment kilitlerini kanonik sırada alır. Sıcaklık tetiklemesi
 * TankBatch'i KİLİTSİZ okur (belgeli — plan §2).
 *
 * Boş ünite (count=0 — tam hasat/transfer): kalan öğünler `cancelled`, plan
 * kapanır, atama otomatik `paused` + `FeedingProtocolAssignmentPaused`
 * (unit_emptied) event'i — 06:00'da boş üniteye plan üretilmez.
 *
 * Band geçişi: autoTransition + `transitionBufferG` HİSTEREZİSİ (sınırda
 * ileri-geri salınım imkânsız): yukarı geçiş yeni bandın min'ini buffer kadar
 * AŞMAYI, aşağı geçiş yeni bandın max'inin buffer kadar ALTINI şart koşar.
 * Geçişte assignment currentFeed/band güncellenir, kalan öğünlerin feedId'si
 * değişir, `FeedTypeTransitioned` outbox'a yazılır (P-12).
 *
 * @module FeedingProtocol/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  mutationInstantDateV1,
  mutationInstantIsoV1,
  type MutationInstantV1,
  type TenantMutationSession,
} from '@aquaculture/backend-common/database';
import { EntityManager, In } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  FeedingProtocolAssignmentPausedEvent,
  FeedTypeTransitionedEvent,
} from '@platform/event-contracts';

import { round3 } from '../../common/utils/rounding.util';

import { FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import {
  FeedingDayPlan,
  FeedingDayPlanStatus,
  RecalcLogEntry,
} from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { repriceRemaining } from './meal-schedule.util';
import { FeedingAggregateMutationPort } from '../feeding-aggregate-mutation.writer';
import {
  projectDayPlanResolutionV1,
  ProtocolResolutionAuthority,
} from './protocol-resolution.authority';
import { Feed } from '../../feed/entities/feed.entity';
import { buildFeedFcrMatrixMap, collectFeedSourceFeedIds } from './feed-fcr-source.util';
import { DAY_PLAN_RECALC_AUDIT_POLICY_V1 } from '../day-plan-recalc-audit.authority';

export type RecalcReason = RecalcLogEntry['reason'];

export interface RecalcResult {
  dayPlanId: string;
  outcome: 'repriced' | 'cancelled_empty_unit' | 'no_active_plan';
  transitioned: boolean;
  remainingPlannedKg: number;
}

export interface DayPlanRecalcMutationV1 {
  readonly mutationInstant: MutationInstantV1;
  readonly newTemperatureC?: number | null;
}

@Injectable()
export class DayPlanRecalcService {
  private readonly logger = new Logger(DayPlanRecalcService.name);

  constructor(
    private readonly feedingMutations: FeedingAggregateMutationPort,
    private readonly resolutionAuthority: ProtocolResolutionAuthority,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Ünitenin AKTİF (planned/in_progress) en güncel planını yeniden hesaplar.
   * Çağıran transaction'ı sahiplenir; biyokütle yazımıyla AYNI tx'te koşar.
   */
  async recalcForUnit(
    manager: EntityManager,
    mutationSession: TenantMutationSession,
    tenantId: string,
    unitId: string,
    reason: RecalcReason,
    mutation: DayPlanRecalcMutationV1,
  ): Promise<RecalcResult | null> {
    const dayPlan = await manager
      .createQueryBuilder(FeedingDayPlan, 'plan')
      .setLock('pessimistic_write')
      .where('plan.tenantId = :tenantId AND plan.unitId = :unitId', { tenantId, unitId })
      .andWhere('plan.status IN (:...statuses)', {
        statuses: [FeedingDayPlanStatus.PLANNED, FeedingDayPlanStatus.IN_PROGRESS],
      })
      .orderBy('plan.planDate', 'DESC')
      .getOne();
    if (!dayPlan) return null;

    const remainingMeals = await manager
      .createQueryBuilder(FeedingMeal, 'meal')
      .setLock('pessimistic_write')
      .where('meal.dayPlanId = :dayPlanId', { dayPlanId: dayPlan.id })
      .andWhere('meal.status = :status', { status: FeedingMealStatus.SCHEDULED })
      .orderBy('meal.mealIndex', 'ASC')
      .getMany();

    // Sıcaklık tetiklemesi TankBatch'i kilitsiz okur; removal tetikleyicileri
    // kilidi zaten tutar — her iki durumda da güncel satır okunur (aynı tx).
    const tankBatch = await manager.findOne(TankBatch, { where: { tankId: unitId, tenantId } });
    const fishCount = tankBatch?.totalQuantity ?? 0;
    const biomassKg = Number(tankBatch?.totalBiomassKg ?? 0);
    const avgWeightG = Number(tankBatch?.avgWeightG ?? 0);

    // Boş ünite: kalan öğünler iptal, plan kapanır, atama otomatik pause.
    if (fishCount <= 0 || biomassKg <= 0) {
      for (const meal of remainingMeals) {
        meal.status = FeedingMealStatus.CANCELLED;
        await this.feedingMutations.commitMealTransition(mutationSession, {
          intent: 'recalculated',
          aggregate: meal,
        });
      }
      dayPlan.status = FeedingDayPlanStatus.CANCELLED;
      this.appendRecalcLog(dayPlan, reason, 0, biomassKg, mutation.mutationInstant, 'unit emptied');
      await this.feedingMutations.commitDayPlanTransition(mutationSession, {
        intent: 'recalculated',
        aggregate: dayPlan,
      });
      await this.pauseAssignment(manager, mutationSession, tenantId, dayPlan.assignmentId, unitId);
      return {
        dayPlanId: dayPlan.id,
        outcome: 'cancelled_empty_unit',
        transitioned: false,
        remainingPlannedKg: 0,
      };
    }

    // Atama + protokol (kanonik sıra: assignment kilidi MEALS'ten sonra).
    const assignment = await manager.findOne(ProtocolAssignment, {
      where: { id: dayPlan.assignmentId, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    const protocol = assignment
      ? await manager.findOne(FeedingProtocolV2, {
          where: { id: assignment.protocolId, tenantId },
        })
      : null;
    if (!assignment || !protocol) {
      this.logger.warn(
        `Recalc skipped: assignment/protocol missing for day plan ${dayPlan.id} (unit ${unitId}).`,
      );
      return {
        dayPlanId: dayPlan.id,
        outcome: 'no_active_plan',
        transitioned: false,
        remainingPlannedKg: 0,
      };
    }

    const feedIds = collectFeedSourceFeedIds([protocol]);
    const feeds = feedIds.length
      ? await manager.find(Feed, {
          where: { tenantId, id: In(feedIds) },
          select: ['id', 'feedingMatrix2D'],
        })
      : [];
    const currentIndex = assignment.currentBandIndex ?? dayPlan.resolution.bandIndex;
    const resolution = this.resolutionAuthority.resolve({
      protocol,
      assignment: {
        overrides: assignment.overrides,
        currentBandIndex: currentIndex,
        currentFeedId: assignment.currentFeedId,
      },
      bandBasisWeightG: this.resolutionAuthority.resolveBandBasisWeight({ avgWeightG }),
      temperature: {
        celsius:
          reason === 'temperature' && mutation.newTemperatureC !== undefined
            ? mutation.newTemperatureC
            : dayPlan.resolution.waterTempC,
        source: dayPlan.resolution.temperatureSource,
      },
      feedFcrMatrixByFeedId: buildFeedFcrMatrixMap(feeds),
      mutationInstant: mutation.mutationInstant,
      bandSelection: reason === 'manual_transition' ? 'pinned_current' : 'policy',
    });
    if (!resolution) {
      return {
        dayPlanId: dayPlan.id,
        outcome: 'no_active_plan',
        transitioned: false,
        remainingPlannedKg: 0,
      };
    }
    const effective = { band: resolution.band, index: resolution.bandIndex };
    let transitioned = false;
    const bandChanged = effective.index !== currentIndex;
    const fromFeedId = assignment.currentFeedId ?? dayPlan.resolution.feed.id;
    const feedChanged = effective.band.feedId !== fromFeedId;
    if (protocol.settings.autoTransition && bandChanged) {
      transitioned = true;
      assignment.currentFeedId = effective.band.feedId;
      assignment.currentBandIndex = effective.index;
      assignment.lastTransitionAt = mutationInstantDateV1(mutation.mutationInstant);
      assignment.totalTransitions = (assignment.totalTransitions ?? 0) + 1;
      await this.feedingMutations.commitProtocolAssignmentTransition(mutationSession, {
        intent: feedChanged ? 'feed_transitioned' : 'band_transitioned',
        aggregate: assignment,
      });
      if (feedChanged) {
        const event: FeedTypeTransitionedEvent = {
          ...createBaseEvent<FeedTypeTransitionedEvent>('FeedTypeTransitioned', tenantId, {
            aggregateId: unitId,
            aggregateType: 'FeedingUnit',
          }),
          unitId,
          unitCode: dayPlan.unitCode,
          assignmentId: assignment.id,
          fromFeedId,
          toFeedId: effective.band.feedId,
          toFeedCode: effective.band.feedCode,
          bandIndex: effective.index,
          avgWeightG,
          automatic: true,
        };
        await this.outboxPublisher.enqueue(event, manager);
      }
    }

    // Yeni günlük toplam (K-18 zinciri) → kalan öğünler KENDİ yüzdeleriyle
    // yeniden fiyatlanır; sıcaklık gerekçesinde yeni okuma kullanılır.
    const newDailyTotalKg = round3((biomassKg * resolution.effectiveRatePercent) / 100);
    const newPlanned = repriceRemaining(remainingMeals, newDailyTotalKg);

    let remainingPlannedKg = 0;
    const now = mutationInstantDateV1(mutation.mutationInstant);
    for (const [index, meal] of remainingMeals.entries()) {
      meal.plannedKg = newPlanned[index] ?? meal.plannedKg;
      meal.recalculatedAt = now;
      meal.feedId = resolution.feed.id;
      remainingPlannedKg += Number(meal.plannedKg);
      await this.feedingMutations.commitMealTransition(mutationSession, {
        intent: 'recalculated',
        aggregate: meal,
      });
    }

    // Gün toplamı: kapanmış öğünlerin planı + kalanların yeni planı.
    const settledMeals = await manager
      .createQueryBuilder(FeedingMeal, 'meal')
      .where('meal.dayPlanId = :dayPlanId', { dayPlanId: dayPlan.id })
      .andWhere('meal.status != :status', { status: FeedingMealStatus.SCHEDULED })
      .getMany();
    const settledPlannedKg = settledMeals.reduce((acc, meal) => acc + Number(meal.plannedKg), 0);
    dayPlan.plannedTotalKg = round3(settledPlannedKg + remainingPlannedKg);
    dayPlan.resolution = projectDayPlanResolutionV1(resolution);
    this.appendRecalcLog(dayPlan, reason, remainingPlannedKg, biomassKg, mutation.mutationInstant);
    await this.feedingMutations.commitDayPlanTransition(mutationSession, {
      intent: 'recalculated',
      aggregate: dayPlan,
    });

    return { dayPlanId: dayPlan.id, outcome: 'repriced', transitioned, remainingPlannedKg };
  }

  private appendRecalcLog(
    dayPlan: FeedingDayPlan,
    reason: RecalcReason,
    remainingPlannedKg: number,
    biomassKg: number,
    mutationInstant: MutationInstantV1,
    note?: string,
  ): void {
    dayPlan.recalcCount = Number(dayPlan.recalcCount ?? 0) + 1;
    dayPlan.recalcLog = [
      ...(dayPlan.recalcLog ?? []),
      {
        at: mutationInstantIsoV1(mutationInstant),
        reason,
        remainingPlannedKg: round3(remainingPlannedKg),
        biomassKg: round3(biomassKg),
        note,
      },
    ].slice(-DAY_PLAN_RECALC_AUDIT_POLICY_V1.retainedEntries);
  }

  private async pauseAssignment(
    manager: EntityManager,
    mutationSession: TenantMutationSession,
    tenantId: string,
    assignmentId: string,
    unitId: string,
  ): Promise<void> {
    const assignment = await manager.findOne(ProtocolAssignment, {
      where: { id: assignmentId, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!assignment || assignment.status !== ProtocolAssignmentStatus.ACTIVE) return;
    assignment.status = ProtocolAssignmentStatus.PAUSED;
    await this.feedingMutations.commitProtocolAssignmentTransition(mutationSession, {
      intent: 'feed_transitioned',
      aggregate: assignment,
    });
    const event: FeedingProtocolAssignmentPausedEvent = {
      ...createBaseEvent<FeedingProtocolAssignmentPausedEvent>(
        'FeedingProtocolAssignmentPaused',
        tenantId,
        { aggregateId: assignment.id, aggregateType: 'ProtocolAssignment' },
      ),
      assignmentId: assignment.id,
      unitId,
      unitCode: assignment.unitCode,
      protocolId: assignment.protocolId,
      reason: 'unit_emptied',
    };
    await this.outboxPublisher.enqueue(event, manager);
  }
}
