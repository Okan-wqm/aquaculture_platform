/**
 * ScheduledFeedingOperationExecutor — catalog job'larının domain executor'ı.
 *
 * | 05:30 | DAILY growth rollup + dünkü beslenmemiş öğünler `missed` (+event) +
 * |       | bayat partially_fed öğünlerin otomatik finalize'ı (D-8) — per_meal |
 * |       | modda büyüme finalize'da uygulanır (FARM-MEDIUM-227), daily mod    |
 * |       | rollup'ta; ünite gruplu, kanonik kilit sırası (K-1)                |
 * | 06:00 | Tüm aktif atamalar için day plan + öğün üretimi (idempotent) +    |
 * |       | plansız-ünite tespiti — UnfedUnitDetected (D-5, sessiz aç kalma   |
 * |       | imkânsız)                                                         |
 * | 15dk  | MealWindowUpcoming — (tenant, tick) başına TOPLU (K-2, 500 cap +  |
 * |       | devam event'leri); `windowNotifiedAt` idempotent                  |
 * | 18:00 | FCR alert süpürmesi — İLK durable FCRAlert emisyonu (C-1); hedef  |
 * |       | P-14 zincirinden, eşikler legacy analyzeFCR ile birebir           |
 * | 18:00 | D+1'de önceki yerel günün grace-kapanmış FeedingDailySummary +    |
 * | D+1   | MealUnderfed(scope=day); açık gün asla özetlenmez (D-16)          |
 * | Aylık | Retention: day plan + öğün 24 ay (K-16), mobil komut makbuzları  |
 * |       | 90 gün (NFR "Receipt büyümesi")                                   |
 *
 * Ölçek disiplini (NFR): tenant'lar sıralı; tenant içinde 200'lük atama
 * sayfaları; sayfa başına SABİT sayıda toplu okuma (protokoller IN, TankBatch
 * IN, sıcaklıklar toplu, fcrSource=feed yem matrisleri IN, site
 * timezone'ları) — ünite başına sorgu SIFIR.
 * Advisory-lock deseni v1 makinesiyle birebir (session-scoped kilit, edinen
 * bağlantıda tutulur/bırakılır); v1 06:00 üretimi cutover'a (Faz 6) kadar
 * yaşamaya devam eder — v2 yalnız v2 ataması olan ünitelerde koşar, çift
 * planlama prod'da imkânsız (K-3: migrate atamalar paused).
 *
 * @module FeedingProtocol/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  readTenantMutationInstantV1,
  runInTenantTransaction,
  type MutationInstantV1,
} from '@aquaculture/backend-common/database';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import {
  FEEDING_SCHEDULE_EXECUTION_POLICY_V1,
  feedingDailySummaryPlanDate,
  feedingJobDefinition,
  feedingMealOverdueCutoff,
  type FeedingTimezone,
} from '@aquaculture/feeding-contracts';
import { OutboxPublisher } from '@platform/outbox';

import { round3 } from '../../common/utils/rounding.util';
import {
  createBaseEvent,
  toEventIso,
  FCRAlertEvent,
  FeedingDailySummaryEvent,
  MealMissedEvent,
  MealUnderfedEvent,
  MealWindowUpcomingEvent,
  MealWindowEntry,
} from '@platform/event-contracts';

import {
  FeedingProtocolV2,
  FeedingProtocolStatus,
  FcrMatrix,
  ProtocolFcrSource,
} from '../entities/feeding-protocol-v2.entity';
import { Feed } from '../../feed/entities/feed.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import {
  MealPlanGeneratorService,
  ComputedDayPlan,
  mixedTankStats,
} from '../services/meal-plan-generator.service';
import {
  BiomassGrowthApplierService,
  type UnitGrowthMutationScopeV1,
} from '../services/biomass-growth-applier.service';
import {
  WaterTemperatureService,
  type EffectiveTemperature,
} from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { collectFeedSourceFeedIds, buildFeedFcrMatrixMap } from '../services/feed-fcr-source.util';
import {
  FORECAST_RETENTION_DAYS,
  ProtocolFeedForecastExecutor,
} from './protocol-feed-forecast.executor';
import type {
  ScheduledSiteFeedingOperationCommand,
  ScheduledTenantFeedingOperationCommand,
} from '../feeding-operation-command';
import type { FeedingScheduledOperationHandler } from '../feeding-operation-handler';
import type {
  FeedingOperationSession,
  VerifiedFeedingOperationSession,
} from '../feeding-operation-session';
import { FeedingAggregateMutationPort } from '../feeding-aggregate-mutation.writer';
import {
  feedingOperationObservedAt,
  readFeedingOperationSession,
} from '../feeding-operation-session';
import {
  computeDayPlanGrowthRollupDeltaV1,
  DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1,
} from '../day-plan-growth-reconciliation.authority';
import {
  MealFinalizationAuthority,
  resolveUnderfeedThresholdV1,
} from '../services/meal-finalization.authority';
import { publishUnfedStockedUnitSignalsV1 } from '../stocked-unit-feeding-readiness.authority';

const ASSIGNMENT_PAGE_SIZE = 200;
/** K-2 kanonik cap — schema validator ile aynı sabit. */
export const MEAL_WINDOW_MAX_ENTRIES = 500;
const MEAL_WINDOW_LEAD_MINUTES = 60;
const MEAL_WINDOW_JOB = feedingJobDefinition('v2.meal-window.sweep');
if (MEAL_WINDOW_JOB.scheduleKind !== 'absolute_interval') {
  throw new Error('v2.meal-window.sweep must be governed by an absolute interval');
}
/** Derived from the compiled job catalog; there is no second cadence number. */
export const MEAL_WINDOW_RENOTIFY_MINUTES = MEAL_WINDOW_JOB.intervalMinutes;

