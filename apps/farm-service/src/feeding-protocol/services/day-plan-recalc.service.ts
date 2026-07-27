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
import { EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  FeedingProtocolAssignmentPausedEvent,
  FeedTypeTransitionedEvent,
} from '@platform/event-contracts';

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
import { ProtocolResolutionService } from './protocol-resolution.service';
import { repriceRemaining } from './meal-schedule.util';
import { round3 } from './rounding.util';

export type RecalcReason = RecalcLogEntry['reason'];

export interface RecalcResult {
  dayPlanId: string;
  outcome: 'repriced' | 'cancelled_empty_unit' | 'no_active_plan';
  transitioned: boolean;
  remainingPlannedKg: number;
}

@Injectable()
export class DayPlanRecalcService {
  private readonly logger = new Logger(DayPlanRecalcService.name);

  constructor(
    private readonly outboxPublisher: OutboxPublisher,
    // Band/oran/FCR çözümünün TEK sahibi (W3).
    private readonly resolutionService: ProtocolResolutionService,
  ) {}

  /**
   * Ünitenin AKTİF (planned/in_progress) en güncel planını yeniden hesaplar.
   * Çağıran transaction'ı sahiplenir; biyokütle yazımıyla AYNI tx'te koşar.
   */
  async recalcForUnit(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
    reason: RecalcReason,
    opts?: { newTemperatureC?: number | null },
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
        await manager.save(meal);
      }
      dayPlan.status = FeedingDayPlanStatus.CANCELLED;
      this.appendRecalcLog(dayPlan, reason, 0, biomassKg, 'unit emptied');
      await manager.save(dayPlan);
      await this.pauseAssignment(manager, tenantId, dayPlan.assignmentId, unitId);
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

    // Band çözümü + histerezisli geçiş kararı.
    // Band/oran/FCR çözümü TEK yerden (W3) — `autoTransition=false` burada da
    // korunur ve çözüm plana ATOMİK yazılır (eski hâl snapshot'a hiç
    // dokunmuyordu: operatör eski yemi görüyor, ledger yeni yemi düşüyordu).
    const currentIndex = assignment.currentBandIndex ?? dayPlan.resolution.bandIndex;
    const resolution = this.resolutionService.resolve({
      protocol,
      assignment: {
        overrides: assignment.overrides,
        currentBandIndex: currentIndex,
        currentFeedId: assignment.currentFeedId,
      },
      bandBasisWeightG: this.resolutionService.resolveBandBasisWeight({ avgWeightG }),
      temperature: {
        celsius:
          reason === 'temperature' && opts?.newTemperatureC !== undefined
            ? (opts.newTemperatureC ?? null)
            : dayPlan.resolution.waterTempC,
        source: dayPlan.resolution.temperatureSource,
      },
      applyHysteresis: true,
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
    if (
      protocol.settings.autoTransition &&
      effective.index !== currentIndex &&
      effective.band.feedId !== (assignment.currentFeedId ?? dayPlan.resolution.feed.id)
    ) {
      transitioned = true;
      const fromFeedId = assignment.currentFeedId ?? dayPlan.resolution.feed.id;
      assignment.currentFeedId = effective.band.feedId;
      assignment.currentBandIndex = effective.index;
      assignment.lastTransitionAt = new Date();
      assignment.totalTransitions = (assignment.totalTransitions ?? 0) + 1;
      await manager.save(assignment);
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

    // Yeni günlük toplam (K-18 zinciri) → kalan öğünler KENDİ yüzdeleriyle
    // yeniden fiyatlanır. Oran VE beklenen FCR aynı çözümden gelir: gün içi
    // band geçişinde eski bandın FCR'ıyla büyüme hesaplamak biyokütleyi
    // ~%55 şişiriyordu (FARM-MEDIUM-252).
    const newDailyTotalKg = round3((biomassKg * resolution.effectiveRatePercent) / 100);
    const newPlanned = repriceRemaining(remainingMeals, newDailyTotalKg);

    let remainingPlannedKg = 0;
    const now = new Date();
    for (const [index, meal] of remainingMeals.entries()) {
      meal.plannedKg = newPlanned[index] ?? meal.plannedKg;
      meal.recalculatedAt = now;
      if (transitioned) meal.feedId = effective.band.feedId;
      remainingPlannedKg += Number(meal.plannedKg);
      await manager.save(meal);
    }

    // Gün toplamı: kapanmış öğünlerin planı + kalanların yeni planı.
    const settledMeals = await manager
      .createQueryBuilder(FeedingMeal, 'meal')
      .where('meal.dayPlanId = :dayPlanId', { dayPlanId: dayPlan.id })
      .andWhere('meal.status != :status', { status: FeedingMealStatus.SCHEDULED })
      .getMany();
    const settledPlannedKg = settledMeals.reduce((acc, meal) => acc + Number(meal.plannedKg), 0);
    dayPlan.plannedTotalKg = round3(settledPlannedKg + remainingPlannedKg);
    // Çözüm ATOMİK güncellenir — plan, öğünler ve ledger aynı yemi/FCR'ı görür.
    dayPlan.resolution = {
      resolvedAt: resolution.resolvedAt,
      bandIndex: resolution.bandIndex,
      feed: resolution.feed,
      baseRatePercent: resolution.baseRatePercent,
      tempMultiplier: resolution.tempMultiplier,
      effectiveRatePercent: resolution.effectiveRatePercent,
      expectedFcr: resolution.expectedFcr,
      fcrResolvedSource: resolution.fcrResolvedSource,
      bandBasisWeightG: resolution.bandBasisWeightG,
      waterTempC: resolution.waterTempC,
      temperatureSource: resolution.temperatureSource,
    };
    this.appendRecalcLog(dayPlan, reason, remainingPlannedKg, biomassKg);
    await manager.save(dayPlan);

    return { dayPlanId: dayPlan.id, outcome: 'repriced', transitioned, remainingPlannedKg };
  }

  private appendRecalcLog(
    dayPlan: FeedingDayPlan,
    reason: RecalcReason,
    remainingPlannedKg: number,
    biomassKg: number,
    note?: string,
  ): void {
    dayPlan.recalcLog = [
      ...(dayPlan.recalcLog ?? []),
      {
        at: new Date().toISOString(),
        reason,
        remainingPlannedKg: round3(remainingPlannedKg),
        biomassKg: round3(biomassKg),
        note,
      },
    ];
  }

  private async pauseAssignment(
    manager: EntityManager,
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
    await manager.save(assignment);
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
