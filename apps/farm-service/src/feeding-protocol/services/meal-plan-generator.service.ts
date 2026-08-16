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
import type {
  MutationInstantV1,
  TenantMutationSession,
} from '@aquaculture/backend-common/database';
import type { FeedingTimezone } from '@aquaculture/feeding-contracts';

import { round3 } from '../../common/utils/rounding.util';
import { EntityManager } from 'typeorm';

import { FcrMatrix, FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../entities/protocol-assignment.entity';
import {
  DayPlanSnapshot,
  DayPlanResolutionV1,
  FeedingDayPlan,
  FeedingDayPlanStatus,
} from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { effectiveMealSchedule, materializeMeals, suspensionFor } from './meal-schedule.util';
import type { EffectiveTemperature } from '../../water-quality/services/water-temperature.service';
import type { BatchDetail } from '../../batch/entities/tank-batch.entity';
import { FeedingAggregateMutationPort } from '../feeding-aggregate-mutation.writer';
import {
  freezeDayPlanGrowthPolicyV1,
  type FrozenDayPlanGrowthPolicyV1,
} from '../day-plan-growth-reconciliation.authority';
import {
  projectDayPlanResolutionV1,
  ProtocolResolutionAuthority,
} from './protocol-resolution.authority';

// ============================================================================
// TYPES
// ============================================================================

export interface UnitStockState {
  /** Üretim balığı adedi (temizlikçi hariç — TankBatch.totalQuantity). */
  fishCount: number;
  /** Üretim biomass'ı kg (temizlikçi hariç — TankBatch.totalBiomassKg, D-13). */
  biomassKg: number;
  avgWeightG: number;
  /** D-2: tankta birden fazla stoklu üretim batch'i bulunduğunu gösterir. */
  mixedBatch?: boolean;
  /** D-2: batch'ler arası ağırlık dağılımının değişim katsayısı (%). */
  weightCvPercent?: number | null;
}

/**
 * D-2 (SAF, spec pinli): TankBatch.batchDetails SSoT'sinden karışık-tank
 * istatistiği — `mixedBatch` (balıklı üretim batch'i sayısı ≥ 2) + batch'ler
 * arası ortalama-ağırlık dağılımının adet-ağırlıklı değişim katsayısı (%).
 * Band politikası tankın adet-ağırlıklı ortalama ağırlığından hesaplanır; bu
 * istatistik heterojenliği operatöre görünür kılar (rozet + yüksek-CV uyarısı).
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
  timezone: FeedingTimezone;
  /** The sole durable mutation/evidence clock for this calculation. */
  mutationInstant: MutationInstantV1;
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
  growthPolicy: FrozenDayPlanGrowthPolicyV1;
  snapshot: DayPlanSnapshot;
  resolution: DayPlanResolutionV1;
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
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class MealPlanGeneratorService {
  constructor(
    private readonly feedingMutations: FeedingAggregateMutationPort,
    private readonly resolutionAuthority: ProtocolResolutionAuthority,
  ) {}

  /**
   * Saf gün planı hesabı. `null` = plan üretilmez (boş ünite veya bandsız
   * protokol) — çağıran D-5 tespitini ayrıca yürütür.
   */
  computeDayPlan(input: ComputeDayPlanInput): ComputedDayPlan | null {
    const { stock, protocol, assignment, temperature } = input;
    if (stock.fishCount <= 0 || stock.biomassKg <= 0) return null;

    const resolved = this.resolutionAuthority.resolve({
      protocol,
      assignment,
      bandBasisWeightG: this.resolutionAuthority.resolveBandBasisWeight({
        avgWeightG: stock.avgWeightG,
      }),
      temperature,
      feedFcrMatrixByFeedId: input.feedFcrMatrixByFeedId,
      mutationInstant: input.mutationInstant,
    });
    if (!resolved) return null;
    const { band, bandIndex, tempMultiplier, effectiveRatePercent, expectedFcr } = resolved;
    const resolution = projectDayPlanResolutionV1(resolved);

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
      effectiveRatePercent,
      expectedFcr,
      fcrResolvedSource: resolved.fcrResolvedSource,
      mixedBatch: stock.mixedBatch ?? false,
      weightCvPercent: stock.weightCvPercent ?? null,
    };

    const plannedTotalKg = round3((stock.biomassKg * effectiveRatePercent) / 100);
    const growthPolicy = freezeDayPlanGrowthPolicyV1(protocol.settings.growthApplicationMode);

    // D-12: oruç penceresi günü atlar (otomatik devam); ilaç penceresi öğün
    // yemini medicatedFeedId ile değiştirir.
    const suspension = suspensionFor(assignment.suspensions, input.planDate);
    if (suspension?.type === 'fasting') {
      return {
        growthPolicy,
        snapshot,
        resolution,
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
      growthPolicy,
      snapshot,
      resolution,
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
    mutationSession: TenantMutationSession,
    context: PersistDayPlanContext,
    computed: ComputedDayPlan,
  ): Promise<string | null> {
    const dayPlanId = await this.feedingMutations.createDayPlanIfAbsent(mutationSession, {
      assignmentId: context.assignmentId,
      protocolId: context.protocolId,
      unitId: context.unitId,
      siteId: context.siteId,
      unitType: context.unitType,
      unitName: context.unitName,
      unitCode: context.unitCode,
      planDate: context.planDate,
      growthPolicyVersion: computed.growthPolicy.version,
      growthApplicationMode: computed.growthPolicy.applicationMode,
      snapshot: computed.snapshot,
      resolution: computed.resolution,
      plannedTotalKg: computed.plannedTotalKg,
      mealsPlanned: computed.meals.length,
      status: computed.status,
      skipReason: computed.skipReason,
    });
    if (!dayPlanId) return null;

    for (const meal of computed.meals) {
      await this.feedingMutations.createScheduledMeal(mutationSession, {
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