export function mealWindowRenotifyBefore(observedAt: Date): Date {
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error('Meal-window re-emission requires a valid observedAt instant');
  }
  return new Date(observedAt.getTime() - MEAL_WINDOW_RENOTIFY_MINUTES * 60_000);
}
/** Retention pencereleri (plan §2 tablosu + NFR "Receipt büyümesi", K-16). */
const DAY_PLAN_RETENTION_MONTHS = 24;
const RECEIPT_RETENTION_DAYS = 90;

/** Toplu pencere event'lerine bölme — SAF (spec pinli). */
export function chunkWindowEntries<T>(entries: T[], cap: number): T[][] {
  if (entries.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < entries.length; i += cap) {
    chunks.push(entries.slice(i, i + cap));
  }
  return chunks;
}

/**
 * K-3 dry-run çıktısı — Faz 6 mutabakat kapısının (eski-vs-yeni plan
 * karşılaştırması + K-14 DRAFT kontrolü) girdisi. `computed` yalnız
 * outcome='computed' iken dolu; diğer outcome'lar aktivasyon engelinin
 * SINIFLANDIRILMIŞ nedenidir (sessiz atlama yok).
 */
export interface DryRunUnitPlan {
  assignmentId: string;
  unitId: string;
  unitCode: string;
  siteId: string;
  planDate: string;
  outcome:
    | 'computed'
    | 'missing_protocol'
    | 'draft_protocol'
    | 'archived_protocol'
    | 'empty_unit'
    | 'no_plan';
  computed?: ComputedDayPlan;
}

/** Paylaşılan sayfa-döngüsü bağlamı (06:00 üretimi + K-3 dry-run). */
interface AssignmentPlanContext {
  assignment: ProtocolAssignment;
  protocol?: FeedingProtocolV2;
  tankBatch?: TankBatch;
  temperature: EffectiveTemperature;
  timezone: FeedingTimezone;
  planDate: string;
  mutationInstant: MutationInstantV1;
  feedFcrMatrixByFeedId: Map<string, FcrMatrix>;
}

export interface FeedingDryRunTarget {
  readonly siteId: string;
  readonly timezone: FeedingTimezone;
  /** Explicit Site-local date from the dry-run authority cut. */
  readonly planDate: string;
}

interface PendingDailyGrowthRollupV1 {
  readonly id: string;
  readonly unitId: string;
  readonly growthPolicyVersion: number;
  readonly expectedFcr: number;
  readonly appliedKg: number;
  readonly totalActualKg: number;
}

@Injectable()
export class ScheduledFeedingOperationExecutor implements FeedingScheduledOperationHandler {
  private readonly logger = new Logger(ScheduledFeedingOperationExecutor.name);

  constructor(
    private readonly feedingMutations: FeedingAggregateMutationPort,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly generator: MealPlanGeneratorService,
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly mealFinalization: MealFinalizationAuthority,
    private readonly temperatureService: WaterTemperatureService,
    // 18:00 FCR süpürmesi hedefi P-14 zincirinden okur (GrowthModule export'u).
    private readonly fcrCalculation: FCRCalculationService,
    private readonly outboxPublisher: OutboxPublisher,
    // 07:00 stok kapsama süpürmesi — snapshot yenileme (K-10, plan §5).
    private readonly forecastExecutor: ProtocolFeedForecastExecutor,
    private readonly mobileCommandReceipts: MobileCommandReceiptService,
  ) {}

  async executeScheduledOperation(
    session: FeedingOperationSession,
    command: ScheduledSiteFeedingOperationCommand | ScheduledTenantFeedingOperationCommand,
  ): Promise<void> {
    const context = readFeedingOperationSession(session);
    switch (command.jobId) {
      case 'v2.day-plan.generate':
        return this.generateForSite(context, command.siteId);
      case 'v2.meal-window.sweep':
        return this.sweepMealWindowForSite(context, command.siteId);
      case 'v2.morning.sweep':
        return this.sweepSite(context, command.siteId);
      case 'v2.daily-summary.publish':
        return this.summarizeSite(context, command.siteId);
      case 'v2.stock-coverage.refresh':
        await this.forecastExecutor.executeScheduledTenantProjection(session);
        return;
      case 'v2.fcr-alert.sweep':
        return this.sweepFcrForSite(context, command.siteId);
      case 'v2.retention.purge':
        return this.purgeTenantRetention(context);
    }
  }

  // ==========================================================================
  // 06:00 — GÜN PLANI ÜRETİMİ + D-5 TESPİTİ
  // ==========================================================================

  /** Tek tenant üretimi — sayfa başına SABİT toplu okuma, ünite başına sorgu yok. */
  private async generateForSite(
    context: VerifiedFeedingOperationSession,
    siteId: string,
  ): Promise<void> {
    const { manager, tenantId, timezone } = context;

    await this.forEachAssignmentContext(
      manager,
      tenantId,
      siteId,
      timezone,
      context.localDate,
      context.mutationInstant,
      ProtocolAssignmentStatus.ACTIVE,
      async (ctx) => {
        // DRAFT/ARCHIVED protokole işaret eden aktif atama plan ÜRETMEZ —
        // ünite D-5 süpürmesinde draft_protocol gerekçesiyle raporlanır.
        if (!ctx.protocol || ctx.protocol.status !== FeedingProtocolStatus.ACTIVE) return;
        if (!ctx.tankBatch || ctx.tankBatch.totalQuantity <= 0) return;

        const computed = this.computePlanFor(ctx);
        if (!computed) return;
        await this.generator.persistDayPlan(
          manager,
          context.mutationSession,
          {
            tenantId,
            assignmentId: ctx.assignment.id,
            protocolId: ctx.assignment.protocolId,
            unitId: ctx.assignment.unitId,
            siteId: ctx.assignment.siteId,
            unitType: ctx.assignment.unitType,
            unitName: ctx.assignment.unitName,
            unitCode: ctx.assignment.unitCode,
            planDate: ctx.planDate,
          },
          computed,
        );
      },
    );

    // D-5: balıklı olup ETKİN planı olmayan üniteler — atamasız /
    // balıklı-paused / DRAFT protokollü. Tek sorgu, event ünite başına.
    await publishUnfedStockedUnitSignalsV1(
      manager,
      this.outboxPublisher,
      tenantId,
      siteId,
    );
  }

