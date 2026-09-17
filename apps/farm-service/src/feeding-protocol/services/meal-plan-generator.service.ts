/**
 * MealPlanGeneratorService — ünite × gün planı üretimi (Faz 5, plan §2).
 *
 * `computeDayPlan` SAF çekirdektir (06:00 cron, dry-run [K-3] ve gün içi
 * regenerate aynı hesabı paylaşır); `persistDayPlan` unique
 * `(tenantId, unitId, planDate)` anahtarı üzerinden ON CONFLICT DO NOTHING ile
 * upsert-idempotenttir — çift üretim YAPISAL olarak imkânsız.
 *
 * Hesap zinciri (K-18): biomass × bandOranı × sıcaklıkÇarpanı ×
 * (1 + rateAdj/100), protokol min/max clamp'li. Sıcaklık kaynağı yoksa çarpan
 * 1.0 ve snapshot `usingDefaultTemperature=true` — sessiz varsayılan yok
 * (P-20). Biomass tabanı ÜRETİM biomass'ıdır (`totalBiomassKg`) — temizlikçi
 * balık yem tabanına GİRMEZ (D-13, spec pinli).
 *
 * YEM TİPİ GEÇİŞİ: band, ağırlıktan TEK BAŞINA seçilmez — `assignment`'ın
 * taşıdığı band hafızasıyla birlikte, gün-içi recalc'ın kullandığı AYNI
 * `FeedTypeTransitionService` üzerinden çözülür (histerezis dahil). Geçiş
 * etkisi `ComputedDayPlan.bandStateChange` ile taşınır ve YALNIZ plan gerçekten
 * yazıldığında (`persistDayPlan`'ın ON CONFLICT'i yeni satır ürettiğinde)
 * uygulanır — dry-run hiçbir şey yazmaz, çift üretim çift geçiş üretemez.
 *
 * @module FeedingProtocol/Services
 */
import { ConflictException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  FcrMatrix,
  FeedingProtocolV2,
} from '../entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../entities/protocol-assignment.entity';
import {
  DayPlanSnapshot,
  FeedingDayPlan,
  FeedingDayPlanStatus,
} from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { ProtocolRateService, type BandWeightG } from './protocol-rate.service';
import { BandStateChange, FeedTypeTransitionService } from './feed-transition.service';
import { dailyRationKg, initialRationBasisKg, type RationBasisKg } from './ration-basis';
import {
  effectiveMealSchedule,
  materializeMeals,
  suspensionFor,
} from './meal-schedule.util';
import type { EffectiveTemperature } from '../../water-quality/services/water-temperature.service';
import type { BatchDetail } from '../../batch/entities/tank-batch.entity';

// ============================================================================
// TYPES
// ============================================================================

export interface UnitStockState {
  /** Üretim balığı adedi (temizlikçi hariç — TankBatch.totalQuantity). */
  fishCount: number;
  /** Üretim biomass'ı kg (temizlikçi hariç — TankBatch.totalBiomassKg, D-13). */
  biomassKg: number;
  /** Ünite-otoriteli ortalama ağırlık — kurucuları `protocol-rate.service`'te. */
  avgWeightG: BandWeightG;
  /** D-2: tankta >1 üretim batch'i var. Bandı ETKİLEMEZ — yalnız rozet/uyarı. */
  mixedBatch?: boolean;
  /** D-2: batch'ler arası ağırlık dağılımının değişim katsayısı (%). */
  weightCvPercent?: number | null;
}

/**
 * D-2 (SAF, spec pinli): TankBatch.batchDetails SSoT'sinden karışık-tank
 * GÖRÜNÜRLÜK istatistiği — `mixedBatch` (balıklı üretim batch'i sayısı ≥ 2) +
 * batch'ler arası ortalama-ağırlık dağılımının adet-ağırlıklı değişim
 * katsayısı (%).
 *
 * NE YAPMAZ: batch SEÇMEZ. Bir batch'i "dominant" ilan edip bandı ondan
 * türetmez, `stock.avgWeightG`'yi değiştirmez, hesabın hiçbir adımına girmez.
 * Tek çıktısı `DayPlanSnapshot`'a düşen iki alandır (rozet + yüksek-CV uyarısı).
 *
 * NEDEN böyle doğru: balık STOKLAMADAN ÖNCE boy ayrımına tabi tutulur, bu
 * yüzden bir tank TEK boy sınıfı taşır — tek pelet, tek protokol. Band girdisi
 * bu yüzden tank geneli, adet-ağırlıklı ortalamadır (`stock.avgWeightG`,
 * BandWeightG): karışık tankın gerçek kohort ağırlığı odur. Bandı tek bir
 * batch'ten seçmek, tankın tamamını kendi bir örneklemine göre beslemek olurdu.
 * CV'nin işlevi bandı kaydırmak değil, boy ayrımının bozulduğunu (yüksek CV)
 * operatöre GÖRÜNÜR kılmaktır — karar insanındır, hesabın değil.
 */
