/**
 * FeedingCronV2Service — öğün motorunun zamanlanmış işleri (Faz 5 + W5).
 *
 * ## Zamanlama mimarisi (W5 — FARM-LOW-264, kullanıcı kararı 3)
 *
 * Gün semantiği taşıyan işler artık SABİT bir zon altında (`Europe/Istanbul`)
 * koşmaz. Tek bir **saatlik UTC tick'i** her tenant için yerel saati
 * `FeedingClockService` ile çözer ve iş saati geldiğinde
 * `feeding_job_runs`'a bir claim yazar; claim `(tenantId, jobName, localDate)`
 * UNIQUE kısıtına çarptığı için "tenant'ın yerel gününde tam bir kez"
 * garantisi DB tarafındadır (DST'de saatin tekrarlandığı gece de dahil).
 * Başarısız veya sayfalama yüzünden yarım kalan koşu `succeeded` olmaz ve
 * bir sonraki tick devam eder — sessiz gün kaybı yok.
 *
 * | Yerel saat | İş                                                          |
 * |------------|-------------------------------------------------------------|
 * | 05:00 | Sabah süpürmesi: dünün beslenmemiş öğünleri `missed` (+event),  |
 * |       | bayat partially_fed finalize (D-8), DAILY growth rollup —       |
 * |       | ünite gruplu, kanonik kilit sırası (K-1)                        |
 * | 06:00 | Day plan + öğün üretimi (idempotent) + plansız-ünite tespiti    |
 * |       | (UnfedUnitDetected, D-5)                                        |
 * | 07:00 | Stok kapsama süpürmesi — forecast snapshot yenileme (K-10)      |
 * | 18:00 | FCR alert süpürmesi — durable FCRAlert (C-1)                    |
 * | 20:00 | FeedingDailySummary + gün-seviyesi az-atım (D-16)               |
 *
 * Gün semantiği OLMAYAN iki iş zon çözümüne ihtiyaç duymaz ve sabit kalır:
 * 15 dk'lık öğün penceresi süpürmesi (timestamptz karşılaştırır; ayrıca
 * sensör sıcaklık sapmasında gün-içi yeniden fiyatlama yapar) ve aylık
 * retention temizliği (UTC).
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
import { BiomassGrowthApplierService } from './biomass-growth-applier.service';
import {
  WaterTemperatureService,
  type EffectiveTemperature,
} from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { calendarDayIn, isMealOverdue, MEAL_OVERDUE_GRACE_MINUTES } from './meal-schedule.util';
import { FeedingClock, FeedingClockService } from './feeding-clock.service';
import { DEFAULT_TENANT_TIMEZONE } from '../entities/tenant-localization.entity';
import { FeedingJobRunService } from './feeding-job-run.service';
import { collectFeedSourceFeedIds, buildFeedFcrMatrixMap } from './feed-fcr-source.util';
import { ProtocolFeedForecastService } from './protocol-feed-forecast.service';
import { DayPlanRecalcService } from './day-plan-recalc.service';
import { MealFinalizationService } from './meal-finalization.service';
import { round3 } from '../../common/utils/rounding.util';

const ADVISORY_LOCK_NAMESPACE = 0x46454544; // 'FEED'
const ASSIGNMENT_PAGE_SIZE = 200;
/** K-2 kanonik cap — schema validator ile aynı sabit. */
export const MEAL_WINDOW_MAX_ENTRIES = 500;
const MEAL_WINDOW_LEAD_MINUTES = 60;

/**
 * Aynı öğün için iki bildirim arasındaki en kısa süre (dk) — 15 dk'lık cron
 * cadence'ıyla EŞİT, yani tick başına en fazla bir bildirim (FARM-MEDIUM-271).
 *
 * `windowNotifiedAt` kalıcı bir "bir daha asla" damgası DEĞİLDİR. Öğün 60 dk'lık
 * kurşun penceresinde dört tick boyunca durur ve hem teslim-semantiği kaydı
 * (`MealWindowUpcoming: 'reproducible'`) hem 1807500000000'in docblock'u pencere
 * içinde yeniden üretildiğini SÖYLÜYORDU — sorgu ise `windowNotifiedAt IS NULL`
 * filtresiyle ömür boyu tek bildirim veriyordu. Kaybolan tek bir batch,
 * aeratör ön-takviyesini o öğün için TAMAMEN düşürüyordu.
 *
 * Mutlak `windowStart` yerine "şu kadar dakikadır bildirilmedi" biçiminde
 * yazılır: aynı tick içinde tekrarlanan bir koşu (retry) ikinci kez yaymaz.
 * Event SAYISI artmaz — öğünler zaten batch'leniyor; artan şey, aynı tick
 * event'indeki girdi sayısıdır.
 */
