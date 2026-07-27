/**
 * FeedingCronV2Service — öğün motorunun zamanlanmış işleri (Faz 5, plan §2 tablosu).
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
 * | 20:00 | FeedingDailySummary (durable) + gün-seviyesi kronik az-atım       |
 * |       | süpürmesi — MealUnderfed(scope=day) (D-16)                        |
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
import * as crypto from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, QueryRunner } from 'typeorm';
import { listTenantSchemas, runInTenantTransaction } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  toEventIso,
  FCRAlertEvent,
  FeedingDailySummaryEvent,
  MealMissedEvent,
  MealUnderfedEvent,
  MealWindowUpcomingEvent,
  MealWindowEntry,
  UnfedUnitDetectedEvent,
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
} from './meal-plan-generator.service';
import { BiomassGrowthApplierService, type LockedUnit } from './biomass-growth-applier.service';
import {
  WaterTemperatureService,
  type EffectiveTemperature,
} from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { calendarDayIn } from './meal-schedule.util';
import { collectFeedSourceFeedIds, buildFeedFcrMatrixMap } from './feed-fcr-source.util';
import { ProtocolFeedForecastService } from './protocol-feed-forecast.service';
import { DayPlanRecalcService } from './day-plan-recalc.service';
import { round3 } from './rounding.util';

const ADVISORY_LOCK_NAMESPACE = 0x46454544; // 'FEED'
const ASSIGNMENT_PAGE_SIZE = 200;
/** K-2 kanonik cap — schema validator ile aynı sabit. */
export const MEAL_WINDOW_MAX_ENTRIES = 500;
const MEAL_WINDOW_LEAD_MINUTES = 60;
/** Legacy analyzeFCR eşikleri birebir: >%10 warning, >%20 critical. */
const FCR_WARNING_VARIANCE_PERCENT = 10;
const FCR_CRITICAL_VARIANCE_PERCENT = 20;
/** Retention pencereleri (plan §2 tablosu + NFR "Receipt büyümesi", K-16). */
const DAY_PLAN_RETENTION_MONTHS = 24;
const RECEIPT_RETENTION_DAYS = 90;
/**
 * DAILY rollup taraması (FARM-CRITICAL-244): alt tarih sınırı + koşu başına
 * tavan. Sınırsız tarama, mod değişimi senaryosunda 24 aylık planı tek koşuda
 * işleyip biyokütleyi katlayan patlama yarıçapının kendisiydi. Geç finalize
 * penceresi (öğün + düzeltme) günler mertebesinde; 35 gün fazlasıyla yeterli.
 */
const ROLLUP_LOOKBACK_DAYS = 35;
const ROLLUP_BATCH_LIMIT = 500;

/**
 * DAILY rollup mutabakatı — SAF (spec pinli, FARM-CRITICAL-244).
 *
 * Damga "uygulandı mı" değil "NE KADARI uygulandı" sorusunu tutar; her koşu
 * yalnız farkı büyümeye çevirir. Böylece geç finalize edilen öğün ve
 * `correctMealPour` deltası bir sonraki koşuda yakalanır, mod değişimi de
 * geçmişi yeniden işleyemez (mod planın kolonunda dondurulmuştur).
 */
export function computeRollupDelta(input: {
  totalActualKg: number;
  appliedKg: number;
  expectedFcr: number;
}): { deltaKg: number; growthKg: number; applicable: boolean } {
  const deltaKg = round3(input.totalActualKg - input.appliedKg);
  if (!Number.isFinite(input.expectedFcr) || input.expectedFcr <= 0) {
    return { deltaKg, growthKg: 0, applicable: false };
  }
  return { deltaKg, growthKg: round3(deltaKg / input.expectedFcr), applicable: true };
}

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
  timezone: string;
  planDate: string;
  feedFcrMatrixByFeedId: Map<string, FcrMatrix>;
}