export function mixedTankStats(
  batchDetails: ReadonlyArray<Pick<BatchDetail, 'quantity' | 'avgWeightG'>> | null | undefined,
): { mixedBatch: boolean; weightCvPercent: number | null } {
  const stocked = (batchDetails ?? []).filter((detail) => detail.quantity > 0);
  if (stocked.length < 2) return { mixedBatch: false, weightCvPercent: null };

  const totalCount = stocked.reduce((sum, detail) => sum + detail.quantity, 0);
  const meanWeight =
    stocked.reduce((sum, detail) => sum + detail.quantity * detail.avgWeightG, 0) / totalCount;
  if (meanWeight <= 0) return { mixedBatch: true, weightCvPercent: null };

  const variance =
    stocked.reduce(
      (sum, detail) => sum + detail.quantity * Math.pow(detail.avgWeightG - meanWeight, 2),
      0,
    ) / totalCount;
  return {
    mixedBatch: true,
    weightCvPercent: round3((Math.sqrt(variance) / meanWeight) * 100),
  };
}

export interface ComputeDayPlanInput {
  /**
   * `currentFeedId`/`currentBandIndex` ARE read: they are the unit's band
   * memory, and the plan's feed follows the shared transition mechanism instead
   * of the naked weight (that omission is what let an overnight band crossing
   * change the morning feed while the assignment still named yesterday's).
   */
  assignment: Pick<
    ProtocolAssignment,
    'overrides' | 'suspensions' | 'currentFeedId' | 'currentBandIndex'
  >;
  protocol: Pick<
    FeedingProtocolV2,
    'bands' | 'defaultMealSchedule' | 'temperatureAdjustments' | 'fcrMatrix' | 'settings'
  >;
  stock: UnitStockState;
  temperature: EffectiveTemperature;
  /** Site saat dilimindeki takvim günü (YYYY-MM-DD, D-4). */
  planDate: string;
  /** Sitenin IANA saat dilimi (sites.timezone). */
  timezone: string;
  /** fcrSource=feed için bandın yem ürününün FCR matrisi (çağıran sağlar). */
  feedFcrMatrixByFeedId?: Map<string, FcrMatrix>;
}

export interface ComputedMeal {
  mealIndex: number;
  scheduledAt: Date;
  percentOfDaily: number;
  plannedKg: number;
  feedId: string;
}

export interface ComputedDayPlan {
  snapshot: DayPlanSnapshot;
  plannedTotalKg: number;
  /** Bu planın fiyatlandığı taban — gün başındaki üretim biyokütlesi. */
  rationBasisKg: RationBasisKg;
  status: FeedingDayPlanStatus.PLANNED | FeedingDayPlanStatus.SKIPPED;
  skipReason?: string;
  meals: ComputedMeal[];
  /**
   * Atamanın band hafızasına yazılması gereken değişiklik (varsa) — `persistDayPlan`
   * planı GERÇEKTEN yazdıysa uygular. Dry-run yalnız okur.
   */
  bandStateChange: BandStateChange | null;
}

