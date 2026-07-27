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
  DayPlanSnapshot,
  FeedingDayPlan,
  FeedingDayPlanStatus,
} from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { ProtocolRateService } from './protocol-rate.service';
import { effectiveMealSchedule, materializeMeals, suspensionFor } from './meal-schedule.util';
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
  avgWeightG: number;
  /** D-2: tankta >1 üretim batch'i var (band dominant-biomass'tan seçilir). */
  mixedBatch?: boolean;
  /** D-2: batch'ler arası ağırlık dağılımının değişim katsayısı (%). */
  weightCvPercent?: number | null;
}

/**
 * D-2 (SAF, spec pinli): TankBatch.batchDetails SSoT'sinden karışık-tank
 * istatistiği — `mixedBatch` (balıklı üretim batch'i sayısı ≥ 2) + batch'ler
 * arası ortalama-ağırlık dağılımının adet-ağırlıklı değişim katsayısı (%).
 * Band politikası dominant-biomass batch'ten hesaplanır; bu istatistik o
 * varsayımı operatöre GÖRÜNÜR kılar (rozet + yüksek-CV uyarısı).
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
  constructor(private readonly rateService: ProtocolRateService) {}

  /**
   * Saf gün planı hesabı. `null` = plan üretilmez (boş ünite veya bandsız
   * protokol) — çağıran D-5 tespitini ayrıca yürütür.
   */
  computeDayPlan(input: ComputeDayPlanInput): ComputedDayPlan | null {
    const { stock, protocol, assignment, temperature } = input;
    if (stock.fishCount <= 0 || stock.biomassKg <= 0) return null;

    const resolved = this.rateService.bandFor(protocol.bands, stock.avgWeightG);
    if (!resolved) return null;
    const { band, index: bandIndex } = resolved;

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

    const plannedTotalKg = round3((stock.biomassKg * effectiveRate) / 100);

    // D-12: oruç penceresi günü atlar (otomatik devam); ilaç penceresi öğün
    // yemini medicatedFeedId ile değiştirir.
    const suspension = suspensionFor(assignment.suspensions, input.planDate);
    if (suspension?.type === 'fasting') {
      return {
        snapshot,
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

    return { snapshot, plannedTotalKg, status: FeedingDayPlanStatus.PLANNED, meals };
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
          "growthApplicationMode", "rollupAppliedKg", "rollupGrowthKg", version)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5,
               $6::feeding_protocol_assignments_unittype_enum, $7, $8, $9, $10::jsonb,
               $11, 0, $12, $13::feeding_day_plans_status_enum, $14, '[]'::jsonb,
               $15, 0, 0, 1)
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

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
