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
 * @module FeedingProtocol/Services
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  FcrMatrix,
  FeedingProtocolV2,
  GrowthApplicationMode,
} from '../entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../entities/protocol-assignment.entity';
import {
  DayPlanResolution,
  DayPlanSnapshot,
  FeedingDayPlan,
  FeedingDayPlanStatus,
} from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { ProtocolRateService } from './protocol-rate.service';
import {
  ProtocolResolutionService,
  type ProtocolResolutionResult,
} from './protocol-resolution.service';
import { effectiveMealSchedule, materializeMeals, suspensionFor } from './meal-schedule.util';
import type { EffectiveTemperature } from '../../water-quality/services/water-temperature.service';
import type { BatchDetail } from '../../batch/entities/tank-batch.entity';
import { round3 } from '../../common/utils/rounding.util';

// ============================================================================
// TYPES
// ============================================================================

export interface UnitStockState {
  /** Üretim balığı adedi (temizlikçi hariç — TankBatch.totalQuantity). */
  fishCount: number;
  /** Üretim biomass'ı kg (temizlikçi hariç — TankBatch.totalBiomassKg, D-13). */
  biomassKg: number;
  avgWeightG: number;
  /** D-2: tankta >1 üretim batch'i var (band TANK ORTALAMASINDAN seçilir). */
  mixedBatch?: boolean;
  /** D-2: batch'ler arası ağırlık dağılımının değişim katsayısı (%). */
  weightCvPercent?: number | null;
}