  /**
   * K-3 dry-run: PAUSED atamalar için plan HESABI — persist YOK, event YOK.
   * Faz 6 mutabakat kapısının eski-vs-yeni plan karşılaştırması bu çıktıyı
   * kullanır: migration'dan paused gelen her atamanın aktive edildiğinde ne
   * üreteceği (veya neden üretmeyeceği) operatöre önceden görünür olur.
   */
  async dryRunForTargets(
    tenantId: string,
    targets: readonly FeedingDryRunTarget[],
  ): Promise<DryRunUnitPlan[]> {
    const results: DryRunUnitPlan[] = [];
    if (targets.length === 0) {
      throw new Error(`Tenant ${tenantId} has no governed feeding Site target for dry-run`);
    }
    for (const target of targets) {
      await runInTenantTransaction(
        this.dataSource,
        'farm',
        tenantId,
        async (queryRunner, mutationSession) => {
          const mutationInstant = await readTenantMutationInstantV1(mutationSession, 'farm');
          await this.forEachAssignmentContext(
            queryRunner.manager,
            tenantId,
            target.siteId,
            target.timezone,
            target.planDate,
            mutationInstant,
            ProtocolAssignmentStatus.PAUSED,
            async (ctx) => {
              const base = {
                assignmentId: ctx.assignment.id,
                unitId: ctx.assignment.unitId,
                unitCode: ctx.assignment.unitCode,
                siteId: ctx.assignment.siteId,
                planDate: ctx.planDate,
              };
              if (!ctx.protocol) {
                results.push({ ...base, outcome: 'missing_protocol' });
                return;
              }
              if (ctx.protocol.status === FeedingProtocolStatus.DRAFT) {
                // K-14 kapı girdisi: DRAFT protokole işaret eden atama —
                // aktivasyondan önce operatör onayı gerekir.
                results.push({ ...base, outcome: 'draft_protocol' });
                return;
              }
              if (ctx.protocol.status !== FeedingProtocolStatus.ACTIVE) {
                results.push({ ...base, outcome: 'archived_protocol' });
                return;
              }
              if (!ctx.tankBatch || ctx.tankBatch.totalQuantity <= 0) {
                results.push({ ...base, outcome: 'empty_unit' });
                return;
              }
              const computed = this.computePlanFor(ctx);
              if (!computed) {
                results.push({ ...base, outcome: 'no_plan' });
                return;
              }
              results.push({ ...base, outcome: 'computed', computed });
            },
          );
        },
      );
    }
    return results;
  }

  /**
   * Paylaşılan sayfa döngüsü: atamalar 200'lük sayfalarla, sayfa başına SABİT
   * toplu okuma (protokoller IN, TankBatch IN, sıcaklıklar, feed matrisleri,
   * site timezone'ları) — ünite başına sorgu SIFIR. 06:00 üretimi ve K-3
   * dry-run AYNI yükleyiciden geçer; iki yol birbirinden sapamaz.
   */
  private async forEachAssignmentContext(
    manager: EntityManager,
    tenantId: string,
    siteId: string,
    timezone: FeedingTimezone,
    planDate: string,
    mutationInstant: MutationInstantV1,
    status: ProtocolAssignmentStatus,
    visit: (ctx: AssignmentPlanContext) => Promise<void>,
  ): Promise<void> {
    for (let page = 0; ; page++) {
      const assignments = await manager.find(ProtocolAssignment, {
        where: { tenantId, siteId, status },
        order: { id: 'ASC' },
        skip: page * ASSIGNMENT_PAGE_SIZE,
        take: ASSIGNMENT_PAGE_SIZE,
      });
      if (assignments.length === 0) break;

      const protocolIds = [...new Set(assignments.map((a) => a.protocolId))];
      const unitIds = assignments.map((a) => a.unitId);
      const [protocols, tankBatches, temperatures] = await Promise.all([
        manager.find(FeedingProtocolV2, { where: { tenantId, id: In(protocolIds) } }),
        manager.find(TankBatch, { where: { tenantId, tankId: In(unitIds) } }),
        this.temperatureService.getEffectiveTemperaturesForUnits(tenantId, unitIds),
      ]);
      const protocolById = new Map(protocols.map((p) => [p.id, p]));
      const tankBatchByUnit = new Map(tankBatches.map((tb) => [tb.tankId, tb]));
      // NFR 4. toplu okuma: fcrSource=feed protokollerin band yemlerinin FCR
      // matrisleri — bunsuz feed kaynağı her planda sessizce band'a düşerdi.
      const feedFcrMatrixByFeedId = await this.loadFeedFcrMatrices(manager, tenantId, protocols);

      for (const assignment of assignments) {
        await visit({
          assignment,
          protocol: protocolById.get(assignment.protocolId),
          tankBatch: tankBatchByUnit.get(assignment.unitId),
          temperature: temperatures.get(assignment.unitId) ?? { celsius: null, source: 'none' },
          timezone,
          planDate,
          mutationInstant,
          feedFcrMatrixByFeedId,
        });
      }
      if (assignments.length < ASSIGNMENT_PAGE_SIZE) break;
    }
  }