const MEAL_WINDOW_RENOTIFY_MINUTES = 15;
/** Legacy analyzeFCR eşikleri birebir: >%10 warning, >%20 critical. */
const FCR_WARNING_VARIANCE_PERCENT = 10;
const FCR_CRITICAL_VARIANCE_PERCENT = 20;
/** Retention pencereleri (plan §2 tablosu + NFR "Receipt büyümesi", K-16). */
const DAY_PLAN_RETENTION_MONTHS = 24;
const RECEIPT_RETENTION_DAYS = 90;
/**
 * Forecast snapshot ölü-satır penceresi (W6, FARM-LOW-266/296).
 *
 * Canlı kapsam budaması her yenilemede `pruneScopes` ile yapılır; bu pencere
 * yalnız ARTIK YENİLENMEYEN satırlar içindir — son ataması kalkmış, sitesi
 * silinmiş ya da tenant'ı emekli olmuş kapsamlar. 30 gün, günlük hesaplanan
 * bir satır için "bir daha koşmadı" demeye fazlasıyla yeter.
 */
const FORECAST_SNAPSHOT_RETENTION_DAYS = 30;
/**
 * DAILY rollup taraması (FARM-CRITICAL-244): alt tarih sınırı + koşu başına
 * tavan. Sınırsız tarama, mod değişimi senaryosunda 24 aylık planı tek koşuda
 * işleyip biyokütleyi katlayan patlama yarıçapının kendisiydi. Geç finalize
 * penceresi (öğün + düzeltme) günler mertebesinde; 35 gün fazlasıyla yeterli.
 */
const ROLLUP_LOOKBACK_DAYS = 35;
const ROLLUP_BATCH_LIMIT = 500;
/**
 * Sabah süpürmesinin koşu başına öğün tavanı (FARM-MEDIUM-290). Eski hâl
 * tenant'ın TÜM açık öğünlerini belleğe alıp cutoff'u JS'te uyguluyordu;
 * 1000 üniteli bir tenant'ın birikmiş öğünleri tek koşuda heap'e çekiliyordu.
 * Tavan aşıldığında koşu `succeeded` DAMGALANMAZ — bir sonraki saatlik tick
 * kalanı boşaltır (sessiz kırpma yok).
 */
const SWEEP_BATCH_LIMIT = 1000;

/**
 * Sensör sıcaklığındaki gün-içi sapmanın plan yeniden fiyatlaması eşiği
 * (keşif-7 / FARM-MEDIUM-294 varsayılanı). Protokol `settings
 * .temperatureRecalcThresholdC` ile ezilebilir.
 */
const DEFAULT_TEMPERATURE_RECALC_THRESHOLD_C = 1.5;
/** Aynı ünite için gün-içi sıcaklık recalc'ının asgari aralığı. */
const TEMPERATURE_RECALC_COOLDOWN_MINUTES = 60;

/**
 * Yerel saat tablosu — gün semantiği taşıyan işlerin TEK zamanlama SSoT'si
 * (W5). Saatlik tick bu tabloyu tenant'ın yerel saatiyle karşılaştırır.
 *
 * Yarım/çeyrek saatlik offsetli zonlarda (ör. Asia/Kolkata +05:30) tick
 * yerel :30'da düşer; `localHour` yine 5'tir, yani iş yerel 05:30'da koşar —
 * kabul edilmiş ve belgelenmiş davranış.
 */
export const FEEDING_JOB_SCHEDULE = [
  { name: 'morning-sweep', localHour: 5 },
  { name: 'generate-day-plans', localHour: 6 },
  { name: 'stock-coverage', localHour: 7 },
  { name: 'fcr-alerts', localHour: 18 },
  { name: 'daily-summary', localHour: 20 },
] as const;