@Injectable()
export class FeedingCronV2Service {
  private readonly logger = new Logger(FeedingCronV2Service.name);
  private readonly advisoryLockRunners = new Map<string, QueryRunner>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly generator: MealPlanGeneratorService,
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly temperatureService: WaterTemperatureService,
    // 18:00 FCR süpürmesi hedefi P-14 zincirinden okur (GrowthModule export'u).
    private readonly fcrCalculation: FCRCalculationService,
    private readonly outboxPublisher: OutboxPublisher,
    // 07:00 stok kapsama süpürmesi — snapshot yenileme (K-10, plan §5).
    private readonly forecastService: ProtocolFeedForecastService,
    // 05:30 bayat finalize'ı kalan öğünleri yeniden fiyatlar (finalize simetrisi).
    private readonly recalcService: DayPlanRecalcService,
  ) {}

  // ==========================================================================
  // 06:00 — GÜN PLANI ÜRETİMİ + D-5 TESPİTİ
  // ==========================================================================

  @Cron('0 6 * * *', { name: 'feeding-v2-generate-day-plans', timeZone: 'Europe/Istanbul' })
  async generateDayPlans(): Promise<void> {
    await this.runExclusive('feeding-v2-generate-day-plans', async () => {
      const tenants = await this.activeTenants();
      for (const tenantId of tenants) {
        try {
          const started = Date.now();
          await this.generateForTenant(tenantId);
          const elapsed = Date.now() - started;
          if (elapsed > 60_000) {
            // NFR kapasite sinyali: tenant >60sn — ölçek uyarısı, hata değil.
            this.logger.warn(`Day-plan generation slow for tenant ${tenantId}: ${elapsed}ms`);
          }
        } catch (error) {
          this.logger.error(
            `Day-plan generation failed for tenant ${tenantId}: ${(error as Error).message}`,
          );
        }
      }
    });
  }

  /** Tek tenant üretimi — sayfa başına SABİT toplu okuma, ünite başına sorgu yok. */
  async generateForTenant(tenantId: string): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      await this.forEachAssignmentContext(
        manager,
        tenantId,
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
              growthApplicationMode: ctx.protocol.settings.growthApplicationMode,
            },
            computed,
          );
        },
      );

      // D-5: balıklı olup ETKİN planı olmayan üniteler — atamasız /
      // balıklı-paused / DRAFT protokollü. Tek sorgu, event ünite başına.
      await this.detectUnfedUnits(manager, tenantId);
    });
  }

  /**
   * K-3 dry-run: PAUSED atamalar için plan HESABI — persist YOK, event YOK.
   * Faz 6 mutabakat kapısının eski-vs-yeni plan karşılaştırması bu çıktıyı
   * kullanır: migration'dan paused gelen her atamanın aktive edildiğinde ne
   * üreteceği (veya neden üretmeyeceği) operatöre önceden görünür olur.
   */
  async dryRunForTenant(tenantId: string): Promise<DryRunUnitPlan[]> {
    const results: DryRunUnitPlan[] = [];
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      await this.forEachAssignmentContext(
        queryRunner.manager,
        tenantId,
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
    });
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
    status: ProtocolAssignmentStatus,
    visit: (ctx: AssignmentPlanContext) => Promise<void>,
  ): Promise<void> {
    const timezoneBySite = await this.siteTimezones(manager, tenantId);

    for (let page = 0; ; page++) {
      const assignments = await manager.find(ProtocolAssignment, {
        where: { tenantId, status },
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
        const timezone = timezoneBySite.get(assignment.siteId) ?? 'UTC';
        await visit({
          assignment,
          protocol: protocolById.get(assignment.protocolId),
          tankBatch: tankBatchByUnit.get(assignment.unitId),
          temperature: temperatures.get(assignment.unitId) ?? { celsius: null, source: 'none' },
          timezone,
          planDate: calendarDayIn(timezone),
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

  private async detectUnfedUnits(manager: EntityManager, tenantId: string): Promise<void> {
    const rows: Array<{
      unitId: string;
      unitCode: string | null;
      siteId: string | null;
      fishCount: string | number;
      biomassKg: string | number | null;
      reason: 'no_assignment' | 'assignment_paused' | 'draft_protocol' | 'missing_protocol';
    }> = await manager.query(
      // Ünite başına TEK atama satırı (LATERAL + LIMIT 1): düz LEFT JOIN, aynı
      // ünitede birden çok canlı atama varsa çift satır döndürüp düzgün
      // beslenen üniteye her sabah sahte UnfedUnitDetected üretiyordu
      // (FARM-MEDIUM-250a). Kalıcı tekillik DB kısıtında
      // (IDX_fpa_tenant_unit_live); sorgu yine de savunmacı seçim yapar.
      //
      // `missing_protocol`: aktif atamanın protokol satırı yoksa `p.status`
      // NULL olur, `p.status <> 'active'` NULL döner ve satır sessizce
      // DÜŞERDİ — plan üretilmediği hâlde hiç raporlanmayan kör nokta.
      `SELECT tb."tankId" AS "unitId",
              COALESCE(a."unitCode", tb."tankCode") AS "unitCode",
              COALESCE(a."siteId", d."siteId") AS "siteId",
              tb."totalQuantity" AS "fishCount",
              tb."totalBiomassKg" AS "biomassKg",
              CASE
                WHEN a.id IS NULL THEN 'no_assignment'
                WHEN a.status = 'paused' THEN 'assignment_paused'
                WHEN p.id IS NULL THEN 'missing_protocol'
                WHEN p.status = 'draft' THEN 'draft_protocol'
                ELSE 'draft_protocol'
              END AS reason
       FROM "tank_batches" tb
       LEFT JOIN LATERAL (
         SELECT a.*
           FROM "feeding_protocol_assignments" a
          WHERE a."tenantId" = tb."tenantId"
            AND a."unitId" = tb."tankId"
            AND a.status IN ('active', 'paused')
          ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END,
                   a."effectiveFrom" DESC NULLS LAST
          LIMIT 1
       ) a ON true
       LEFT JOIN "feeding_protocols_v2" p
         ON p.id = a."protocolId" AND p."tenantId" = tb."tenantId"
       LEFT JOIN "equipment" e ON e.id = tb."tankId" AND e."tenantId" = tb."tenantId"
       LEFT JOIN "departments" d ON d.id = e."departmentId" AND d."tenantId" = tb."tenantId"
       WHERE tb."tenantId" = $1 AND tb."totalQuantity" > 0
         AND (a.id IS NULL OR a.status = 'paused' OR p.id IS NULL OR p.status <> 'active')`,
      [tenantId],
    );
    for (const row of rows) {
      if (!row.siteId) continue; // sitesiz ünite D-14 mutabakat kümesinde raporlanır
      const event: UnfedUnitDetectedEvent = {
        ...createBaseEvent<UnfedUnitDetectedEvent>('UnfedUnitDetected', tenantId, {
          aggregateId: row.unitId,
          aggregateType: 'FeedingUnit',
        }),
        unitId: row.unitId,
        unitCode: row.unitCode ?? '',
        siteId: row.siteId,
        reason: row.reason,
        fishCount: Number(row.fishCount),
        biomassKg: Number(row.biomassKg ?? 0),
      };
      await this.outboxPublisher.enqueue(event, manager);
    }
  }

  // ==========================================================================
  // */15dk — MEAL WINDOW (K-2 TOPLU ŞEKİL)
  // ==========================================================================

  @Cron('*/15 * * * *', { name: 'feeding-v2-meal-window' })
  async mealWindowSweep(): Promise<void> {
    await this.runExclusive('feeding-v2-meal-window', async () => {
      const tenants = await this.activeTenants();
      const windowStart = new Date();
      const windowEnd = new Date(windowStart.getTime() + MEAL_WINDOW_LEAD_MINUTES * 60_000);
      for (const tenantId of tenants) {
        try {
          await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
            const manager = queryRunner.manager;
            // Partial indeks üzerinden okur (scheduled + windowNotifiedAt IS NULL).
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
               JOIN "feeding_day_plans" dp ON dp.id = m."dayPlanId"
               LEFT JOIN "feeding_protocols_v2" p ON p.id = dp."protocolId"
               WHERE m."tenantId" = $1 AND m.status = 'scheduled'
                 AND m."windowNotifiedAt" IS NULL
                 AND m."scheduledAt" >= $2 AND m."scheduledAt" < $3
               ORDER BY m."scheduledAt" ASC`,
              [tenantId, windowStart, windowEnd],
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
            // İdempotency damgası AYNI tx'te — event yazıldıysa damga da yazıldı.
            await manager.query(
              // tenantId predikatı ZORUNLU: id listesi tenant sorgusundan
              // gelse de yazım yalnız search_path'e güvenemez (FARM-MEDIUM-287).
              `UPDATE "feeding_meals" SET "windowNotifiedAt" = now()
                WHERE "tenantId" = $1 AND id = ANY($2)`,
              [tenantId, meals.map((meal) => meal.id)],
            );
          });
        } catch (error) {
          this.logger.error(
            `Meal window sweep failed for tenant ${tenantId}: ${(error as Error).message}`,
          );
        }
      }
    });
  }

  // ==========================================================================
  // 05:30 — SABAH SÜPÜRMESİ (missed + bayat partial finalize + DAILY rollup)
  // ==========================================================================

  @Cron('30 5 * * *', { name: 'feeding-v2-morning-sweep', timeZone: 'Europe/Istanbul' })
  async morningSweep(): Promise<void> {
    await this.runExclusive('feeding-v2-morning-sweep', async () => {
      const tenants = await this.activeTenants();
      for (const tenantId of tenants) {
        try {
          await this.sweepTenant(tenantId);
        } catch (error) {
          this.logger.error(
            `Morning sweep failed for tenant ${tenantId}: ${(error as Error).message}`,
          );
        }
      }
    });
  }

  async sweepTenant(tenantId: string): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000); // pencere: 6 saat

      // (a)+(b) adayları kilitsiz okunur; işlem ÜNİTE gruplu ve unitId-artan
      // sırada koşar (K-1: rollup ile aynı yön). Growth kilidi gereken ünitede
      // Batch → TankBatch kilidi, o ünitenin HERHANGİ bir meal yazımından ÖNCE
      // alınır — meal-satırı-önce/kilit-sonra AB-BA penceresi yapısal kapalı.
      const [missedCandidates, partialCandidates] = await Promise.all([
        manager.find(FeedingMeal, {
          where: { tenantId, status: FeedingMealStatus.SCHEDULED },
          order: { unitId: 'ASC', scheduledAt: 'ASC' },
        }),
        manager.find(FeedingMeal, {
          where: { tenantId, status: FeedingMealStatus.PARTIALLY_FED },
          order: { unitId: 'ASC', scheduledAt: 'ASC' },
        }),
      ]);
      const overdueMissed = missedCandidates.filter((meal) => meal.scheduledAt < cutoff);
      const overduePartials = partialCandidates.filter((meal) => meal.scheduledAt < cutoff);

      // Gün planları + protokoller TOPLU yüklenir (öğün başına sorgu yok).
      const sweepDayPlanIds = [
        ...new Set([...overdueMissed, ...overduePartials].map((meal) => meal.dayPlanId)),
      ];
      const sweepDayPlans = sweepDayPlanIds.length
        ? await manager.find(FeedingDayPlan, {
            where: { tenantId, id: In(sweepDayPlanIds) },
          })
        : [];
      const dayPlanById = new Map(sweepDayPlans.map((dp) => [dp.id, dp]));
      const sweepProtocolIds = [...new Set(sweepDayPlans.map((dp) => dp.protocolId))];
      const sweepProtocols = sweepProtocolIds.length
        ? await manager.find(FeedingProtocolV2, {
            where: { tenantId, id: In(sweepProtocolIds) },
          })
        : [];
      const sweepProtocolById = new Map(sweepProtocols.map((p) => [p.id, p]));

      /**
       * per_meal modda bayat kısmi finalize BÜYÜME UYGULAR (FARM-MEDIUM-227):
       * growthKg = actualKg / snapshot.expectedFcr — recordMealFeeding
       * finalize'ıyla AYNI hesap ve provenans. daily mod rollup'a (c) kalır;
       * çift uygulama imkânsız (mod başına tek yol).
       */
      const needsPerMealGrowth = (meal: FeedingMeal): boolean => {
        const dayPlan = dayPlanById.get(meal.dayPlanId);
        if (!dayPlan) return false;
        // Mod PLANIN kolonundan (FARM-CRITICAL-244) — protokol ayarı sonradan
        // değişse bile bayat finalize üretildiği semantikle işlenir.
        return (
          dayPlan.growthApplicationMode !== 'daily' &&
          Number(meal.actualKg) > 0 &&
          dayPlan.snapshot.expectedFcr > 0
        );
      };

      const sweepUnitIds = [
        ...new Set([...overdueMissed, ...overduePartials].map((meal) => meal.unitId)),
      ].sort();
      for (const unitId of sweepUnitIds) {
        const unitMissed = overdueMissed.filter((meal) => meal.unitId === unitId);
        const unitPartials = overduePartials.filter((meal) => meal.unitId === unitId);

        // Kanonik kilit sırası (FARM-MEDIUM-276): ünite kilidi öğün
        // yazımlarından ÖNCE, büyüme gerekip gerekmediğine BAKILMADAN alınır.
        // Eski hâl `growthMeals.length > 0` iken kilit alıyordu; daily modda
        // bu koşul her zaman false olduğundan öğün satırları KİLİTSİZ
        // yazılıyor, ardından aynı transaction'ın rollup adımı aynı ünitenin
        // Batch kilidini istiyordu — sıra ihlali yapısaldı.
        const locked = await this.growthApplier.lockUnitForGrowth(manager, tenantId, unitId);

        // (a) Hiç döküm görmemiş, penceresi geçmiş öğünler → missed + event.
        for (const meal of unitMissed) {
          meal.status = FeedingMealStatus.MISSED;
          await manager.save(meal);
          const event: MealMissedEvent = {
            ...createBaseEvent<MealMissedEvent>('MealMissed', tenantId, {
              aggregateId: meal.id,
              aggregateType: 'FeedingMeal',
            }),
            unitId: meal.unitId,
            unitCode: dayPlanById.get(meal.dayPlanId)?.unitCode ?? '',
            mealId: meal.id,
            dayPlanId: meal.dayPlanId,
            scheduledAt: toEventIso(meal.scheduledAt),
          };
          await this.outboxPublisher.enqueue(event, manager);
        }

        // (b) Bayat partially_fed → otomatik finalize (D-8 pencere kapanışı):
        // varyans hesaplanır; per_meal modda büyüme BURADA uygulanır (yukarıda
        // alınan kanonik kilitle), daily mod rollup'a (c) kalır.
        for (const meal of unitPartials) {
          meal.status = FeedingMealStatus.FED;
          meal.fedAt = new Date();
          meal.varianceKg = round3(Number(meal.actualKg) - Number(meal.plannedKg));
          meal.variancePercent =
            Number(meal.plannedKg) > 0
              ? round3(
                  ((Number(meal.actualKg) - Number(meal.plannedKg)) / Number(meal.plannedKg)) * 100,
                )
              : 0;
          await manager.save(meal);

          if (locked && needsPerMealGrowth(meal)) {
            const expectedFcr = dayPlanById.get(meal.dayPlanId)!.snapshot.expectedFcr;
            await this.growthApplier.applyGrowth(
              manager,
              tenantId,
              locked,
              Number(meal.actualKg) / expectedFcr,
              expectedFcr,
            );
            // Kalan öğünler yeni biomass'tan — `recordMealFeeding` finalize'ı
            // ile SİMETRİ (bayat finalize sessizce farklı davranamaz).
            await this.recalcService.recalcForUnit(manager, tenantId, meal.unitId, 'meal_growth');
          }

          // Az-atım sinyali de simetrik olmalı: pencere kapanışında finalize
          // edilen öğün, operatörün elle kapattığı öğünle aynı eşiği görür —
          // aksi hâlde sistematik az-atım YALNIZ elle kapatılan öğünlerde
          // görünürdü (FARM-MEDIUM-276 ailesi).
          const sweepPlan = dayPlanById.get(meal.dayPlanId);
          const sweepThreshold =
            sweepProtocolById.get(sweepPlan?.protocolId ?? '')?.settings
              .underfeedAlertThresholdPercent ?? 15;
          if (meal.variancePercent !== null && meal.variancePercent < -sweepThreshold) {
            const underfed: MealUnderfedEvent = {
              ...createBaseEvent<MealUnderfedEvent>('MealUnderfed', tenantId, {
                aggregateId: meal.id,
                aggregateType: 'FeedingMeal',
              }),
              scope: 'meal',
              unitId: meal.unitId,
              unitCode: sweepPlan?.unitCode ?? '',
              dayPlanId: meal.dayPlanId,
              mealId: meal.id,
              plannedKg: Number(meal.plannedKg),
              actualKg: Number(meal.actualKg),
              variancePercent: meal.variancePercent,
              thresholdPercent: sweepThreshold,
            };
            await this.outboxPublisher.enqueue(underfed, manager);
          }
        }

        // Plan durumu: süpürme sonrası açık öğün kalmadıysa plan kapanır —
        // eski hâl planı `in_progress`'te asılı bırakıyordu.
        const touchedPlanIds = [
          ...new Set([...unitMissed, ...unitPartials].map((meal) => meal.dayPlanId)),
        ];
        for (const dayPlanId of touchedPlanIds) {
          const openCount = await manager.count(FeedingMeal, {
            where: [
              { dayPlanId, tenantId, status: FeedingMealStatus.SCHEDULED },
              { dayPlanId, tenantId, status: FeedingMealStatus.PARTIALLY_FED },
            ],
          });
          await manager.update(
            FeedingDayPlan,
            { id: dayPlanId, tenantId },
            {
              status:
                openCount === 0 ? FeedingDayPlanStatus.COMPLETED : FeedingDayPlanStatus.IN_PROGRESS,
            },
          );
        }
      }

      // (c) DAILY-mod rollup — KÜMÜLATİF MUTABAKAT (FARM-CRITICAL-244).
      //
      // Mod planın KENDİ kolonundan okunur (protokolün o anki ayarından
      // DEĞİL): ayar değişimi geçmiş planların büyümesini ne çift saydırabilir
      // ne kaybettirebilir. Aday predikatı "damga boş mu" değil
      // "uygulanan kg gün toplamından farklı mı" — geç finalize edilen öğün ve
      // `correctMealPour` deltası bir sonraki koşuda YAPISAL olarak yakalanır.
      //
      // Alt tarih sınırı + LIMIT: tek koşuda 24 aylık tarama operasyonel risk
      // (mod değişimi senaryosunun asıl patlama yarıçapı buydu).
      const pendingRollups: Array<{
        id: string;
        unitId: string;
        expectedFcr: number;
        appliedKg: number;
        totalActualKg: number;
      }> = await manager.query(
        `SELECT dp.id,
                dp."unitId",
                (dp.snapshot->>'expectedFcr')::numeric AS "expectedFcr",
                dp."rollupAppliedKg"::numeric          AS "appliedKg",
                t.total                                AS "totalActualKg"
           FROM "feeding_day_plans" dp
           CROSS JOIN LATERAL (
             SELECT COALESCE(SUM(m."actualKg"), 0) AS total
               FROM "feeding_meals" m
              WHERE m."tenantId" = dp."tenantId" AND m."dayPlanId" = dp.id
           ) t
          WHERE dp."tenantId" = $1
            AND dp."growthApplicationMode" = 'daily'
            AND dp.status IN ('in_progress', 'completed')
            AND dp."planDate" < CURRENT_DATE
            AND dp."planDate" >= CURRENT_DATE - ($2 || ' days')::interval
            AND dp."rollupAppliedKg"::numeric <> t.total
          ORDER BY dp."unitId" ASC
          LIMIT $3`,
        [tenantId, String(ROLLUP_LOOKBACK_DAYS), ROLLUP_BATCH_LIMIT],
      );

      for (const plan of pendingRollups) {
        const totalActualKg = Number(plan.totalActualKg) || 0;
        const expectedFcr = Number(plan.expectedFcr) || 0;
        const { deltaKg, growthKg, applicable } = computeRollupDelta({
          totalActualKg,
          appliedKg: Number(plan.appliedKg) || 0,
          expectedFcr,
        });

        if (!applicable) {
          // FCR çözülemeyen planın büyümesi hesaplanamaz; damga BASILMAZ ki
          // düzeltildiğinde tekrar aday olsun (sessiz kayıp yok).
          this.logger.warn(
            `DAILY rollup skipped for day plan ${plan.id}: expectedFcr missing/zero (unit ${plan.unitId}).`,
          );
          continue;
        }
        if (deltaKg !== 0) {
          const locked = await this.growthApplier.lockUnitForGrowth(manager, tenantId, plan.unitId);
          if (!locked) {
            // Ünite boşalmış/kilitlenemiyor: damga BASILMAZ (eski davranış
            // basıyordu ve büyüme sessizce kayboluyordu — FARM-MEDIUM-289).
            this.logger.warn(
              `DAILY rollup deferred for day plan ${plan.id}: unit ${plan.unitId} not lockable.`,
            );
            continue;
          }
          await this.growthApplier.applyGrowth(manager, tenantId, locked, growthKg, expectedFcr);
        }
        await manager.query(
          `UPDATE "feeding_day_plans"
              SET "rollupAppliedKg" = $3,
                  "rollupGrowthKg" = "rollupGrowthKg"::numeric + $4,
                  "rollupLastRunAt" = now(),
                  "rollupAppliedAt" = COALESCE("rollupAppliedAt", now())
            WHERE "tenantId" = $1 AND id = $2`,
          [tenantId, plan.id, totalActualKg, growthKg],
        );
      }
    });
  }

  // ==========================================================================
  // 20:00 — GÜNLÜK ÖZET + GÜN-SEVİYESİ AZ-ATIM (D-16)
  // ==========================================================================

  @Cron('0 20 * * *', { name: 'feeding-v2-daily-summary', timeZone: 'Europe/Istanbul' })
  async dailySummary(): Promise<void> {
    await this.runExclusive('feeding-v2-daily-summary', async () => {
      const tenants = await this.activeTenants();
      for (const tenantId of tenants) {
        try {
          await this.summarizeTenant(tenantId);
        } catch (error) {
          this.logger.error(
            `Daily summary failed for tenant ${tenantId}: ${(error as Error).message}`,
          );
        }
      }
    });
  }

  async summarizeTenant(tenantId: string): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
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
                (SELECT COALESCE(SUM(m."actualKg"), 0) FROM "feeding_meals" m WHERE m."dayPlanId" = dp.id) AS "actualKg",
                (SELECT COUNT(*) FROM "feeding_meals" m WHERE m."dayPlanId" = dp.id AND m.status = 'missed') AS "missedCount",
                (p.settings->>'underfeedAlertThresholdPercent')::numeric AS "thresholdPercent"
         FROM "feeding_day_plans" dp
         LEFT JOIN "feeding_protocols_v2" p ON p.id = dp."protocolId"
         WHERE dp."tenantId" = $1 AND dp."planDate" = CURRENT_DATE`,
        [tenantId],
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
        const threshold = row.thresholdPercent ?? 15;
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
    });
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
  @Cron('0 7 * * *', { name: 'feeding-v2-stock-coverage', timeZone: 'Europe/Istanbul' })
  async stockCoverageSweep(): Promise<void> {
    await this.runExclusive('feeding-v2-stock-coverage', async () => {
      const tenants = await this.tenantsWithActiveBatches();
      for (const tenantId of tenants) {
        try {
          await this.forecastService.refreshTenant(tenantId, { emitCoverageEvents: true });
        } catch (error) {
          this.logger.error(
            `Stock coverage sweep failed for tenant ${tenantId}: ${(error as Error).message}`,
          );
        }
      }
    });
  }

  @Cron('0 18 * * *', { name: 'feeding-v2-fcr-alerts', timeZone: 'Europe/Istanbul' })
  async fcrAlertSweep(): Promise<void> {
    await this.runExclusive('feeding-v2-fcr-alerts', async () => {
      // Batch-scoped sinyal: keşif aktif ATAMALARA değil aktif BATCH'lere
      // bakar — v2 ataması olmayan batch tenant'ları legacy job Faz 6'da
      // kapandığında sessizce alertsiz kalamaz.
      const tenants = await this.tenantsWithActiveBatches();
      for (const tenantId of tenants) {
        try {
          await this.sweepFcrForTenant(tenantId);
        } catch (error) {
          this.logger.error(
            `FCR alert sweep failed for tenant ${tenantId}: ${(error as Error).message}`,
          );
        }
      }
    });
  }

  async sweepFcrForTenant(tenantId: string): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const rows: Array<{ id: string; actual: string | number | null }> = await manager.query(
        `SELECT b.id, (b.fcr->>'actual')::numeric AS actual
           FROM "batches_v2" b
          WHERE b."tenantId" = $1
            AND b."isActive" = true
            AND b.status IN ('ACTIVE', 'GROWING')
            AND (b.fcr->>'actual')::numeric > 0`,
        [tenantId],
      );

      for (const row of rows) {
        const currentFCR = Number(row.actual);
        // Hedef + trend okumaları withTenantContext ALS çerçevesi içinde koşar
        // (runInTenantTransaction sarmalar) — repo checkout'ları tenant
        // şemasına yönlenir. Trend yalnız eşiği aşan batch'ler için sorgulanır.
        const targetFCR = await this.fcrCalculation.getTargetFCRForBatch(row.id);
        if (!targetFCR || targetFCR <= 0) continue;

        const variancePercent = ((currentFCR - targetFCR) / targetFCR) * 100;
        if (variancePercent <= FCR_WARNING_VARIANCE_PERCENT) continue;

        const alertLevel: FCRAlertEvent['alertLevel'] =
          variancePercent > FCR_CRITICAL_VARIANCE_PERCENT ? 'critical' : 'warning';
        const { trend } = await this.fcrCalculation.analyzeFCRTrend(row.id, tenantId);

        const event: FCRAlertEvent = {
          ...createBaseEvent<FCRAlertEvent>('FCRAlert', tenantId, {
            aggregateId: row.id,
            aggregateType: 'Batch',
          }),
          batchId: row.id,
          currentFCR: round3(currentFCR),
          targetFCR: round3(targetFCR),
          variancePercent: round3(variancePercent),
          trend,
          alertLevel,
        };
        await this.outboxPublisher.enqueue(event, manager);
      }
    });
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
   * katmandır (NFR). Ayın 1'i 04:00 Istanbul; advisory-lock tek instance.
   */
  @Cron('0 4 1 * *', { name: 'feeding-v2-retention', timeZone: 'Europe/Istanbul' })
  async retentionCleanup(): Promise<void> {
    await this.runExclusive('feeding-v2-retention', async () => {
      const tenants = await this.tenantsForRetention();
      for (const tenantId of tenants) {
        try {
          await this.purgeTenantRetention(tenantId);
        } catch (error) {
          this.logger.error(
            `Retention cleanup failed for tenant ${tenantId}: ${(error as Error).message}`,
          );
        }
      }
    });
  }

  async purgeTenantRetention(tenantId: string): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      // Önce öğünler (plan join'i üzerinden) — soft-ref sıra bağımsızlığına
      // rağmen bu sıra, yarıda kesilen bir koşunun öksüz öğün bırakmasını
      // yapısal olarak önler.
      const meals: Array<{ count: number }> = await manager.query(
        `WITH deleted AS (
           DELETE FROM "feeding_meals" m
            USING "feeding_day_plans" dp
            WHERE m."dayPlanId" = dp.id
              AND dp."tenantId" = $1
              AND dp."planDate" < (CURRENT_DATE - INTERVAL '${DAY_PLAN_RETENTION_MONTHS} months')
           RETURNING 1
         ) SELECT COUNT(*)::int AS count FROM deleted`,
        [tenantId],
      );
      const plans: Array<{ count: number }> = await manager.query(
        `WITH deleted AS (
           DELETE FROM "feeding_day_plans"
            WHERE "tenantId" = $1
              AND "planDate" < (CURRENT_DATE - INTERVAL '${DAY_PLAN_RETENTION_MONTHS} months')
           RETURNING 1
         ) SELECT COUNT(*)::int AS count FROM deleted`,
        [tenantId],
      );
      const receipts: Array<{ count: number }> = await manager.query(
        `WITH deleted AS (
           DELETE FROM "farm_mobile_command_receipts"
            WHERE "tenantId" = $1
              AND "createdAt" < (now() - INTERVAL '${RECEIPT_RETENTION_DAYS} days')
           RETURNING 1
         ) SELECT COUNT(*)::int AS count FROM deleted`,
        [tenantId],
      );

      const purged = {
        meals: Number(meals[0]?.count ?? 0),
        dayPlans: Number(plans[0]?.count ?? 0),
        receipts: Number(receipts[0]?.count ?? 0),
      };
      if (purged.meals + purged.dayPlans + purged.receipts > 0) {
        this.logger.log(
          `Retention purge: ${purged.meals} meals, ${purged.dayPlans} day plans, ` +
            `${purged.receipts} receipts removed (tenant ${tenantId.substring(0, 8)}...)`,
        );
      }
    });
  }

  // ==========================================================================
  // ORTAK YARDIMCILAR
  // ==========================================================================

  /**
   * Retention keşfi: day plan VEYA makbuz taşıyan tüm tenant'lar — aktif
   * atama/batch filtreleri retention için fazla dar olurdu (tarihsel veri,
   * atamaları biten tenant'ta da yaşar).
   */
  private async tenantsForRetention(): Promise<string[]> {
    const tenantSchemas = await listTenantSchemas(this.dataSource);
    const tenantIds = new Set<string>();
    for (const schema of tenantSchemas) {
      const runner = this.dataSource.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}", farm, public`);
        const rows: Array<{ tenantId: string }> = await runner.query(
          `SELECT DISTINCT "tenantId" FROM "feeding_day_plans"
           UNION
           SELECT DISTINCT "tenantId" FROM "farm_mobile_command_receipts"`,
        );
        for (const row of rows) tenantIds.add(row.tenantId);
      } catch (error) {
        this.logger.warn(
          `Tenant discovery failed for schema ${schema}: ${(error as Error).message}`,
        );
      } finally {
        await runner.release();
      }
    }
    return [...tenantIds];
  }

  /**
   * Aktif batch'i olan tenant'lar — 18:00 FCR süpürmesinin keşif kümesi
   * (batch-scoped; `activeTenants`'ın atama filtresinden bilinçli olarak
   * geniş). Legacy analyzeFCR'ın keşif sorgusuyla birebir.
   */
  private async tenantsWithActiveBatches(): Promise<string[]> {
    const tenantSchemas = await listTenantSchemas(this.dataSource);
    const tenantIds = new Set<string>();
    for (const schema of tenantSchemas) {
      const runner = this.dataSource.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}", farm, public`);
        const rows: Array<{ tenantId: string }> = await runner.query(
          `SELECT DISTINCT "tenantId" FROM "batches_v2" WHERE "isActive" = true`,
        );
        for (const row of rows) tenantIds.add(row.tenantId);
      } catch (error) {
        this.logger.warn(
          `Tenant discovery failed for schema ${schema}: ${(error as Error).message}`,
        );
      } finally {
        await runner.release();
      }
    }
    return [...tenantIds];
  }

  /**
   * Aktif v2 ataması olan tenant'lar — v1 cron'un keşif deseni:
   * `listTenantSchemas` + şema başına kısa ömürlü discovery runner'ı
   * (search_path pinli). Asıl iş `runInTenantTransaction` içinde koşar.
   */
  private async activeTenants(): Promise<string[]> {
    const tenantSchemas = await listTenantSchemas(this.dataSource);
    const tenantIds = new Set<string>();
    for (const schema of tenantSchemas) {
      const runner = this.dataSource.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}", farm, public`);
        const rows: Array<{ tenantId: string }> = await runner.query(
          `SELECT DISTINCT "tenantId" FROM feeding_protocol_assignments WHERE status = 'active'`,
        );
        for (const row of rows) tenantIds.add(row.tenantId);
      } catch (error) {
        this.logger.warn(
          `Tenant discovery failed for schema ${schema}: ${(error as Error).message}`,
        );
      } finally {
        await runner.release();
      }
    }
    return [...tenantIds];
  }

  private async siteTimezones(
    manager: EntityManager,
    tenantId: string,
  ): Promise<Map<string, string>> {
    const rows: Array<{ id: string; timezone: string | null }> = await manager.query(
      `SELECT id, timezone FROM "sites" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return new Map(rows.map((row) => [row.id, row.timezone || 'UTC']));
  }

  private getAdvisoryLockKey(jobName: string): number {
    const hash = crypto.createHash('sha256').update(jobName).digest();
    return hash.readInt32LE(0);
  }

  /** v1 makinesiyle aynı disiplin: session-scoped kilit, edinen bağlantıda yaşar. */
  private async runExclusive(jobName: string, job: () => Promise<void>): Promise<void> {
    const lockKey = this.getAdvisoryLockKey(jobName);
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    let acquired = false;
    try {
      const result: Array<{ acquired: boolean }> = await runner.query(
        `SELECT pg_try_advisory_lock($1, $2) as acquired`,
        [ADVISORY_LOCK_NAMESPACE, lockKey],
      );
      acquired = result[0]?.acquired === true;
      if (!acquired) {
        this.logger.log(`Another instance runs ${jobName}; skipping.`);
        return;
      }
      this.advisoryLockRunners.set(jobName, runner);
      await job();
    } finally {
      if (acquired) {
        this.advisoryLockRunners.delete(jobName);
        try {
          await runner.query(`SELECT pg_advisory_unlock($1, $2)`, [
            ADVISORY_LOCK_NAMESPACE,
            lockKey,
          ]);
        } finally {
          await runner.release();
        }
      } else {
        await runner.release();
      }
    }
  }
}