  /** Ortak plan hesabı — üretim ve dry-run aynı computeDayPlan girdisini kurar. */
  private computePlanFor(ctx: AssignmentPlanContext): ComputedDayPlan | null {
    if (!ctx.protocol || !ctx.tankBatch) return null;
    return this.generator.computeDayPlan({
      assignment: ctx.assignment,
      protocol: ctx.protocol,
      stock: {
        fishCount: ctx.tankBatch.totalQuantity,
        biomassKg: Number(ctx.tankBatch.totalBiomassKg || 0),
        avgWeightG: Number(ctx.tankBatch.avgWeightG || 0),
        ...mixedTankStats(ctx.tankBatch.batchDetails),
      },
      temperature: ctx.temperature,
      planDate: ctx.planDate,
      timezone: ctx.timezone,
      mutationInstant: ctx.mutationInstant,
      feedFcrMatrixByFeedId: ctx.feedFcrMatrixByFeedId,
    });
  }

  /**
   * NFR 4. toplu okuma: sayfadaki fcrSource=feed protokollerin TÜM band
   * yemleri için Feed.feedingMatrix2D.fcrMatrix → FcrMatrix haritası.
   * Sayfada feed kaynaklı protokol yoksa sorgu atılmaz; matrissiz yemler
   * haritaya girmez — resolveExpectedFcr band fallback'ini provenanslı uygular.
   */
  private async loadFeedFcrMatrices(
    manager: EntityManager,
    tenantId: string,
    protocols: FeedingProtocolV2[],
  ): Promise<Map<string, FcrMatrix>> {
    const feedIds = collectFeedSourceFeedIds(protocols);
    if (feedIds.length === 0) return new Map();

    const feeds = await manager.find(Feed, {
      where: { tenantId, id: In(feedIds) },
      select: ['id', 'feedingMatrix2D'],
    });
    return buildFeedFcrMatrixMap(feeds);
  }

  // ==========================================================================
  // */15dk — MEAL WINDOW (K-2 TOPLU ŞEKİL)
  // ==========================================================================

  private async sweepMealWindowForSite(
    context: VerifiedFeedingOperationSession,
    siteId: string,
  ): Promise<void> {
    const { manager, tenantId } = context;
    const windowStart = feedingOperationObservedAt(context);
    const windowEnd = new Date(windowStart.getTime() + MEAL_WINDOW_LEAD_MINUTES * 60_000);
    const renotifyBefore = mealWindowRenotifyBefore(windowStart);
    const meals: Array<{
      id: string;
      unitId: string;
      dayPlanId: string;
      mealIndex: number;
      scheduledAt: Date;
      feedId: string;
      plannedKg: string | number;
      unitCode: string;
      protocolId: string;
      minDissolvedOxygen: number | null;
      lowOxygenReduction: number | null;
    }> = await manager.query(
      `SELECT m.id, m."unitId", m."dayPlanId", m."mealIndex", m."scheduledAt",
              m."feedId", m."plannedKg", dp."unitCode", dp."protocolId",
              (p.settings->>'minDissolvedOxygen')::numeric AS "minDissolvedOxygen",
              (p.settings->'adjustments'->>'lowOxygenReduction')::numeric AS "lowOxygenReduction"
         FROM "feeding_meals" m
         JOIN "feeding_day_plans" dp
           ON dp.id = m."dayPlanId" AND dp."tenantId" = m."tenantId"
         LEFT JOIN "feeding_protocols_v2" p
           ON p.id = dp."protocolId" AND p."tenantId" = dp."tenantId"
        WHERE m."tenantId" = $1 AND m.status = 'scheduled'
          AND dp."siteId" = $2::uuid
          AND (
            m."windowNotifiedAt" IS NULL
            OR m."windowNotifiedAt" < $5
          )
          AND m."scheduledAt" >= $3 AND m."scheduledAt" < $4
        ORDER BY m."scheduledAt" ASC`,
      [tenantId, siteId, windowStart, windowEnd, renotifyBefore],
    );
    if (meals.length === 0) return;

    const entries: MealWindowEntry[] = meals.map((meal) => ({
      unitId: meal.unitId,
      unitCode: meal.unitCode,
      dayPlanId: meal.dayPlanId,
      mealId: meal.id,
      mealIndex: meal.mealIndex,
      scheduledAt: toEventIso(meal.scheduledAt),
      feedId: meal.feedId,
      plannedKg: Number(meal.plannedKg),
      protocolId: meal.protocolId,
      minDissolvedOxygen: meal.minDissolvedOxygen ?? undefined,
      lowOxygenReductionPercent: meal.lowOxygenReduction ?? undefined,
    }));
    const chunks = chunkWindowEntries(entries, MEAL_WINDOW_MAX_ENTRIES);
    for (const [index, chunk] of chunks.entries()) {
      const event: MealWindowUpcomingEvent = {
        ...createBaseEvent<MealWindowUpcomingEvent>('MealWindowUpcoming', tenantId),
        windowStart: toEventIso(windowStart),
        windowEnd: toEventIso(windowEnd),
        leadMinutes: MEAL_WINDOW_LEAD_MINUTES,
        batchIndex: index,
        batchCount: chunks.length,
        meals: chunk,
      };
      await this.outboxPublisher.enqueue(event, manager);
    }
    await this.feedingMutations.markMealWindowNotified(
      context.mutationSession,
      meals.map((meal) => meal.id),
    );
  }

  // ==========================================================================
  // 05:30 — SABAH SÜPÜRMESİ (missed + bayat partial finalize + DAILY rollup)
  // ==========================================================================