/**
 * D-2 (SAF, spec pinli): TankBatch.batchDetails SSoT'sinden karışık-tank
 * istatistiği — `mixedBatch` (balıklı üretim batch'i sayısı ≥ 2) + batch'ler
 * arası ortalama-ağırlık dağılımının adet-ağırlıklı değişim katsayısı (%).
 * Band TANK ORTALAMASINDAN seçilir (karar: rasyon zaten tüm tank
 * biyokütlesine uygulanır); bu istatistik karışık tankta o ortalamanın ne
 * kadar temsil ettiğini operatöre GÖRÜNÜR kılar — yüksek CV, tek ortalamanın
 * iki popülasyonu da doğru beslemediğinin işaretidir (FARM-LOW-263).
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
  assignment: Pick<ProtocolAssignment, 'overrides' | 'suspensions' | 'currentFeedId'>;
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
  /** Canlı protokol çözümü — plana ayrı kolonda yazılır (W3). */
  resolution: DayPlanResolution;
  plannedTotalKg: number;
  status: FeedingDayPlanStatus.PLANNED | FeedingDayPlanStatus.SKIPPED;
  skipReason?: string;
  meals: ComputedMeal[];
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
  /**
   * Üretim anındaki büyüme modu — plana DONDURULUR (FARM-CRITICAL-244).
   * Protokol ayarı sonradan değişse bile bu plan üretildiği semantikle
   * rollup'lanır.
   */
  growthApplicationMode: GrowthApplicationMode;
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class MealPlanGeneratorService {
  constructor(
    private readonly rateService: ProtocolRateService,
    private readonly resolutionService: ProtocolResolutionService,
  ) {}

  /**
   * Saf gün planı hesabı. `null` = plan üretilmez (boş ünite veya bandsız
   * protokol) — çağıran D-5 tespitini ayrıca yürütür.
   */
  computeDayPlan(input: ComputeDayPlanInput): ComputedDayPlan | null {
    const { stock, protocol, assignment, temperature } = input;
    if (stock.fishCount <= 0 || stock.biomassKg <= 0) return null;

    // Band/oran/FCR çözümü TEK yerden (W3): üretim, gün-içi recalc ve manuel
    // geçiş aynı fonksiyonu paylaşır — `autoTransition=false` burada da
    // onurlandırılır (eskiden üretim bu ayarı hiç okumuyordu, FARM-LOW-262).
    const resolution = this.resolutionService.resolve({
      protocol,
      assignment,
      bandBasisWeightG: this.resolutionService.resolveBandBasisWeight({
        avgWeightG: stock.avgWeightG,
      }),
      temperature,
      feedFcrMatrix: undefined,
    });
    if (!resolution) return null;
    const band = resolution.band;
    // fcrSource=feed matrisi bandın yemine bağlıdır; band çözüldükten sonra
    // biliniyor, bu yüzden FCR ikinci geçişte kesinleşir.
    const feedMatrix = input.feedFcrMatrixByFeedId?.get(band.feedId);
    const finalResolution = feedMatrix
      ? (this.resolutionService.resolve({
          protocol,
          assignment,
          bandBasisWeightG: resolution.bandBasisWeightG,
          temperature,
          feedFcrMatrix: feedMatrix,
        }) ?? resolution)
      : resolution;

    const snapshot: DayPlanSnapshot = {
      avgWeightG: round3(stock.avgWeightG),
      fishCount: stock.fishCount,
      biomassKg: round3(stock.biomassKg),
      waterTempC: temperature.celsius,
      temperatureSource: temperature.source,
      usingDefaultTemperature: temperature.source === 'none',
      bandIndex: finalResolution.bandIndex,
      feed: finalResolution.feed,
      baseRatePercent: finalResolution.baseRatePercent,
      tempMultiplier: finalResolution.tempMultiplier,
      effectiveRatePercent: finalResolution.effectiveRatePercent,
      expectedFcr: finalResolution.expectedFcr,
      fcrResolvedSource: finalResolution.fcrResolvedSource,
      mixedBatch: stock.mixedBatch ?? false,
      weightCvPercent: stock.weightCvPercent ?? null,
    };

    const plannedTotalKg = round3((stock.biomassKg * finalResolution.effectiveRatePercent) / 100);

    // D-12: oruç penceresi günü atlar (otomatik devam); ilaç penceresi öğün
    // yemini medicatedFeedId ile değiştirir.
    const suspension = suspensionFor(assignment.suspensions, input.planDate, input.timezone);
    if (suspension?.type === 'fasting') {
      return {
        snapshot,
        resolution: toStoredResolution(finalResolution),
        plannedTotalKg: 0,
        status: FeedingDayPlanStatus.SKIPPED,
        skipReason: `fasting: ${suspension.reason}`,
        meals: [],
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
      resolution: toStoredResolution(finalResolution),
      plannedTotalKg,
      status: FeedingDayPlanStatus.PLANNED,
      meals,
    };
  }

  /**
   * Idempotent persist: gün planı zaten varsa (unique anahtar) HİÇBİR ŞEY
   * yazılmaz ve `null` döner; yenisi yazıldıysa day plan id'si döner.
   */
  async persistDayPlan(
    manager: EntityManager,
    context: PersistDayPlanContext,
    computed: ComputedDayPlan,
  ): Promise<string | null> {
    const inserted: Array<{ id: string }> = await manager.query(
      // `growthApplicationMode` ÜRETİM ANINDA dondurulur (FARM-CRITICAL-244):
      // rollup planın kendi semantiğini okur, protokolün sonradan değişen
      // ayarını değil — geçmiş büyüme ne çift sayılabilir ne kaybolabilir.
      `INSERT INTO "feeding_day_plans"
         (id, "tenantId", "assignmentId", "protocolId", "unitId", "siteId", "unitType",
          "unitName", "unitCode", "planDate", snapshot, "plannedTotalKg",
          "unplannedActualKg", "mealsPlanned", status, "skipReason", "recalcLog",
          "growthApplicationMode", "rollupAppliedKg", "rollupGrowthKg", resolution, version)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5,
               $6::feeding_protocol_assignments_unittype_enum, $7, $8, $9, $10::jsonb,
               $11, 0, $12, $13::feeding_day_plans_status_enum, $14, '[]'::jsonb,
               $15, 0, 0, $16::jsonb, 1)
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
        computed.meals.length,
        computed.status,
        computed.skipReason ?? null,
        context.growthApplicationMode,
        JSON.stringify(computed.resolution),
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

/** Çözümün SAKLANAN alt kümesi (band nesnesi ve geçiş bayrakları telde/DB'de yok). */
function toStoredResolution(result: ProtocolResolutionResult): DayPlanResolution {
  const { band: _band, bandChanged: _changed, previousBandIndex: _prev, ...stored } = result;
  return stored;
}