export type FeedingJobName = (typeof FEEDING_JOB_SCHEDULE)[number]['name'];

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
    // Sıcaklık sapmasında ve telafi dağıtımında kalan öğünleri yeniden
    // fiyatlar. (Bayat finalize'ın recalc'ı artık `finalization` içinde —
    // operatör yoluyla aynı gövde.)
    private readonly recalcService: DayPlanRecalcService,
    // Öğün kapatma + plan durumu tek gövde (FARM-MEDIUM-276): pencere
    // kapanışında kapatılan öğün, operatörün kapattığıyla aynı koddan geçer.
    private readonly finalization: MealFinalizationService,
    // Takvim/saat çözümünün TEK sahibi (W5, D-B4).
    private readonly clock: FeedingClockService,
    // "Yerel günde tam bir kez" claim'i (W5).
    private readonly jobRuns: FeedingJobRunService,
  ) {}

  // ==========================================================================
  // SAATLİK TICK — TENANT-YEREL ZAMANLAMA (W5)
  // ==========================================================================

  /**
   * Tek zamanlayıcı. Her saat başı TÜM tenant'lar için yerel saati çözer ve
   * o saate düşen işleri claim'leyerek koşar. Tenant başına sıralı; advisory
   * lock çok-instance'lı eşzamanlılığı, `feeding_job_runs` ise "bugün zaten
   * koştu"yu ayrı ayrı garanti eder.
   */
  @Cron('0 * * * *', { name: 'feeding-v2-hourly-tick' })
  async hourlyTick(): Promise<void> {
    await this.runExclusive('feeding-v2-hourly-tick', async () => {
      const at = new Date();
      const tenants = await this.feedingTenants();
      const zones = await this.clock.tenantZones(tenants);
      for (const tenantId of tenants) {
        const clock = FeedingClockService.clockIn(
          zones.get(tenantId) ?? DEFAULT_TENANT_TIMEZONE,
          at,
        );
        for (const job of FEEDING_JOB_SCHEDULE) {
          if (job.localHour !== clock.localHour) continue;
          await this.runTenantJob(tenantId, job.name, clock);
        }
      }
    });
  }

  /** Claim → iş → settle. Hata koşuyu KAPATMAZ; bir sonraki tick yeniden dener. */
  private async runTenantJob(
    tenantId: string,
    jobName: FeedingJobName,
    clock: FeedingClock,
  ): Promise<void> {
    const runId = await this.jobRuns.claim(tenantId, jobName, clock.localDate, clock.zone);
    if (!runId) return; // bu yerel gün zaten başarıyla koştu

    const started = Date.now();
    try {
      const complete = await this.runJob(jobName, tenantId, clock);
      await this.jobRuns.settle(runId, complete, complete ? undefined : 'incomplete: page cap hit');
      if (!complete) {
        this.logger.warn(
          `Feeding job ${jobName} incomplete for tenant ${tenantId} (${clock.localDate}); ` +
            'the local-day run stays open and the next hourly tick continues.',
        );
      }
      const elapsed = Date.now() - started;
      if (elapsed > 60_000) {
        // NFR kapasite sinyali: tenant >60sn — ölçek uyarısı, hata değil.
        this.logger.warn(`Feeding job ${jobName} slow for tenant ${tenantId}: ${elapsed}ms`);
      }
    } catch (error) {
      const message = (error as Error).message;
      await this.jobRuns.settle(runId, false, message);
      this.logger.error(`Feeding job ${jobName} failed for tenant ${tenantId}: ${message}`);
    }
  }

  /** İş adı → yürütme. `false` = yarım kaldı (yeniden denenecek). */
  private async runJob(
    jobName: FeedingJobName,
    tenantId: string,
    clock: FeedingClock,
  ): Promise<boolean> {
    switch (jobName) {
      case 'morning-sweep':
        return this.sweepTenant(tenantId, clock);
      case 'generate-day-plans':
        await this.generateForTenant(tenantId);
        return true;
      case 'stock-coverage':
        await this.forecastService.refreshTenant(tenantId, { emitCoverageEvents: true });
        return true;
      case 'fcr-alerts':
        await this.sweepFcrForTenant(tenantId);
        return true;
      case 'daily-summary':
        await this.summarizeTenant(tenantId, clock);
        return true;
    }
  }

  // ==========================================================================
  // 06:00 — GÜN PLANI ÜRETİMİ + D-5 TESPİTİ
  // ==========================================================================

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
    const zones = await this.clock.siteZones(manager, tenantId);

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
        // Zon hiyerarşisi: site kolonu (NULL = devral) → tenant → UTC (D-B4).
        const timezone = zones.zoneOf(assignment.siteId);
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
      const tenants = await this.feedingTenants();
      const windowStart = new Date();
      const windowEnd = new Date(windowStart.getTime() + MEAL_WINDOW_LEAD_MINUTES * 60_000);
      for (const tenantId of tenants) {
        try {
          await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
            const manager = queryRunner.manager;
            // Partial indeks üzerinden okur (status='scheduled'); adaylar HEM
            // hiç bildirilmemiş HEM de bu tick'ten önce bildirilmiş öğünlerdir.
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
                 AND (
                   m."windowNotifiedAt" IS NULL
                   OR m."windowNotifiedAt" < $4::timestamptz
                 )
                 AND m."scheduledAt" >= $2 AND m."scheduledAt" < $3
               ORDER BY m."scheduledAt" ASC`,
              // $4: bu tick'ten önce bildirilmiş öğünler yeniden aday olur —
              // pencere içinde yeniden üretim (FARM-MEDIUM-271). Damga artık
              // "bir daha asla" değil, "son bildirim şu an".
              [
                tenantId,
                windowStart,
                windowEnd,
                new Date(windowStart.getTime() - MEAL_WINDOW_RENOTIFY_MINUTES * 60_000),
              ],
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
              // gelse de yazım yalnız search_path'e güvenemez (FARM-MEDIUM-292).
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

        try {
          await this.temperatureDriftSweep(tenantId);
        } catch (error) {
          this.logger.error(
            `Temperature drift sweep failed for tenant ${tenantId}: ${(error as Error).message}`,
          );
        }
      }
    });
  }

  /**
   * Sensör sıcaklığı → gün-içi yeniden fiyatlama (W5, keşif-7 /
   * FARM-MEDIUM-294).
   *
   * Sıcaklık zincirinin yalnız MANUEL ucu recalc'a bağlıydı: operatör su
   * kalitesi kaydı girince plan yeniden fiyatlanıyor, ama sensör okuması
   * projeksiyona düşerken hiçbir şey olmuyordu. Sensörlü tesiste — yani
   * sıcaklığın gün içinde gerçekten değiştiği tesiste — plan sabahki
   * çarpanla donuyordu.
   *
   * Recalc sıcak yolda (projeksiyon listener'ında) TETİKLENMEZ: her okuma
   * ünite kilidi almak ingest hattını kilitlerdi. Bunun yerine 15 dk'lık
   * süpürme, eşiği aşan sapması olan planları yeniden fiyatlar; `resolution
   * .resolvedAt` damgası cooldown ile idempotency sağlar.
   */
  private async temperatureDriftSweep(tenantId: string): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const rows: Array<{
        unitId: string;
        planTempC: string | number | null;
        resolvedAt: string | null;
        thresholdC: string | number | null;
      }> = await manager.query(
        `SELECT dp."unitId",
                (dp.resolution->>'waterTempC')::numeric        AS "planTempC",
                dp.resolution->>'resolvedAt'                   AS "resolvedAt",
                (p.settings->>'temperatureRecalcThresholdC')::numeric AS "thresholdC"
           FROM "feeding_day_plans" dp
           LEFT JOIN "feeding_protocols_v2" p
             ON p.id = dp."protocolId" AND p."tenantId" = dp."tenantId"
          WHERE dp."tenantId" = $1
            AND dp.status IN ('planned', 'in_progress')`,
        [tenantId],
      );
      if (rows.length === 0) return;

      const temperatures = await this.temperatureService.getEffectiveTemperaturesForUnits(
        tenantId,
        rows.map((row) => row.unitId),
      );
      const now = Date.now();
      for (const row of rows) {
        const effective = temperatures.get(row.unitId);
        // Yalnız SENSÖR kaynağı: manuel giriş kendi yazma yolunda zaten
        // recalc tetikler (ikinci bir tetikleyici çift hesap olurdu).
        if (!effective || effective.source !== 'sensor' || effective.celsius === null) continue;

        const resolvedAt = row.resolvedAt ? Date.parse(row.resolvedAt) : NaN;
        if (
          Number.isFinite(resolvedAt) &&
          now - resolvedAt < TEMPERATURE_RECALC_COOLDOWN_MINUTES * 60_000
        ) {
          continue;
        }
        const planTempC = row.planTempC === null ? null : Number(row.planTempC);
        const threshold = Number(row.thresholdC ?? DEFAULT_TEMPERATURE_RECALC_THRESHOLD_C);
        if (planTempC !== null && Math.abs(effective.celsius - planTempC) < threshold) continue;

        await this.recalcService.recalcForUnit(manager, tenantId, row.unitId, 'temperature', {
          newTemperatureC: effective.celsius,
        });
      }
    });
  }

  // ==========================================================================
  // 05:30 — SABAH SÜPÜRMESİ (missed + bayat partial finalize + DAILY rollup)
  // ==========================================================================

  async sweepTenant(tenantId: string, clock: FeedingClock): Promise<boolean> {
    let complete = true;
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      // Tick'in anı (D-B4): süpürme ve özet AYNI instant'ı paylaşır.
      const at = clock.at;
      // "Kaçırılmışlık" tanımı TEK yerde (`isMealOverdue`) — gün özeti de
      // aynı pencereyi kullanır (FARM-MEDIUM-256).
      const cutoff = new Date(at.getTime() - MEAL_OVERDUE_GRACE_MINUTES * 60_000);

      // (a)+(b) adayları kilitsiz okunur; işlem ÜNİTE gruplu ve unitId-artan
      // sırada koşar (K-1: rollup ile aynı yön). Growth kilidi gereken ünitede
      // Batch → TankBatch kilidi, o ünitenin HERHANGİ bir meal yazımından ÖNCE
      // alınır — meal-satırı-önce/kilit-sonra AB-BA penceresi yapısal kapalı.
      //
      // Cutoff + sayfa tavanı DB TARAFINDA (FARM-MEDIUM-290): tenant'ın tüm
      // açık öğünleri belleğe alınmaz.
      const [overdueMissed, overduePartials] = await Promise.all([
        this.loadOverdueMeals(manager, tenantId, FeedingMealStatus.SCHEDULED, cutoff),
        this.loadOverdueMeals(manager, tenantId, FeedingMealStatus.PARTIALLY_FED, cutoff),
      ]);
      if (
        overdueMissed.length >= SWEEP_BATCH_LIMIT ||
        overduePartials.length >= SWEEP_BATCH_LIMIT
      ) {
        complete = false;
        this.logger.warn(
          `Morning sweep hit the ${SWEEP_BATCH_LIMIT}-meal page cap for tenant ${tenantId} ` +
            `(${clock.localDate}); the remainder drains on the next hourly tick.`,
        );
      }

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
        const missedKgByPlan = new Map<string, number>();
        for (const meal of unitMissed) {
          meal.status = FeedingMealStatus.MISSED;
          await manager.save(meal);
          missedKgByPlan.set(
            meal.dayPlanId,
            (missedKgByPlan.get(meal.dayPlanId) ?? 0) + Number(meal.plannedKg),
          );
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

        // W5 (kullanıcı kararı 3): kaçan öğünün kg'ı kalan öğünlere OTOMATİK
        // dağıtılmaz. Tenant açıkça telafi yüzdesi tanımladıysa yalnız o kadarı
        // dağıtılır — varsayılan 0'da bu çağrı hiçbir şeyi değiştirmez.
        for (const [dayPlanId, missedKg] of missedKgByPlan) {
          const plan = dayPlanById.get(dayPlanId);
          if (plan) {
            await this.recalcService.applyMissedCatchUp(manager, tenantId, plan, missedKg);
          }
        }

        // (b) Bayat partially_fed → otomatik finalize (D-8 pencere kapanışı).
        //
        // Gövde BURADA DEĞİL (FARM-MEDIUM-276): varyans, per_meal büyüme,
        // kalan-öğün recalc'ı ve az-atım eşiği operatörün elle kapattığı
        // öğünle AYNI koddan geçer. Bunu eskiden bir kopya + "SİMETRİ" yorumu
        // sağlıyordu; yorum iki gövdenin aynı kalacağını garanti etmez ve
        // etmemişti de — eşiğin `?? 15` varsayılanı iki ayrı ifadedeydi.
        for (const meal of unitPartials) {
          const sweepPlan = dayPlanById.get(meal.dayPlanId);
          if (!sweepPlan) continue;
          const mealPersisted = await this.finalization.finalize(manager, {
            tenantId,
            dayPlan: sweepPlan,
            meal,
            locked,
            // Tick'in anı (D-B4). Eski kopya öğün başına `new Date()`
            // çağırıyordu — aynı süpürmede kapatılan öğünler farklı
            // saniyelere damgalanıyor, saat SSoT'sinden de sapıyordu.
            finalizedAt: at,
            // Pencere kapandı; kimse kapatmadı — `fedBy` boş kalır.
            fedBy: null,
            protocol: sweepProtocolById.get(sweepPlan.protocolId) ?? null,
          });
          if (!mealPersisted) await manager.save(meal);
        }

        // Plan durumu: süpürme sonrası açık öğün kalmadıysa plan kapanır —
        // eski hâl planı `in_progress`'te asılı bırakıyordu. Karar aynı
        // servisten: kopyası koşulsuz UPDATE atıyordu.
        const touchedPlanIds = [
          ...new Set([...unitMissed, ...unitPartials].map((meal) => meal.dayPlanId)),
        ];
        for (const dayPlanId of touchedPlanIds) {
          const plan = dayPlanById.get(dayPlanId);
          if (plan) {
            await this.finalization.settleDayPlanStatus(manager, tenantId, plan);
          }
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
                (dp.resolution->>'expectedFcr')::numeric AS "expectedFcr",
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
            AND dp."planDate" < $2::date
            AND dp."planDate" >= ($2::date - ($3 || ' days')::interval)
            AND dp."rollupAppliedKg"::numeric <> t.total
          ORDER BY dp."unitId" ASC
          LIMIT $4`,
        // Gün sınırı TENANT'IN YEREL günüdür (D-B4). `CURRENT_DATE` DB
        // oturumunun (UTC) günüydü: UTC'nin doğusundaki tenant'ta dünün planı
        // sabah süpürmesinde henüz "geçmiş gün" sayılmıyor, batıdakinde ise
        // bugünün planı erken rollup'lanıyordu.
        [tenantId, clock.localDate, String(ROLLUP_LOOKBACK_DAYS), ROLLUP_BATCH_LIMIT],
      );
      if (pendingRollups.length >= ROLLUP_BATCH_LIMIT) {
        complete = false;
        this.logger.warn(
          `DAILY rollup hit the ${ROLLUP_BATCH_LIMIT}-plan page cap for tenant ${tenantId}; ` +
            'the remainder drains on the next hourly tick.',
        );
      }

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
    return complete;
  }

  /**
   * Penceresi geçmiş öğünler — cutoff ve sayfa tavanı DB tarafında
   * (FARM-MEDIUM-290). Sıralama unitId-artan: süpürme ünite gruplu ve
   * rollup ile AYNI yönde ilerler (K-1).
   */
  private async loadOverdueMeals(
    manager: EntityManager,
    tenantId: string,
    status: FeedingMealStatus,
    cutoff: Date,
  ): Promise<FeedingMeal[]> {
    return manager
      .createQueryBuilder(FeedingMeal, 'meal')
      .where('meal.tenantId = :tenantId', { tenantId })
      .andWhere('meal.status = :status', { status })
      .andWhere('meal.scheduledAt < :cutoff', { cutoff })
      .orderBy('meal.unitId', 'ASC')
      .addOrderBy('meal.scheduledAt', 'ASC')
      .take(SWEEP_BATCH_LIMIT)
      .getMany();
  }

  // ==========================================================================
  // 20:00 — GÜNLÜK ÖZET + GÜN-SEVİYESİ AZ-ATIM (D-16)
  // ==========================================================================

  async summarizeTenant(tenantId: string, clock: FeedingClock): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const at = clock.at;
      const rows: Array<{
        id: string;
        unitId: string;
        unitCode: string;
        planDate: string;
        status: FeedingDayPlanStatus;
        plannedTotalKg: string | number;
        unplannedActualKg: string | number;
        actualKg: string | number | null;
        thresholdPercent: number | null;
      }> = await manager.query(
        // `planDate` TENANT'IN YEREL günü (D-B4); `CURRENT_DATE` DB oturumunun
        // (UTC) günüydü ve UTC'nin doğusundaki tenant akşam özetinde YARININ
        // (henüz boş) planlarını, batısındaki DÜNÜN planlarını raporluyordu.
        //
        // `cancelled` planlar HARİÇ (FARM-MEDIUM-256): tam hasat edilen tankın
        // iptal edilmiş planı her akşam "%100 az beslendi" alarmı üretiyordu.
        `SELECT dp.id, dp."unitId", dp."unitCode", dp."planDate", dp.status,
                dp."plannedTotalKg", dp."unplannedActualKg",
                (SELECT COALESCE(SUM(m."actualKg"), 0) FROM "feeding_meals" m
                  WHERE m."tenantId" = dp."tenantId" AND m."dayPlanId" = dp.id) AS "actualKg",
                (p.settings->>'underfeedAlertThresholdPercent')::numeric AS "thresholdPercent"
         FROM "feeding_day_plans" dp
         LEFT JOIN "feeding_protocols_v2" p
           ON p.id = dp."protocolId" AND p."tenantId" = dp."tenantId"
         WHERE dp."tenantId" = $1
           AND dp."planDate" = $2::date
           AND dp.status <> 'cancelled'`,
        [tenantId, clock.localDate],
      );
      if (rows.length === 0) return;

      // Kaçırılmışlık DAMGADAN değil ZAMANDAN türetilir (FARM-MEDIUM-256):
      // `missed` damgasını ertesi sabahki süpürme bastığı için akşam özetinde
      // sayaç YAPISAL OLARAK her zaman 0 çıkıyor, operatör "bugün hiç öğün
      // kaçmadı" raporu alıyordu. Süpürme ve özet artık AYNI saf yardımcıyı
      // (`isMealOverdue`) kullanır.
      const openMeals: Array<{ scheduledAt: Date; status: FeedingMealStatus }> =
        await manager.query(
          `SELECT m."scheduledAt", m.status
             FROM "feeding_meals" m
             JOIN "feeding_day_plans" dp
               ON dp.id = m."dayPlanId" AND dp."tenantId" = m."tenantId"
            WHERE m."tenantId" = $1
              AND dp."planDate" = $2::date
              AND dp.status <> 'cancelled'
              AND m.status IN ('scheduled', 'missed')`,
          [tenantId, clock.localDate],
        );
      const missedMeals = openMeals.filter(
        (meal) =>
          meal.status === FeedingMealStatus.MISSED ||
          isMealOverdue({ scheduledAt: meal.scheduledAt }, at),
      ).length;

      let plannedTotal = 0;
      let actualTotal = 0;
      let completed = 0;
      let skipped = 0;
      let underfedUnits = 0;

      for (const row of rows) {
        const planned = Number(row.plannedTotalKg);
        const actual = Number(row.actualKg ?? 0) + Number(row.unplannedActualKg ?? 0);
        plannedTotal += planned;
        actualTotal += actual;
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
        planDate: clock.localDate,
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

      if (rows.length === 0) return;

      // TOPLU hedef + TOPLU trend (FARM-LOW-291): eskiden batch BAŞINA iki
      // ek round-trip atılıyordu; 400 batch'lik bir tenant süpürmesi 800+
      // sorgu demekti. Okumalar withTenantContext ALS çerçevesi içinde koşar
      // (runInTenantTransaction sarmalar) — repo checkout'ları tenant
      // şemasına yönlenir.
      const targets = await this.fcrCalculation.getTargetFCRForBatches(
        tenantId,
        rows.map((row) => row.id),
      );

      const alerting = rows
        .map((row) => {
          const currentFCR = Number(row.actual);
          const targetFCR = targets.get(row.id) ?? 0;
          if (!targetFCR || targetFCR <= 0) return null;
          const variancePercent = ((currentFCR - targetFCR) / targetFCR) * 100;
          if (variancePercent <= FCR_WARNING_VARIANCE_PERCENT) return null;
          return { batchId: row.id, currentFCR, targetFCR, variancePercent };
        })
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
      if (alerting.length === 0) return;

      // Trend yalnız eşiği aşan batch'ler için — tek sorgu.
      const trends = await this.fcrCalculation.analyzeFCRTrendMany(
        tenantId,
        alerting.map((candidate) => candidate.batchId),
      );

      for (const candidate of alerting) {
        const alertLevel: FCRAlertEvent['alertLevel'] =
          candidate.variancePercent > FCR_CRITICAL_VARIANCE_PERCENT ? 'critical' : 'warning';
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
   * katmandır (NFR).
   *
   * Zon çözümü YOK: retention'ın gün semantiği yoktur (24 ay / 90 gün süreli
   * pencereler), bu yüzden saatlik tenant-yerel tick'e girmez ve UTC'de ayın
   * 1'i 04:00'te koşar. Advisory-lock tek instance garantisi verir.
   */
  @Cron('0 4 1 * *', { name: 'feeding-v2-retention' })
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
      // Cross-tenant koşu kaydı (W5) — tenant döngüsünün dışında, tek seferde.
      await this.jobRuns.purgeOlderThanRetention();
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
      // Yenilenmeyen forecast kapsamları (FARM-LOW-296): canlı budama
      // `ProtocolFeedForecastService.pruneScopes`'ta, bu yalnız ARTIK
      // hiç koşmayan tenant/site satırlarının süpürmesidir.
      const forecasts: Array<{ count: number }> = await manager.query(
        `WITH deleted AS (
           DELETE FROM "feeding_forecast_snapshots"
            WHERE "tenantId" = $1
              AND "computedAt" < (now() - INTERVAL '${FORECAST_SNAPSHOT_RETENTION_DAYS} days')
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
        forecasts: Number(forecasts[0]?.count ?? 0),
      };
      if (purged.meals + purged.dayPlans + purged.receipts + purged.forecasts > 0) {
        this.logger.log(
          `Retention purge: ${purged.meals} meals, ${purged.dayPlans} day plans, ` +
            `${purged.receipts} receipts, ${purged.forecasts} forecast scopes removed ` +
            `(tenant ${tenantId.substring(0, 8)}...)`,
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
           SELECT DISTINCT "tenantId" FROM "farm_mobile_command_receipts"
           UNION
           SELECT DISTINCT "tenantId" FROM "feeding_forecast_snapshots"`,
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
   * Yemleme işlerinin keşif kümesi — TEK sorgu, İŞİN GERÇEK GİRDİSİNE bağlı
   * (W5, FARM-MEDIUM-255).
   *
   * Eski hâl iki ayrı keşfe bölünmüştü ve üretim/süpürme/özet tarafı yalnız
   * `status = 'active'` atamalara bakıyordu. Sonuç: ataması `paused`'a düşmüş
   * (tam hasat, veri tutarsızlığı, operatör duraklatması) bir tenant'ın
   * kaçırılan öğünleri hiç damgalanmıyor, gün özeti hiç çıkmıyor, rollup
   * bekleyen planları sonsuza dek `rollupAppliedKg <> Σ actual` durumunda
   * kalıyordu — üstelik D-5 tespiti tam da o tenant'ta çalışmalıydı.
   *
   * Birleşim dört girdiyi kapsar: canlı atama (active VEYA paused), yakın
   * tarihli gün planı (rollup/özet adayı), balıklı ünite (D-5 tespiti) ve
   * aktif batch (FCR alarmı).
   */
  private async feedingTenants(): Promise<string[]> {
    const tenantSchemas = await listTenantSchemas(this.dataSource);
    const tenantIds = new Set<string>();
    for (const schema of tenantSchemas) {
      const runner = this.dataSource.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}", farm, public`);
        const rows: Array<{ tenantId: string }> = await runner.query(
          `SELECT DISTINCT "tenantId" FROM "feeding_protocol_assignments"
             WHERE status IN ('active', 'paused')
           UNION
           SELECT DISTINCT "tenantId" FROM "feeding_day_plans"
             WHERE "planDate" >= (CURRENT_DATE - INTERVAL '${ROLLUP_LOOKBACK_DAYS} days')
           UNION
           SELECT DISTINCT "tenantId" FROM "tank_batches" WHERE "totalQuantity" > 0
           UNION
           SELECT DISTINCT "tenantId" FROM "batches_v2" WHERE "isActive" = true`,
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