  /**
   * Drains overdue meals through a bounded database candidate projection. A
   * unit's Batch/TankBatch locks are acquired before its full meal rows are
   * claimed with `FOR UPDATE SKIP LOCKED`, preserving the canonical mutation
   * order while keeping both cutoff and memory bounds inside PostgreSQL.
   */
  private async drainOverdueMealsForSite(
    context: VerifiedFeedingOperationSession,
    siteId: string,
    observedAt: Date,
    cutoff: Date,
    pendingRollups: readonly PendingDailyGrowthRollupV1[],
  ): Promise<void> {
    const { manager, tenantId } = context;
    const eligibleStatuses = [FeedingMealStatus.SCHEDULED, FeedingMealStatus.PARTIALLY_FED];
    const processedRollupIds = new Set<string>();

    for (;;) {
      const candidates: Array<{ id: string; unitId: string; dayPlanId: string }> =
        await manager.query(
          `SELECT meal.id, meal."unitId", meal."dayPlanId"
             FROM "feeding_meals" meal
             JOIN "feeding_day_plans" plan
               ON plan.id = meal."dayPlanId" AND plan."tenantId" = meal."tenantId"
            WHERE meal."tenantId" = $1
              AND plan."siteId" = $2::uuid
              AND meal.status = ANY($3::feeding_meals_status_enum[])
              AND meal."scheduledAt" < $4::timestamptz
            ORDER BY meal."unitId" ASC, meal."scheduledAt" ASC, meal.id ASC
            LIMIT $5`,
          [
            tenantId,
            siteId,
            eligibleStatuses,
            cutoff,
            FEEDING_SCHEDULE_EXECUTION_POLICY_V1.mealClaimPageSize,
          ],
        );
      const candidateIds = new Set(candidates.map((candidate) => candidate.id));
      if (candidateIds.size !== candidates.length) {
        throw new Error('Overdue meal candidate projection returned duplicate identities');
      }
      const dayPlanIds = [...new Set(candidates.map((candidate) => candidate.dayPlanId))];
      const dayPlans =
        dayPlanIds.length === 0
          ? []
          : await manager.find(FeedingDayPlan, {
              where: { tenantId, id: In(dayPlanIds) },
            });
      const dayPlanById = new Map(dayPlans.map((dayPlan) => [dayPlan.id, dayPlan]));
      if (dayPlanById.size !== dayPlanIds.length) {
        throw new Error('Overdue meal page is outside the governed day-plan set');
      }
      const protocolIds = [...new Set(dayPlans.map((dayPlan) => dayPlan.protocolId))];
      const protocols =
        protocolIds.length === 0
          ? []
          : await manager.find(FeedingProtocolV2, {
              where: { tenantId, id: In(protocolIds) },
            });
      const protocolById = new Map(protocols.map((protocol) => [protocol.id, protocol]));
      const lastCandidateUnitId = candidates.at(-1)?.unitId;
      const eligibleRollups = pendingRollups.filter(
        (rollup) =>
          !processedRollupIds.has(rollup.id) &&
          (lastCandidateUnitId === undefined || rollup.unitId <= lastCandidateUnitId),
      );
      const unitIds = [
        ...new Set([
          ...candidates.map((candidate) => candidate.unitId),
          ...eligibleRollups.map((rollup) => rollup.unitId),
        ]),
      ].sort();
      if (unitIds.length === 0) return;
      let claimedCount = 0;

      for (const unitId of unitIds) {
        const unitCandidateIds = candidates
          .filter((candidate) => candidate.unitId === unitId)
          .map((candidate) => candidate.id);
        const unitRollups = eligibleRollups.filter((rollup) => rollup.unitId === unitId);
        const claimAndProcess = async (
          growthScope: UnitGrowthMutationScopeV1 | null,
        ): Promise<number> => {
          const meals: FeedingMeal[] =
            unitCandidateIds.length === 0
              ? []
              : await manager.query(
                  `SELECT meal.*
               FROM "feeding_meals" meal
              WHERE meal."tenantId" = $1
                AND meal.id = ANY($2::uuid[])
                AND meal.status = ANY($3::feeding_meals_status_enum[])
                AND meal."scheduledAt" < $4::timestamptz
              ORDER BY meal."scheduledAt" ASC, meal.id ASC
              FOR UPDATE SKIP LOCKED`,
                  [tenantId, unitCandidateIds, eligibleStatuses, cutoff],
                );
          if (
            meals.some(
              (meal) =>
                meal.tenantId !== tenantId ||
                meal.unitId !== unitId ||
                !candidateIds.has(meal.id) ||
                meal.scheduledAt >= cutoff,
            )
          ) {
            throw new Error('Overdue meal claim escaped its immutable candidate page');
          }

          const missed = meals.filter((meal) => meal.status === FeedingMealStatus.SCHEDULED);
          const partials = meals.filter((meal) => meal.status === FeedingMealStatus.PARTIALLY_FED);
          const growthMeals = partials.filter((meal) => {
            const dayPlan = dayPlanById.get(meal.dayPlanId);
            return (
              dayPlan?.growthPolicyVersion ===
                DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1.policyVersion &&
              dayPlan.growthApplicationMode === 'per_meal' &&
              Number(meal.actualKg) > 0 &&
              (dayPlan.resolution.expectedFcr ?? 0) > 0
            );
          });
          if (growthMeals.length > 0 && !growthScope) {
            throw new Error(`Unit ${unitId} has per-meal growth but no stock projection`);
          }

          for (const meal of missed) {
            meal.status = FeedingMealStatus.MISSED;
            await this.feedingMutations.commitMealTransition(context.mutationSession, {
              intent: 'missed',
              aggregate: meal,
            });
            const dayPlan = dayPlanById.get(meal.dayPlanId);
            const event: MealMissedEvent = {
              ...createBaseEvent<MealMissedEvent>('MealMissed', tenantId, {
                aggregateId: meal.id,
                aggregateType: 'FeedingMeal',
              }),
              unitId: meal.unitId,
              unitCode: dayPlan?.unitCode ?? '',
              mealId: meal.id,
              dayPlanId: meal.dayPlanId,
              scheduledAt: toEventIso(meal.scheduledAt),
            };
            await this.outboxPublisher.enqueue(event, manager);
            if (dayPlan) {
              await this.mealFinalization.settleDayPlanStatus(
                manager,
                context.mutationSession,
                tenantId,
                dayPlan,
              );
            }
          }

          for (const meal of partials) {
            const dayPlan = dayPlanById.get(meal.dayPlanId);
            if (!dayPlan) throw new Error(`Missing day plan for stale meal ${meal.id}`);
            const protocol = protocolById.get(dayPlan.protocolId);
            await this.mealFinalization.finalize(manager, {
              tenantId,
              mutationSession: context.mutationSession,
              dayPlan,
              meal,
              growthScope,
              operationId: context.operationId,
              finalizedAt: observedAt,
              fedBy: null,
              underfeedThresholdPercent: protocol?.settings.underfeedAlertThresholdPercent,
            });
          }
          if (unitRollups.length > 0) {
            if (!growthScope) {
              throw new Error(`Unit ${unitId} has DAILY rollup work but no stock projection`);
            }
            for (const rollup of unitRollups) {
              await this.reconcilePendingDailyRollup(context, observedAt, rollup, growthScope);
            }
          }
          return meals.length;
        };

        const lockedCount = await this.growthApplier.withUnitGrowthMutation(
          manager,
          context.mutationSession,
          tenantId,
          unitId,
          context.mutationInstant,
          claimAndProcess,
        );
        if (lockedCount === null) {
          claimedCount += await claimAndProcess(null);
        } else {
          claimedCount += lockedCount;
          unitRollups.forEach((rollup) => processedRollupIds.add(rollup.id));
        }
      }

      // A non-empty candidate page with zero claimable rows means another
      // writer owns every row. Fail the operation so the durable dispatch retry
      // policy, rather than a false-success schedule key, owns convergence.
      if (candidates.length > 0 && claimedCount === 0) {
        throw new Error('Overdue meal page is currently owned by another mutation');
      }
    }
  }

