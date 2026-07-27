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
  UnfedUnitDetectedEvent,
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
import { distributeCatchUp, repriceRemaining } from './meal-schedule.util';
import { round3 } from './rounding.util';

export type RecalcReason = RecalcLogEntry['reason'];

export interface RecalcResult {
  dayPlanId: string;
  outcome:
    | 'repriced'
    | 'cancelled_empty_unit'
    | 'no_active_plan'
    /** Balık var ama biyokütle 0 — plan iptal EDİLMEZ (FARM-HIGH-246). */
    | 'biomass_inconsistent';
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
   * Birden çok üniteyi TEK çağrıda, unitId'ye göre SIRALI olarak yeniden
   * hesaplar (FARM-MEDIUM-275).
   *
   * Transfer iki ünitenin gün planını da değiştirir ve eski hâl kilitleri
   * PAYLOAD sırasıyla alıyordu: karşılıklı T1→T2 / T2→T1 transferleri yeni
   * bir AB-BA penceresi açıyordu. Sıralamayı çağırana bırakmak yerine servis
   * garanti eder — çağıran unutamaz (tier-2).
   */
  async recalcForUnits(
    manager: EntityManager,
    tenantId: string,
    unitIds: string[],
    reason: RecalcReason,
    opts?: { newTemperatureC?: number | null },
  ): Promise<Array<RecalcResult | null>> {
    const ordered = [...new Set(unitIds)].sort();
    const results: Array<RecalcResult | null> = [];
    for (const unitId of ordered) {
      results.push(await this.recalcForUnit(manager, tenantId, unitId, reason, opts));
    }
    return results;
  }

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

    // Biyokütle 0 ama balık VAR: bu bir veri tutarsızlığıdır, boş ünite
    // DEĞİL (FARM-HIGH-246). Aşırı beyan edilen bir kg girişi biyokütleyi
    // 0'a clamp'lediğinde, içinde 500 canlı balık olan tank "boşalmış"
    // sayılıp planı iptal ediliyor, ataması PAUSED'a çekiliyor ve D-5
    // süpürmesi yalnız aktif atamalara baktığı için ALARM DA üretmiyordu —
    // tank biri elle fark edene kadar aç kalıyordu.
    if (fishCount > 0 && biomassKg <= 0) {
      this.logger.error(
        `Data integrity: unit ${unitId} has ${fishCount} fish but ${biomassKg}kg biomass — ` +
          'day plan left ACTIVE (an over-declared removal is the usual cause).',
      );
      this.appendRecalcLog(
        dayPlan,
        reason,
        Number(dayPlan.plannedTotalKg),
        biomassKg,
        'biomass_inconsistent: fish present with zero biomass',
      );
      await manager.save(dayPlan);
      // Planı ayakta bırakmak yetmez: oran biyokütleden hesaplandığı için
      // öğünler 0 kg'a fiyatlanır ve tank yine aç kalır. Tutarsızlık ALARMA
      // taşınır — operatör düzeltene kadar görünür (D-5 ailesi).
      const inconsistent: UnfedUnitDetectedEvent = {
        ...createBaseEvent<UnfedUnitDetectedEvent>('UnfedUnitDetected', tenantId, {
          aggregateId: unitId,
          aggregateType: 'FeedingUnit',
        }),
        unitId,
        unitCode: dayPlan.unitCode,
        siteId: dayPlan.siteId,
        reason: 'biomass_inconsistent',
        fishCount,
        biomassKg: 0,
      };
      await this.outboxPublisher.enqueue(inconsistent, manager);
      return {
        dayPlanId: dayPlan.id,
        outcome: 'biomass_inconsistent',
        transitioned: false,
        remainingPlannedKg: Number(dayPlan.plannedTotalKg),
      };
    }