export interface PersistDayPlanContext {
  tenantId: string;
  assignmentId: string;
  protocolId: string;
  unitId: string;
  siteId: string;
  unitType: ProtocolAssignment['unitType'];
  unitName: string;
  unitCode: string;
  planDate: string;
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class MealPlanGeneratorService {
  constructor(
    private readonly rateService: ProtocolRateService,
    private readonly transitionService: FeedTypeTransitionService,
  ) {}

  /**
   * Saf gün planı hesabı. `null` = plan üretilmez (boş ünite veya bandsız
   * protokol) — çağıran D-5 tespitini ayrıca yürütür.
   */
  computeDayPlan(input: ComputeDayPlanInput): ComputedDayPlan | null {
    const { stock, protocol, assignment, temperature } = input;
    if (stock.fishCount <= 0 || stock.biomassKg <= 0) return null;

    // Band, ağırlık + atamanın band hafızasından birlikte çözülür (histerezis
    // dahil): gün-içi recalc ile AYNI karar fonksiyonu, tek geçiş mekanizması.
    const decision = this.transitionService.decide({
      protocol,
      avgWeightG: stock.avgWeightG,
      state: {
        currentBandIndex: assignment.currentBandIndex,
        currentFeedId: assignment.currentFeedId,
      },
    });
    if (!decision) return null;
    const { band, index: bandIndex } = decision;

    const tempMultiplier = this.rateService.temperatureMultiplier(
      protocol.temperatureAdjustments,
      temperature.celsius,
    );
    const effectiveRate = this.rateService.effectiveRatePercent({
      baseRatePercent: band.feedingRatePercent,
      temperatureMultiplier: tempMultiplier,
      rateAdjustmentPercent: assignment.overrides?.rateAdjustmentPercent,
      minRatePercent: protocol.settings.minFeedingRatePercent,
      maxRatePercent: protocol.settings.maxFeedingRatePercent,
    });
    const expectedFcr = this.rateService.resolveExpectedFcr({
      band,
      fcrSource: protocol.settings.fcrSource,
      avgWeightG: stock.avgWeightG,
      temperatureC: temperature.celsius,
      protocolFcrMatrix: protocol.fcrMatrix,
      feedFcrMatrix: input.feedFcrMatrixByFeedId?.get(band.feedId),
      fcrOverrides: assignment.overrides?.fcrOverrides,
    });

    const snapshot: DayPlanSnapshot = {
      avgWeightG: round3(stock.avgWeightG),
      fishCount: stock.fishCount,
      biomassKg: round3(stock.biomassKg),
      waterTempC: temperature.celsius,
      temperatureSource: temperature.source,
      usingDefaultTemperature: temperature.source === 'none',
      bandIndex,
      feed: { id: band.feedId, code: band.feedCode, name: band.feedName },
      baseRatePercent: band.feedingRatePercent,
      tempMultiplier,
      effectiveRatePercent: round3(effectiveRate),
      expectedFcr: expectedFcr.value,
      fcrResolvedSource: expectedFcr.source,
      mixedBatch: stock.mixedBatch ?? false,
      weightCvPercent: stock.weightCvPercent ?? null,
    };

    // Günün tabanı: gün başındaki üretim biyokütlesi. Aynı gün içindeki her
    // yeniden fiyatlama bu tabandan yürür (bkz. `ration-basis.ts`).
    const rationBasisKg = initialRationBasisKg(stock.biomassKg);
    const plannedTotalKg = dailyRationKg(rationBasisKg, effectiveRate);

    // D-12: oruç penceresi günü atlar (otomatik devam); ilaç penceresi öğün
    // yemini medicatedFeedId ile değiştirir.
    const suspension = suspensionFor(assignment.suspensions, input.planDate);
    if (suspension?.type === 'fasting') {
      return {
        snapshot,
        plannedTotalKg: 0,
        rationBasisKg,
        status: FeedingDayPlanStatus.SKIPPED,
        skipReason: `fasting: ${suspension.reason}`,
        meals: [],
        // Oruç günü de bandı ilerletir: balık sınırı geçtiyse atamanın hafızası
        // güncellenir, yoksa ertesi gün bayat durumdan plan üretilirdi.
        bandStateChange: decision.stateChange,
      };
    }
    const mealFeedId =
      suspension?.type === 'medication' && suspension.medicatedFeedId
        ? suspension.medicatedFeedId
        : band.feedId;

    const schedule = effectiveMealSchedule(
      protocol.defaultMealSchedule,
      band,
      assignment.overrides,
    );
    const meals = materializeMeals(
      schedule,
      input.planDate,
      input.timezone,
      assignment.overrides?.mealTimeOffsetMinutes,
    ).map((meal) => ({
      ...meal,
      plannedKg: round3((plannedTotalKg * meal.percentOfDaily) / 100),
      feedId: mealFeedId,
    }));

    return {
      snapshot,
      plannedTotalKg,
      rationBasisKg,
      status: FeedingDayPlanStatus.PLANNED,
      meals,
      bandStateChange: decision.stateChange,
    };
  }

  /**
   * Idempotent persist: gün planı zaten varsa (unique anahtar) HİÇBİR ŞEY
   * yazılmaz ve `null` döner; yenisi yazıldıysa day plan id'si döner.
   *
   * Yem geçişi de BURADA uygulanır: plan satırı gerçekten üretildiyse (yani bu
   * koşum günün planını yazan koşumsa) atamanın band durumu güncellenir ve
   * gerekiyorsa `FeedTypeTransitioned` yazılır. Aynı gün ikinci kez koşan cron
   * ON CONFLICT'e takılır, `null` döner ve geçişi TEKRAR uygulamaz — çift event
   * mevcut idempotency anahtarının altında yapısal olarak imkânsızdır.
   */
  async persistDayPlan(
    manager: EntityManager,
    context: PersistDayPlanContext,
    computed: ComputedDayPlan,
  ): Promise<string | null> {
    const inserted: Array<{ id: string }> = await manager.query(
      `INSERT INTO "feeding_day_plans"
         (id, "tenantId", "assignmentId", "protocolId", "unitId", "siteId", "unitType",
          "unitName", "unitCode", "planDate", snapshot, "plannedTotalKg", "rationBasisKg",
          "unplannedActualKg", "mealsPlanned", status, "skipReason", "recalcLog", version)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5,
               $6::feeding_protocol_assignments_unittype_enum, $7, $8, $9, $10::jsonb,
               $11, $12, 0, $13, $14::feeding_day_plans_status_enum, $15, '[]'::jsonb, 1)
       ON CONFLICT ("tenantId", "unitId", "planDate") DO NOTHING
       RETURNING id`,
      [
        context.tenantId,
        context.assignmentId,
        context.protocolId,
        context.unitId,
        context.siteId,
        context.unitType,
        context.unitName,
        context.unitCode,
        context.planDate,
        JSON.stringify(computed.snapshot),
        computed.plannedTotalKg,
        computed.rationBasisKg,
        computed.meals.length,
        computed.status,
        computed.skipReason ?? null,
      ],
    );
    const dayPlanId = inserted[0]?.id;
    if (!dayPlanId) return null;

    for (const meal of computed.meals) {
      await manager.insert(FeedingMeal, {
        tenantId: context.tenantId,
        dayPlanId,
        unitId: context.unitId,
        siteId: context.siteId,
        mealIndex: meal.mealIndex,
        scheduledAt: meal.scheduledAt,
        percentOfDaily: meal.percentOfDaily,
        plannedKg: meal.plannedKg,
        status: FeedingMealStatus.SCHEDULED,
        actualKg: 0,
        pours: [],
        feedId: meal.feedId,
      });
    }

    if (computed.bandStateChange) {
      // Kanonik kilit sırası (K-1): DayPlan → Meals → Assignment — atama EN SON
      // ve taze okunur (sayfa okumasındaki bayat kopya değil).
      const assignment = await manager.findOne(ProtocolAssignment, {
        where: { id: context.assignmentId, tenantId: context.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!assignment) {
        // Aynı transaction'da okunup plan yazılan atamanın kaybolması tutarsız
        // bir durumdur; sessizce geçmek atamayı bayat band durumuyla bırakırdı.
        throw new ConflictException(
          `Ünitenin ataması (${context.assignmentId}) plan yazımı sırasında bulunamadı — geçiş uygulanamadı`,
        );
      }
      await this.transitionService.apply(manager, context.tenantId, assignment, {
        unitId: context.unitId,
        unitCode: context.unitCode,
        avgWeightG: computed.snapshot.avgWeightG,
        change: computed.bandStateChange,
        automatic: true,
      });
    }
    return dayPlanId;
  }

  /** Var olan planı okuma (regenerate/dry-run karşılaştırmaları için). */
  async findDayPlan(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
    planDate: string,
  ): Promise<FeedingDayPlan | null> {
    return manager.findOne(FeedingDayPlan, { where: { tenantId, unitId, planDate } });
  }
}

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