  private async reconcilePendingDailyRollup(
    context: VerifiedFeedingOperationSession,
    observedAt: Date,
    plan: PendingDailyGrowthRollupV1,
    scope: UnitGrowthMutationScopeV1,
  ): Promise<void> {
    if (plan.growthPolicyVersion !== DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1.policyVersion) {
      throw new Error(
        `Unsupported day-plan growth policy version ${plan.growthPolicyVersion} for ${plan.id}`,
      );
    }
    const previouslyAppliedKg = Number(plan.appliedKg);
    const totalActualKg = Number(plan.totalActualKg);
    const expectedFcr = Number(plan.expectedFcr);
    const delta = computeDayPlanGrowthRollupDeltaV1({
      totalActualKg,
      previouslyAppliedKg,
      expectedFcr,
    });
    if (!delta.applicable) {
      throw new Error(`DAILY growth reconciliation for plan ${plan.id} has no positive live FCR`);
    }
    const applied =
      delta.growthDeltaKg === 0
        ? { appliedGrowthKg: 0 }
        : await scope.applyGrowth(delta.growthDeltaKg, expectedFcr);
    await this.feedingMutations.recordDayPlanGrowthApplication(context.mutationSession, {
      dayPlanId: plan.id,
      applicationMode: 'DAILY_ROLLUP',
      appliedAt: observedAt,
      expectedFcr,
      feedDeltaKg: delta.appliedDeltaKg,
      growthDeltaKg: applied.appliedGrowthKg,
      operationId: context.operationId,
      idempotencyKey: `growth:${plan.id}:daily:${context.operationId}`,
      recordedBy: 'farm-feeding-scheduler',
      sourceRef: `day-plan-rollup:${plan.id}:${totalActualKg.toFixed(3)}`,
    });
  }

  private async sweepSite(context: VerifiedFeedingOperationSession, siteId: string): Promise<void> {
    const { manager, tenantId } = context;
    const observedAt = feedingOperationObservedAt(context);
    const cutoff = feedingMealOverdueCutoff(observedAt);

    // DAILY rollup identities are compiled before any unit lock. The drain
    // interleaves them with overdue meal units in one monotonic unit order.
    const pendingRollups: PendingDailyGrowthRollupV1[] = await manager.query(
      `SELECT dp.id,
                dp."unitId",
                dp."growthPolicyVersion",
                (dp.resolution->>'expectedFcr')::numeric AS "expectedFcr",
                dp."rollupAppliedKg"::numeric AS "appliedKg",
                totals.actual AS "totalActualKg"
           FROM "feeding_day_plans" dp
           CROSS JOIN LATERAL (
             SELECT COALESCE(SUM(m."actualKg"), 0)::numeric AS actual
               FROM "feeding_meals" m
              WHERE m."tenantId" = dp."tenantId" AND m."dayPlanId" = dp.id
           ) totals
           WHERE dp."tenantId" = $1
             AND dp."siteId" = $2::uuid
             AND dp."growthApplicationMode" = 'daily'
             AND dp.status = ANY($3::feeding_day_plans_status_enum[])
             AND dp."planDate" < $4::date
             AND dp."planDate" >= $4::date - $5::integer
             AND dp."rollupAppliedKg"::numeric <> totals.actual
           ORDER BY dp."unitId" ASC, dp.id ASC
           LIMIT $6`,
      [
        tenantId,
        siteId,
        [...DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1.dailyCandidateStatuses],
        context.localDate,
        DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1.lookbackDays,
        DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1.candidateLimit,
      ],
    );
    await this.drainOverdueMealsForSite(context, siteId, observedAt, cutoff, pendingRollups);
  }

  // ==========================================================================
  // D+1 18:00 — GRACE-KAPANMIŞ GÜNLÜK ÖZET + GÜN-SEVİYESİ AZ-ATIM (D-16)
  // ==========================================================================