    // Boş ünite: kalan öğünler iptal, plan kapanır, atama otomatik pause.
    if (fishCount <= 0) {
      for (const meal of remainingMeals) {
        meal.status = FeedingMealStatus.CANCELLED;
        await manager.save(meal);
      }
      dayPlan.status = FeedingDayPlanStatus.CANCELLED;
      // `plannedTotalKg` iptal edilen öğünlerin kg'ını taşımaya DEVAM
      // edemez (FARM-MEDIUM-251/M-7c): gün özeti planlanan-vs-gerçekleşen
      // varyansını bu alandan hesaplıyor ve tam hasat edilen tank her akşam
      // "%100 az beslendi" diye raporlanıyordu. Plan artık yalnız GERÇEKTEN
      // kapanmış öğünlerin planını taşır.
      dayPlan.plannedTotalKg = round3(await this.settledPlannedKg(manager, dayPlan.id));
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
    const settledPlannedKg = await this.settledPlannedKg(manager, dayPlan.id);
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

  /**
   * Kapanmış öğünlerin planlanan kg toplamı. `cancelled` öğünler HARİÇ:
   * iptal edilen öğün için plan yapılmış sayılmaz, aksi hâlde gün varyansı
   * hiç servis edilmeyecek kg'ı "eksik atıldı" diye raporlar.
   */
  private async settledPlannedKg(manager: EntityManager, dayPlanId: string): Promise<number> {
    const settled = await manager
      .createQueryBuilder(FeedingMeal, 'meal')
      .where('meal.dayPlanId = :dayPlanId', { dayPlanId })
      .andWhere('meal.status NOT IN (:...open)', {
        open: [FeedingMealStatus.SCHEDULED, FeedingMealStatus.CANCELLED],
      })
      .getMany();
    return settled.reduce((acc, meal) => acc + Number(meal.plannedKg), 0);
  }

  /**
   * Kaçırılan/atlanan öğünün telafisi (W5, kullanıcı kararı 3).
   *
   * **Varsayılan davranış: HİÇBİR ŞEY YAPMAMAK.** Telafi yüzdesi tanımlı
   * değilse (protokol ayarı ve atama override'ı boşsa) kalan öğünlerin
   * `plannedKg`'ı değişmez — kaçan öğünün kg'ı gün toplamından düşer ve
   * varyans olarak görünür. Tenant açıkça yüzde tanımladıysa kaçan kg'ın o
   * kadarı kalan öğünlere KENDİ yüzdeleri oranında eklenir.
   *
   * Çağıran, öğünü `missed`/`skipped` damgaladıktan SONRA ve aynı
   * transaction'da çağırır (kilitler zaten elde: DayPlan → Meals).
   */
  async applyMissedCatchUp(
    manager: EntityManager,
    tenantId: string,
    dayPlan: FeedingDayPlan,
    missedKg: number,
  ): Promise<number> {
    if (!(missedKg > 0)) return 0;

    const assignment = await manager.findOne(ProtocolAssignment, {
      where: { id: dayPlan.assignmentId, tenantId },
    });
    const protocol = await manager.findOne(FeedingProtocolV2, {
      where: { id: dayPlan.protocolId, tenantId },
    });
    const percent =
      assignment?.overrides?.missedMealCatchUpPercent ??
      protocol?.settings.missedMealCatchUpPercent ??
      0;
    if (!(percent > 0)) return 0;

    const remaining = await manager
      .createQueryBuilder(FeedingMeal, 'meal')
      .setLock('pessimistic_write')
      .where('meal.dayPlanId = :dayPlanId', { dayPlanId: dayPlan.id })
      .andWhere('meal.tenantId = :tenantId', { tenantId })
      .andWhere('meal.status = :status', { status: FeedingMealStatus.SCHEDULED })
      .orderBy('meal.mealIndex', 'ASC')
      .getMany();
    if (remaining.length === 0) return 0;

    const additions = distributeCatchUp(missedKg, percent, remaining);
    let addedKg = 0;
    const now = new Date();
    for (const [index, meal] of remaining.entries()) {
      const add = additions[index] ?? 0;
      if (add <= 0) continue;
      meal.plannedKg = round3(Number(meal.plannedKg) + add);
      meal.recalculatedAt = now;
      addedKg += add;
      await manager.save(meal);
    }
    if (addedKg <= 0) return 0;

    dayPlan.plannedTotalKg = round3(Number(dayPlan.plannedTotalKg) + addedKg);
    this.appendRecalcLog(
      dayPlan,
      'missed_catchup',
      remaining.reduce((acc, meal) => acc + Number(meal.plannedKg), 0),
      Number(dayPlan.snapshot.biomassKg ?? 0),
      `catch-up ${percent}% of ${round3(missedKg)}kg redistributed`,
    );
    await manager.save(dayPlan);
    return round3(addedKg);
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
