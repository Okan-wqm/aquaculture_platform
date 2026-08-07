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
 * Band geçişi: `FeedTypeTransitionService` — 06:00 üreticisiyle PAYLAŞILAN tek
 * mekanizma (histerezis, atama durumu yazımı ve `FeedTypeTransitioned` orada
 * yaşar); geçişte kalan öğünlerin feedId'si burada güncellenir.
 *
 * RATION BASIS (P-31'in kapanmamış yarısı): günlük tayın ARTIK canlı
 * biyokütleden değil, planın `rationBasisKg`'sinden fiyatlanır — gün başındaki
 * biyokütle, yalnız GERÇEK stok hareketleriyle (stoklama/ölüm/cull/transfer/
 * hasat/mutabakat) ve TARTIMLA değişir. FCR projeksiyonunun ürettiği büyümenin
 * basis'e yolu YOKTUR; `dailyRationKg` çıplak `number` kabul etmez. Böylece
 * sabah öğünü öğle öğününü, öğle akşamı büyütemez (bkz. `ration-basis.ts`).
 *
 * @module FeedingProtocol/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  FeedingProtocolAssignmentPausedEvent,
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
import {
  StockChangeReason,
  UnitRationRecalculator,
} from '../../batch/services/unit-ration-recalculator.port';
import { ProtocolRateService, tankBandWeightG } from './protocol-rate.service';
import { FeedTypeTransitionService } from './feed-transition.service';
import { repriceRemaining } from './meal-schedule.util';
import {
  dailyRationKg,
  dayPlanRationBasisKg,
  measuredRationBasisKg,
  shiftRationBasisKg,
  type RationBasisKg,
} from './ration-basis';

export type RecalcReason = RecalcLogEntry['reason'];

/**
 * WHY a recalculation is asked for — and, INSEPARABLY, what it does to the day's
 * ration basis. The two used to be independent (`reason` was a label, the basis
 * was always "whatever biomass currently says"), which is how the day's own feed
 * ended up re-pricing the day.
 *
 * The union makes the pairing structural:
 *  - a STOCK reason cannot be raised without the signed biomass that moved (the
 *    only thing allowed to shift the basis) — omitting it does not compile;
 *  - a weighing re-baselines the basis onto the measured biomass;
 *  - every other reason (growth application, temperature, protocol/assignment
 *    edits, unplanned feed, manual regenerate) reprices at the SAME basis: it
 *    can change the rate, never the biomass the rate applies to.
 */
export type RecalcTrigger =
  | { reason: StockChangeReason; stockBiomassDeltaKg: number }
  | { reason: 'temperature'; newTemperatureC: number | null }
  | {
      reason:
        | 'growth_sample'
        | 'meal_growth'
        | 'pour_correction'
        | 'protocol_change'
        | 'assignment_change'
        | 'unplanned_feed'
        | 'manual_regenerate'
        | 'grading';
    };

export interface RecalcResult {
  dayPlanId: string;
  outcome: 'repriced' | 'cancelled_empty_unit' | 'no_active_plan';
  transitioned: boolean;
  remainingPlannedKg: number;
  /** The biomass the day was priced from after this pass (audit + tests). */
  rationBasisKg: number;
}

@Injectable()
export class DayPlanRecalcService implements UnitRationRecalculator {
  private readonly logger = new Logger(DayPlanRecalcService.name);

  constructor(
    private readonly rateService: ProtocolRateService,
    private readonly transitionService: FeedTypeTransitionService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * `UnitRationRecalculator` port implementation — the settlement step of
   * `TankBatchService.applyStockChange`. Every stock path in the service reaches
   * the recalculation through here, so none of them can forget it.
   */
  async recalcAfterStockChange(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
    reason: StockChangeReason,
    stockBiomassDeltaKg: number,
  ): Promise<void> {
    await this.recalcForUnit(manager, tenantId, unitId, { reason, stockBiomassDeltaKg });
  }

  /**
   * Ünitenin AKTİF (planned/in_progress) en güncel planını yeniden hesaplar.
   * Çağıran transaction'ı sahiplenir; biyokütle yazımıyla AYNI tx'te koşar.
   */
  async recalcForUnit(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
    trigger: RecalcTrigger,
  ): Promise<RecalcResult | null> {
    const reason: RecalcReason = trigger.reason;
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
    // Band ağırlığı ÜNİTE aggregate'inden (alan kuralı: tank otoritedir).
    const avgWeightG = tankBandWeightG(
      tankBatch ?? { avgWeightG: 0, totalQuantity: 0, totalBiomassKg: 0 },
    );

    // Tayın tabanı: gün başındaki biyokütle + BU tetiklemenin taşıdığı gerçek
    // stok hareketi (ya da tartım re-baseline'ı). FCR büyümesi buraya giremez.
    const rationBasis = this.nextRationBasis(dayPlan, trigger, biomassKg);

    // Boş ünite: kalan öğünler iptal, plan kapanır, atama otomatik pause.
    if (fishCount <= 0 || biomassKg <= 0) {
      for (const meal of remainingMeals) {
        meal.status = FeedingMealStatus.CANCELLED;
        await manager.save(meal);
      }
      dayPlan.status = FeedingDayPlanStatus.CANCELLED;
      dayPlan.rationBasisKg = 0;
      this.appendRecalcLog(dayPlan, reason, 0, biomassKg, 0, 'unit emptied');
      await manager.save(dayPlan);
      await this.pauseAssignment(manager, tenantId, dayPlan.assignmentId, unitId);
      return {
        dayPlanId: dayPlan.id,
        outcome: 'cancelled_empty_unit',
        transitioned: false,
        remainingPlannedKg: 0,
        rationBasisKg: 0,
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
      return this.inertResult(dayPlan.id, rationBasis);
    }

    // Band çözümü + histerezisli geçiş kararı — 06:00 üreticisiyle PAYLAŞILAN
    // tek mekanizma (tek histerezis kuralı, tek atama-durumu yazarı, tek event).
    const decision = this.transitionService.decide({
      protocol,
      avgWeightG,
      state: {
        currentBandIndex: assignment.currentBandIndex ?? dayPlan.snapshot.bandIndex,
        currentFeedId: assignment.currentFeedId ?? dayPlan.snapshot.feed.id,
      },
    });
    if (!decision) {
      return this.inertResult(dayPlan.id, rationBasis);
    }
    if (decision.stateChange) {
      await this.transitionService.apply(manager, tenantId, assignment, {
        unitId,
        unitCode: dayPlan.unitCode,
        avgWeightG,
        change: decision.stateChange,
        automatic: true,
      });
    }
    const transitioned = decision.stateChange?.feedChanged ?? false;
    const effective = { band: decision.band, index: decision.index };

    // Yeni günlük toplam (K-18 zinciri) → kalan öğünler KENDİ yüzdeleriyle
    // yeniden fiyatlanır; sıcaklık gerekçesinde yeni okuma kullanılır.
    const temperatureC =
      trigger.reason === 'temperature' ? trigger.newTemperatureC : dayPlan.snapshot.waterTempC;
    const tempMultiplier = this.rateService.temperatureMultiplier(
      protocol.temperatureAdjustments,
      temperatureC,
    );
    const effectiveRate = this.rateService.effectiveRatePercent({
      baseRatePercent: effective.band.feedingRatePercent,
      temperatureMultiplier: tempMultiplier,
      rateAdjustmentPercent: assignment.overrides?.rateAdjustmentPercent,
      minRatePercent: protocol.settings.minFeedingRatePercent,
      maxRatePercent: protocol.settings.maxFeedingRatePercent,
    });
    // Tayın CANLI biyokütleden değil basis'ten hesaplanır: `dailyRationKg`
    // çıplak `number` almaz, dolayısıyla "şu anki biyokütleden yeniden fiyatla"
    // yazılamaz — gün-içi bileşik büyüme derlenmez.
    const newDailyTotalKg = dailyRationKg(rationBasis, effectiveRate);
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
    dayPlan.rationBasisKg = rationBasis;
    this.appendRecalcLog(dayPlan, reason, remainingPlannedKg, biomassKg, rationBasis);
    await manager.save(dayPlan);

    return {
      dayPlanId: dayPlan.id,
      outcome: 'repriced',
      transitioned,
      remainingPlannedKg,
      rationBasisKg: rationBasis,
    };
  }

  /**
   * The day's ration basis after this trigger.
   *
   * The switch is the ONE place a reason is classified, and it is exhaustive by
   * construction: a new stock reason must be added to `StockChangeReason`, which
   * makes the delta mandatory at every call site; anything else lands in the
   * default and reprices at the SAME basis. There is deliberately no case that
   * reads the live biomass for a growth application — that read is what made the
   * morning meal enlarge the noon meal.
   */
  private nextRationBasis(
    dayPlan: FeedingDayPlan,
    trigger: RecalcTrigger,
    currentBiomassKg: number,
  ): RationBasisKg {
    const current = dayPlanRationBasisKg(dayPlan);
    switch (trigger.reason) {
      case 'allocation':
      case 'mortality':
      case 'cull':
      case 'transfer':
      case 'harvest':
      case 'harvest_reversal':
      case 'count_reconcile':
        // Fish physically entered or left: the basis moves with the biomass they
        // carried, not with whatever the column happens to say now.
        return shiftRationBasisKg(current, trigger.stockBiomassDeltaKg);
      case 'growth_sample':
        // A weighing is evidence; it supersedes the model outright (P0-1).
        return measuredRationBasisKg(currentBiomassKg);
      default:
        return current;
    }
  }

  /** A plan that cannot be repriced (no assignment/protocol/band) keeps its basis. */
  private inertResult(dayPlanId: string, rationBasis: RationBasisKg): RecalcResult {
    return {
      dayPlanId,
      outcome: 'no_active_plan',
      transitioned: false,
      remainingPlannedKg: 0,
      rationBasisKg: rationBasis,
    };
  }

  private appendRecalcLog(
    dayPlan: FeedingDayPlan,
    reason: RecalcReason,
    remainingPlannedKg: number,
    biomassKg: number,
    rationBasisKg: number,
    note?: string,
  ): void {
    dayPlan.recalcLog = [
      ...(dayPlan.recalcLog ?? []),
      {
        at: new Date().toISOString(),
        reason,
        remainingPlannedKg: round3(remainingPlannedKg),
        biomassKg: round3(biomassKg),
        rationBasisKg: round3(rationBasisKg),
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

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