  private async summarizeSite(
    context: VerifiedFeedingOperationSession,
    siteId: string,
  ): Promise<void> {
    const { manager, tenantId } = context;
    const overdueCutoff = feedingMealOverdueCutoff(feedingOperationObservedAt(context));
    const planDate = feedingDailySummaryPlanDate(context.localDate);
    const rows: Array<{
      id: string;
      unitId: string;
      unitCode: string;
      planDate: string;
      status: FeedingDayPlanStatus;
      plannedTotalKg: string | number;
      unplannedActualKg: string | number;
      actualKg: string | number | null;
      missedCount: string | number | null;
      thresholdPercent: number | null;
    }> = await manager.query(
      `SELECT dp.id, dp."unitId", dp."unitCode", dp."planDate", dp.status,
                dp."plannedTotalKg", dp."unplannedActualKg",
                (SELECT COALESCE(SUM(m."actualKg"), 0)
                   FROM "feeding_meals" m
                  WHERE m."tenantId" = dp."tenantId" AND m."dayPlanId" = dp.id) AS "actualKg",
                (SELECT COUNT(*)
                   FROM "feeding_meals" m
                  WHERE m."tenantId" = dp."tenantId"
                    AND m."dayPlanId" = dp.id
                    AND (
                      m.status = 'missed'
                      OR (m.status = 'scheduled' AND m."scheduledAt" < $4::timestamptz)
                    )) AS "missedCount",
                (p.settings->>'underfeedAlertThresholdPercent')::numeric AS "thresholdPercent"
         FROM "feeding_day_plans" dp
         LEFT JOIN "feeding_protocols_v2" p
           ON p.id = dp."protocolId" AND p."tenantId" = dp."tenantId"
         WHERE dp."tenantId" = $1
           AND dp."siteId" = $2::uuid
           AND dp."planDate" = $3::date
           AND dp.status <> 'cancelled'`,
      [tenantId, siteId, planDate, overdueCutoff],
    );
    if (rows.length === 0) return;

    let plannedTotal = 0;
    let actualTotal = 0;
    let completed = 0;
    let skipped = 0;
    let missedMeals = 0;
    let underfedUnits = 0;

    for (const row of rows) {
      const planned = Number(row.plannedTotalKg);
      const actual = Number(row.actualKg ?? 0) + Number(row.unplannedActualKg ?? 0);
      plannedTotal += planned;
      actualTotal += actual;
      missedMeals += Number(row.missedCount ?? 0);
      if (row.status === FeedingDayPlanStatus.COMPLETED) completed += 1;
      if (row.status === FeedingDayPlanStatus.SKIPPED) skipped += 1;

      // D-16: öğün başına eşik altında kalan ama GÜN toplamında eşiği aşan
      // sistematik açık — MealUnderfed(scope=day).
      const threshold = resolveUnderfeedThresholdV1(row.thresholdPercent);
      if (planned > 0) {
        const dayVariancePercent = ((actual - planned) / planned) * 100;
        if (dayVariancePercent < -threshold) {
          underfedUnits += 1;
          const underfed: MealUnderfedEvent = {
            ...createBaseEvent<MealUnderfedEvent>('MealUnderfed', tenantId, {
              aggregateId: row.id,
              aggregateType: 'FeedingDayPlan',
            }),
            scope: 'day',
            unitId: row.unitId,
            unitCode: row.unitCode,
            dayPlanId: row.id,
            plannedKg: round3(planned),
            actualKg: round3(actual),
            variancePercent: round3(dayVariancePercent),
            thresholdPercent: threshold,
          };
          await this.outboxPublisher.enqueue(underfed, manager);
        }
      }
    }

    const summary: FeedingDailySummaryEvent = {
      ...createBaseEvent<FeedingDailySummaryEvent>('FeedingDailySummary', tenantId),
      planDate: rows[0]!.planDate,
      unitsPlanned: rows.length,
      unitsCompleted: completed,
      unitsSkipped: skipped,
      plannedTotalKg: round3(plannedTotal),
      actualTotalKg: round3(actualTotal),
      underfedUnitCount: underfedUnits,
      missedMealCount: missedMeals,
    };
    await this.outboxPublisher.enqueue(summary, manager);
  }

  // ==========================================================================
  // 18:00 — FCR ALERT SÜPÜRMESİ (C-1: İLK durable FCRAlert emisyonu)
  // ==========================================================================

  /**
   * FCRAlert bugüne dek yalnız in-process yayılıyordu (`feeding.fcrAlerts`,
   * dead-end log zinciri) — bu iş kontratı İLK KEZ outbox'a yazar; tüketici
   * alert-engine `FcrAlertEventHandler`. Eşikler legacy analyzeFCR ile
   * birebir; HEDEF ise artık P-14 zincirinden gelir (kullanıcı override →
   * v2 protokol → legacy program → species → endüstri → 1.5), yani alert
   * motorun fiilen beslediği hedefe karşı ölçülür.
   */
  /**
   * 07:00 — stok kapsama değerlendirmesi (plan §5): her tenant'ın forecast
   * snapshot'ı MAKS ufukta yeniden hesaplanır (K-10); `protocolFeedForecast`
   * sorgusu ve mobil warehouseSummary bu satırı diler. Legacy scheduler'ın
   * 10:00 checkFeedStock + weeklyFeedForecast görevlerinin varisi. Durable
   * kapsama event'leri (FeedStockoutForecast/FeedTransitionUpcoming) GraphQL
   * + alert-engine dilimiyle birlikte bağlanır (görev #8 takipte).
   */
  private async sweepFcrForSite(
    context: VerifiedFeedingOperationSession,
    siteId: string,
  ): Promise<void> {
    const { manager, tenantId } = context;
    const rows: Array<{ id: string; actual: string | number | null }> = await manager.query(
      `SELECT b.id, (b.fcr->>'actual')::numeric AS actual
           FROM "batches_v2" b
          WHERE b."tenantId" = $1
            AND b."isActive" = true
            AND b.status IN ('ACTIVE', 'GROWING')
            AND (b.fcr->>'actual')::numeric > 0
            AND EXISTS (
              SELECT 1
                FROM "batch_locations" bl
                JOIN "feeding_protocol_assignments" pa
                  ON pa."tenantId" = bl."tenantId"
                 AND pa."unitId" = COALESCE(bl."tankId", bl."pondId")
                 AND pa."siteId" = $2::uuid
               WHERE bl."tenantId" = b."tenantId"
                 AND bl."batchId" = b.id
                 AND bl."isCurrentLocation" = true
            )`,
      [tenantId, siteId],
    );
    if (rows.length === 0) return;

    const targets = await this.fcrCalculation.getTargetFCRForBatches(
      tenantId,
      rows.map((row) => row.id),
    );
    const alerting = rows
      .map((row) => {
        const currentFCR = Number(row.actual);
        const targetFCR = targets.get(row.id) ?? 0;
        if (!Number.isFinite(currentFCR) || !targetFCR || targetFCR <= 0) return null;
        const variancePercent = ((currentFCR - targetFCR) / targetFCR) * 100;
        if (variancePercent <= FEEDING_SCHEDULE_EXECUTION_POLICY_V1.fcrWarningVariancePercent) {
          return null;
        }
        return { batchId: row.id, currentFCR, targetFCR, variancePercent };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
    if (alerting.length === 0) return;

    const trends = await this.fcrCalculation.analyzeFCRTrendMany(
      tenantId,
      alerting.map((candidate) => candidate.batchId),
    );

    for (const candidate of alerting) {
      const alertLevel: FCRAlertEvent['alertLevel'] =
        candidate.variancePercent > FEEDING_SCHEDULE_EXECUTION_POLICY_V1.fcrCriticalVariancePercent
          ? 'critical'
          : 'warning';

      const event: FCRAlertEvent = {
        ...createBaseEvent<FCRAlertEvent>('FCRAlert', tenantId, {
          aggregateId: candidate.batchId,
          aggregateType: 'Batch',
        }),
        batchId: candidate.batchId,
        currentFCR: round3(candidate.currentFCR),
        targetFCR: round3(candidate.targetFCR),
        variancePercent: round3(candidate.variancePercent),
        trend: trends.get(candidate.batchId)?.trend ?? 'stable',
        alertLevel,
      };
      await this.outboxPublisher.enqueue(event, manager);
    }
  }

  // ==========================================================================
  // AYLIK — RETENTION TEMİZLİĞİ (K-16 + NFR "Receipt büyümesi")
  // ==========================================================================

  /**
   * Day plan + öğünler 24 AY saklanır (feeding_records retention'ıyla hizalı;
   * `feeding_records.mealId` soft-ref olduğundan FK kırılması yok — K-16).
   * Mobil komut makbuzları 90 GÜN saklanır (~4000 makbuz/gün/tenant ölçeği);
   * purge sonrası eski clientCommandId replay'i bile çift uygulayamaz —
   * meal status guard'ı + stock-movement idempotency anahtarı iki bağımsız
   * katmandır (NFR). Semantic schedule catalog authority tarafından belirlenir.
   */
  private async purgeTenantRetention(context: VerifiedFeedingOperationSession): Promise<void> {
    const { manager, tenantId } = context;
    const observedAt = feedingOperationObservedAt(context);

    // Önce öğünler (plan join'i üzerinden) — soft-ref sıra bağımsızlığına
    // rağmen bu sıra, yarıda kesilen bir koşunun öksüz öğün bırakmasını
    // yapısal olarak önler.
    const meals = await this.feedingMutations.purgeMealsBeforeRetention(
      context.mutationSession,
      DAY_PLAN_RETENTION_MONTHS,
    );
    const plans = await this.feedingMutations.purgeDayPlansBeforeRetention(
      context.mutationSession,
      DAY_PLAN_RETENTION_MONTHS,
    );
    const forecastSnapshots = await this.feedingMutations.purgeForecastProjectionBefore(
      context.mutationSession,
      new Date(observedAt.getTime() - FORECAST_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    );
    const receipts = await this.mobileCommandReceipts.purgeBeforeRetention(manager, {
      tableName: 'farm_mobile_command_receipts',
      tenantId,
      retentionDays: RECEIPT_RETENTION_DAYS,
    });

    const purged = {
      meals,
      dayPlans: plans,
      receipts,
      forecastSnapshots,
    };
    if (purged.meals + purged.dayPlans + purged.receipts + purged.forecastSnapshots > 0) {
      this.logger.log(
        `Retention purge: ${purged.meals} meals, ${purged.dayPlans} day plans, ` +
          `${purged.receipts} receipts and ${purged.forecastSnapshots} forecast snapshots removed ` +
          `(tenant ${tenantId.substring(0, 8)}...)`,
      );
    }
  }

  // ==========================================================================
  // ORTAK YARDIMCILAR
  // ==========================================================================

  /**
   * Retention keşfi: day plan VEYA makbuz taşıyan tüm tenant'lar — aktif
   * atama/batch filtreleri retention için fazla dar olurdu (tarihsel veri,
   * atamaları biten tenant'ta da yaşar).
   */
  // Target discovery is compiled exclusively by
  // FeedingOperationTargetCompilerService from active writer authority.

  /**
   * Feeding state discovery is broader than active assignments. Historical
   * plans and meals remain eligible for finalization and summary even after an
   * assignment is paused or retired.
   */
  /**
   * Aktif batch'i olan tenant'lar — 18:00 FCR süpürmesinin keşif kümesi
   * (batch-scoped; `activeTenants`'ın atama filtresinden bilinçli olarak
   * geniş). Legacy analyzeFCR'ın keşif sorgusuyla birebir.
   */
  /**
   * Aktif v2 ataması olan tenant'lar — v1 cron'un keşif deseni:
   * `listTenantSchemas` + şema başına kısa ömürlü discovery runner'ı
   * (search_path pinli). Asıl iş `runInTenantTransaction` içinde koşar.
   */
}
