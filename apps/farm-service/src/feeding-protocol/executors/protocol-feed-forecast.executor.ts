/**
 * ProtocolFeedForecastExecutor — verified session altında forecast projection executor'ı.
 *
 * Motorla AYNI çözüm zincirini okur (ProtocolRateService: band → oran → FCR),
 * bu yüzden tahmin fiili yürütmeden sapamaz. Toplu yüklemeden sonra saf
 * in-memory O(N×H) simülasyon — ünite başına DB çağrısı YOKTUR.
 *
 * Kapsam: satın alma kararı tek TENANT havuzunda verilir; her fiziksel stok ve
 * her ünite bu otoriteye tam bir kez girer. Depolu Site kapsamları yalnız
 * transfer bilgisidir ve satın alma alarmı üretemez. Exact-set reconciliation
 * aynı transaction'da fosil kapsamları budar.
 *
 * Ölüm projeksiyonu: tür `growthParameters.expectedSurvivalRate` tanımlıysa
 * NOMINAL_CYCLE_DAYS üzerinden günlük orana çevrilir; tanımsızsa ölümsüz
 * (muhafazakâr — stok "erken biter" görünür) ve çıktı `mortalityAssumption`
 * ile açıkça işaretlenir. Hasat kesintileri saf girdi olarak desteklenir
 * (`harvestFractionByDay`); plan yükleyicisi cron dilimiyle bağlanır (C-14).
 *
 * @module FeedingProtocol/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import type { TenantMutationSession } from '@aquaculture/backend-common/database';
import { EntityManager, In } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import {
  FEEDING_FORECAST_PROJECTION_V1,
  compileFeedingForecastMortalityProvenanceV1,
  compileFeedingForecastAlertV1,
  compileFeedingForecastBandPathV1,
  compileFeedingForecastPoolIdentityV1,
  feedingForecastPoolMembershipV1,
  type FeedingForecastPoolIdentityV1,
  type FeedingForecastMortalityUnitProvenanceV1,
} from '@aquaculture/feeding-contracts';
import {
  createBaseEvent,
  FeedStockoutForecastEvent,
  FeedTransitionUpcomingEvent,
} from '@platform/event-contracts';

import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Species } from '../../species/entities/species.entity';
import {
  FcrMatrix,
  FeedingProtocolStatus,
  FeedingProtocolV2,
} from '../entities/feeding-protocol-v2.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import {
  ForecastAlert,
  ForecastMortalityAssumption,
  ForecastPerFeed,
  ForecastPerUnit,
  ForecastUnitTransition,
} from '../entities/feeding-forecast-snapshot.entity';
import { collectFeedSourceFeedIds } from '../services/feed-fcr-source.util';
import { ProtocolRateService } from '../services/protocol-rate.service';
import type { ForecastRefreshOperationCommand } from '../feeding-operation-command';
import type { FeedingForecastOperationHandler } from '../feeding-operation-handler';
import type { FeedingOperationSession } from '../feeding-operation-session';
import {
  feedingOperationObservedAt,
  readFeedingOperationSession,
} from '../feeding-operation-session';
import { FeedingAggregateMutationPort } from '../feeding-aggregate-mutation.writer';
import {
  loadFeedingForecastStockPoolV1,
  type FeedingForecastStockPoolRowV1,
} from '../feeding-forecast-generation.reader';

// ============================================================================
// SABİTLER
// ============================================================================

/** MAKS hesap ufku — sorgular bunun altına diler (K-10). */
export const FORECAST_MAX_HORIZON_DAYS = FEEDING_FORECAST_PROJECTION_V1.maxHorizonDays;
/** feeds.procurementLeadTimeDays boşken uygulanan BELGELİ default (K-17). */
export const DEFAULT_PROCUREMENT_LEAD_TIME_DAYS = 7;
/**
 * expectedSurvivalRate döngü-toplamı yüzdesinin günlüğe indirgendiği nominal
 * üretim döngüsü — varsayım çıktıda `mortalityAssumption` ile işaretlenir.
 */
export const NOMINAL_CYCLE_DAYS = 365;

/**
 * SAF (§5, spec pinli): döngü-toplamı hayatta-kalma yüzdesini günlük çarpana
 * indirger — (yüzde/100)^(1/NOMINAL_CYCLE_DAYS). Sayı değil / ≤0 / >100 →
 * null (çağıran ölümsüz 1.0 varsayımına döner ve mortalityAssumption 'none'
 * kalır — sessiz varsayım yok).
 */
export function dailySurvivalRateFromCyclePercent(cycleSurvivalPercent: unknown): number | null {
  if (
    typeof cycleSurvivalPercent !== 'number' ||
    !Number.isFinite(cycleSurvivalPercent) ||
    cycleSurvivalPercent <= 0 ||
    cycleSurvivalPercent > 100
  ) {
    return null;
  }
  return Math.pow(cycleSurvivalPercent / 100, 1 / NOMINAL_CYCLE_DAYS);
}
/** Yeniden sipariş miktarı: tükeniş sonrası bu pencerenin toplam tüketimi. */
export const REORDER_WINDOW_DAYS = 30;
/** D-9 belgeli tenant-geneli fallback kapsam anahtarı. */
export const TENANT_SCOPE_KEY = FEEDING_FORECAST_PROJECTION_V1.tenantScopeKey;
export const FORECAST_RETENTION_DAYS = FEEDING_FORECAST_PROJECTION_V1.retentionDays;

// ============================================================================
// SAF GİRDİ ŞEKİLLERİ
// ============================================================================

export interface ForecastUnitInput {
  unitId: string;
  unitName: string;
  unitCode: string;
  /** Physical Site identity; membership compiler decides tenant/site fan-out. */
  siteId: string;
  /** Whether this Site owns an informational local-stock projection. */
  hasLocalStorage: boolean;
  avgWeightG: number;
  fishCount: number;
  biomassKg: number;
  temperatureC: number | null;
  rateAdjustmentPercent?: number;
  fcrOverrides?: { feedId: string; expectedFcr: number }[];
  protocol: Pick<FeedingProtocolV2, 'bands' | 'temperatureAdjustments' | 'settings' | 'fcrMatrix'>;
  /** Exact source + daily rate; `none` is constrained to conservative 1.0. */
  mortality: Omit<FeedingForecastMortalityUnitProvenanceV1, 'unitId'>;
  /** Gün → o gün üniteden çıkan biyokütle ORANI [0..1] (hasat planları, C-14). */
  harvestFractionByDay?: ReadonlyMap<number, number>;
}

export interface ForecastFeedInput {
  feedId: string;
  feedCode: string;
  feedName: string;
  /** Compiled pool identity → mevcut stok (kg). */
  stockKgByScope: ReadonlyMap<string, number>;
  procurementLeadTimeDays: number | null;
  feedFcrMatrix?: FcrMatrix;
}

export interface ForecastComputeInput {
  units: ForecastUnitInput[];
  feeds: ForecastFeedInput[];
  horizonDays: number;
  /** Gün-0'ın ISO takvim günü (YYYY-MM-DD) — tarih alanları buradan türetilir. */
  startDate: string;
}

export interface ForecastScopeResult extends FeedingForecastPoolIdentityV1 {
  perFeed: ForecastPerFeed[];
  perUnit: ForecastPerUnit[];
  alerts: ForecastAlert[];
  mortalityAssumption: ForecastMortalityAssumption;
}

// ============================================================================
// SAF PROJECTION DERLEYİCİSİ
// ============================================================================

@Injectable()
export class FeedingForecastProjectionCompiler {
  constructor(private readonly rateService: ProtocolRateService) {}

  // ──────────────────────────────────────────────────────────────────────────
  // SAF HESAP — O(N×H); DB erişimi yok, spec'ler doğrudan pinler
  // ──────────────────────────────────────────────────────────────────────────

  compile(input: ForecastComputeInput): ForecastScopeResult[] {
    const horizon = Math.max(1, Math.min(input.horizonDays, FORECAST_MAX_HORIZON_DAYS));
    const feedById = new Map(input.feeds.map((f) => [f.feedId, f]));
    const consumption = new Map<string, Map<string, number[]>>();
    const perUnitByScope = new Map<string, ForecastPerUnit[]>();
    const mortalityByScope = new Map<string, FeedingForecastMortalityUnitProvenanceV1[]>();
    const observedUnitIds = new Set<string>();

    for (const unit of input.units) {
      if (observedUnitIds.has(unit.unitId)) {
        throw new Error(`Duplicate forecast unit ${unit.unitId}`);
      }
      observedUnitIds.add(unit.unitId);
      const bandCoordinates: Array<{ readonly atDay: number; readonly feedId: string }> = [];
      let avgWeightG = unit.avgWeightG;
      let count = unit.fishCount;
      let biomassKg = unit.biomassKg;
      const unitSeries = new Map<string, number[]>();

      for (let day = 0; day < horizon; day++) {
        count *= unit.mortality.dailySurvivalRate;
        biomassKg *= unit.mortality.dailySurvivalRate;
        const harvestFraction = unit.harvestFractionByDay?.get(day) ?? 0;
        if (harvestFraction > 0) {
          const keep = Math.max(0, 1 - harvestFraction);
          count *= keep;
          biomassKg *= keep;
        }
        if (count < 1 || biomassKg <= 0) break;

        const resolved = this.rateService.bandFor(unit.protocol.bands, avgWeightG);
        if (!resolved) break;
        const band = resolved.band;

        if (bandCoordinates.at(-1)?.feedId !== band.feedId) {
          bandCoordinates.push({ atDay: day, feedId: band.feedId });
        }

        const tempMultiplier = this.rateService.temperatureMultiplier(
          unit.protocol.temperatureAdjustments,
          unit.temperatureC,
        );
        const ratePercent = this.rateService.effectiveRatePercent({
          baseRatePercent: band.feedingRatePercent,
          temperatureMultiplier: tempMultiplier,
          rateAdjustmentPercent: unit.rateAdjustmentPercent,
          minRatePercent: unit.protocol.settings.minFeedingRatePercent,
          maxRatePercent: unit.protocol.settings.maxFeedingRatePercent,
        });
        const dailyKg = (biomassKg * ratePercent) / 100;

        const series = mapGet(unitSeries, band.feedId, () => new Array<number>(horizon).fill(0));
        series[day] = (series[day] ?? 0) + dailyKg;

        const fcr = this.rateService.resolveExpectedFcr({
          band,
          fcrSource: unit.protocol.settings.fcrSource,
          avgWeightG,
          temperatureC: unit.temperatureC,
          protocolFcrMatrix: unit.protocol.fcrMatrix,
          feedFcrMatrix: feedById.get(band.feedId)?.feedFcrMatrix,
          fcrOverrides: unit.fcrOverrides,
        }).value;
        biomassKg += dailyKg / fcr;
        avgWeightG = (biomassKg * 1000) / count;
      }

      const bandPath = compileFeedingForecastBandPathV1(bandCoordinates);
      const perUnit: ForecastPerUnit = {
        unitId: unit.unitId,
        unitName: unit.unitName,
        unitCode: unit.unitCode,
        currentFeedId: bandPath.currentFeedId,
        terminalFeedId: bandPath.terminalFeedId,
        transitions: bandPath.transitions.map(
          (transition): ForecastUnitTransition => ({
            fromFeedId: transition.fromFeedId,
            toFeedId: transition.toFeedId,
            estimatedDate: addDays(input.startDate, transition.atDay),
            daysFromNow: transition.atDay,
          }),
        ),
      };

      const memberships = feedingForecastPoolMembershipV1(unit.siteId, unit.hasLocalStorage);
      for (const { siteScopeKey: scopeKey } of memberships) {
        const scopeSeries = mapGet(consumption, scopeKey, () => new Map<string, number[]>());
        for (const [feedId, series] of unitSeries) {
          const aggregate = mapGet(scopeSeries, feedId, () => new Array<number>(horizon).fill(0));
          for (let day = 0; day < horizon; day++) {
            aggregate[day] = (aggregate[day] ?? 0) + (series[day] ?? 0);
          }
        }
        mapGet(perUnitByScope, scopeKey, () => [] as ForecastPerUnit[]).push(perUnit);
        mapGet(mortalityByScope, scopeKey, () => []).push({
          unitId: unit.unitId,
          source: unit.mortality.source,
          dailySurvivalRate: unit.mortality.dailySurvivalRate,
        });
      }
    }

    const buildScope = (scopeKey: string): ForecastScopeResult => {
      const feedSeries = consumption.get(scopeKey) ?? new Map<string, number[]>();
      const perFeed = [...feedSeries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([feedId, series]) =>
          this.buildPerFeed(feedId, series, feedById.get(feedId), scopeKey, input.startDate),
        );
      return {
        ...compileFeedingForecastPoolIdentityV1(
          scopeKey,
          scopeKey === TENANT_SCOPE_KEY ? 'TENANT' : 'SITE',
        ),
        perFeed,
        perUnit: [...(perUnitByScope.get(scopeKey) ?? [])].sort((left, right) =>
          left.unitId.localeCompare(right.unitId),
        ),
        alerts: [],
        mortalityAssumption: compileFeedingForecastMortalityProvenanceV1(
          mortalityByScope.get(scopeKey) ?? [],
        ),
      };
    };

    if (!consumption.has(TENANT_SCOPE_KEY)) return [];
    const tenantScope = buildScope(TENANT_SCOPE_KEY);
    tenantScope.alerts = this.buildAlerts(
      tenantScope.perFeed,
      tenantScope.perUnit,
      input.startDate,
    );
    const pooledShortfall = new Set(
      tenantScope.perFeed
        .filter(
          (feed) => feed.daysOfCover !== null && feed.daysOfCover < feed.procurementLeadTimeDays,
        )
        .map((feed) => feed.feedId),
    );
    const siteScopes = [...consumption.keys()]
      .filter((scopeKey) => scopeKey !== TENANT_SCOPE_KEY)
      .sort()
      .map((scopeKey) => {
        const siteScope = buildScope(scopeKey);
        siteScope.alerts = this.buildSiteTransferAlerts(siteScope.perFeed, pooledShortfall);
        return siteScope;
      });
    return [tenantScope, ...siteScopes];
  }

  private buildSiteTransferAlerts(
    perFeed: ForecastPerFeed[],
    pooledShortfall: ReadonlySet<string>,
  ): ForecastAlert[] {
    return perFeed.flatMap((feed): ForecastAlert[] => {
      if (
        feed.daysOfCover === null ||
        pooledShortfall.has(feed.feedId) ||
        feed.daysOfCover >= feed.procurementLeadTimeDays
      ) {
        return [];
      }
      return [
        compileFeedingForecastAlertV1({
          type: 'SITE_TRANSFER_NEEDED',
          feedId: feed.feedId,
          days: feed.daysOfCover,
          atDay: feed.daysOfCover,
        }),
      ];
    });
  }

  private buildPerFeed(
    feedId: string,
    dailyConsumptionSeries: number[],
    feed: ForecastFeedInput | undefined,
    scopeKey: string,
    startDate: string,
  ): ForecastPerFeed {
    const currentStockKg = feed?.stockKgByScope.get(scopeKey) ?? 0;
    const leadTime = feed?.procurementLeadTimeDays ?? DEFAULT_PROCUREMENT_LEAD_TIME_DAYS;

    // Düz döngü (forEach değil): callback içi atamalar TS kontrol-akışında
    // görünmez kalır ve stockoutDay guard'ı 'never'a daralırdı
    // (restrict-plus-operands bulgusunun kökü).
    const remainingStockSeries: number[] = [];
    let remaining = currentStockKg;
    let stockoutDay: number | null = null;
    let firstConsumptionDay: number | null = null;
    for (let day = 0; day < dailyConsumptionSeries.length; day++) {
      const kg = dailyConsumptionSeries[day] ?? 0;
      if (kg > 0 && firstConsumptionDay === null) firstConsumptionDay = day;
      remaining -= kg;
      remainingStockSeries.push(Number(remaining.toFixed(3)));
      if (remaining < 0 && stockoutDay === null) stockoutDay = day;
    }

    // Yeniden sipariş: tükeniş gününden geriye tedarik süresi (bugünden erken
    // olamaz); miktar = tükenişi izleyen REORDER_WINDOW_DAYS penceresinin
    // toplam tüketimi (ufuk sonunda kesilir).
    let reorderDate: string | null = null;
    let reorderQuantityKg: number | null = null;
    if (stockoutDay !== null) {
      reorderDate = addDays(startDate, Math.max(0, stockoutDay - leadTime));
      reorderQuantityKg = Number(
        dailyConsumptionSeries
          .slice(stockoutDay, stockoutDay + REORDER_WINDOW_DAYS)
          .reduce((acc, kg) => acc + kg, 0)
          .toFixed(3),
      );
    }

    return {
      feedId,
      feedCode: feed?.feedCode ?? feedId,
      feedName: feed?.feedName ?? feedId,
      currentStockKg,
      dailyConsumptionSeries: dailyConsumptionSeries.map((kg) => Number(kg.toFixed(3))),
      remainingStockSeries,
      stockoutDate: stockoutDay === null ? null : addDays(startDate, stockoutDay),
      daysOfCover: stockoutDay,
      firstConsumptionDate:
        firstConsumptionDay === null ? null : addDays(startDate, firstConsumptionDay),
      coverageFromAdoptionDays:
        stockoutDay === null || firstConsumptionDay === null
          ? null
          : stockoutDay - firstConsumptionDay,
      reorderDate,
      reorderQuantityKg,
      procurementLeadTimeDays: leadTime,
      leadTimeSource: feed?.procurementLeadTimeDays != null ? 'feed' : 'default',
    };
  }

  private buildAlerts(
    perFeed: ForecastPerFeed[],
    perUnit: ForecastPerUnit[],
    startDate: string,
  ): ForecastAlert[] {
    const alerts: ForecastAlert[] = [];
    const stockoutDayByFeed = new Map<string, number | null>(
      perFeed.map((f) => [f.feedId, f.daysOfCover]),
    );
    const leadTimeByFeed = new Map<string, number>(
      perFeed.map((f) => [f.feedId, f.procurementLeadTimeDays]),
    );

    for (const feed of perFeed) {
      if (feed.daysOfCover !== null) {
        alerts.push(
          compileFeedingForecastAlertV1({
            type: 'STOCKOUT_FORECAST',
            feedId: feed.feedId,
            days: feed.daysOfCover,
            atDay: feed.daysOfCover,
          }),
        );
        if (feed.reorderDate !== null && feed.reorderDate <= startDate) {
          alerts.push(
            compileFeedingForecastAlertV1({
              type: 'REORDER_NOW',
              feedId: feed.feedId,
              days: feed.daysOfCover,
              atDay: 0,
            }),
          );
        }
      }
    }

    // Geçiş-kapsama açığı: hedef yemin stoğu, geçiş tarihi + tedarik süresi
    // penceresini karşılamıyorsa shortfall gün sayısıyla işaretlenir.
    for (const unit of perUnit) {
      for (const transition of unit.transitions) {
        const stockoutDay = stockoutDayByFeed.get(transition.toFeedId);
        if (stockoutDay === null || stockoutDay === undefined) continue;
        const leadTime =
          leadTimeByFeed.get(transition.toFeedId) ?? DEFAULT_PROCUREMENT_LEAD_TIME_DAYS;
        const required = transition.daysFromNow + leadTime;
        if (stockoutDay < required) {
          alerts.push(
            compileFeedingForecastAlertV1({
              type: 'TRANSITION_COVERAGE_GAP',
              feedId: transition.toFeedId,
              unitId: unit.unitId,
              days: required - stockoutDay,
              atDay: transition.daysFromNow,
            }),
          );
        }
      }
    }
    return alerts;
  }

  // ──────────────────────────────────────────────────────────────────────────
}

// ============================================================================
// VERIFIED-SESSION EXECUTOR
// ============================================================================

@Injectable()
export class ProtocolFeedForecastExecutor implements FeedingForecastOperationHandler {
  private readonly logger = new Logger(ProtocolFeedForecastExecutor.name);

  constructor(
    private readonly feedingMutations: FeedingAggregateMutationPort,
    private readonly projectionCompiler: FeedingForecastProjectionCompiler,
    private readonly temperatureService: WaterTemperatureService,
    // Durable kapsama event'leri yalnız 07:00 cron yolunda (emitCoverageEvents).
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  // YÜKLEYİCİ + SNAPSHOT UPSERT — 07:00 cron ve D-6 yenileme buraya delege eder
  // ──────────────────────────────────────────────────────────────────────────

  async executeForecastOperation(
    session: FeedingOperationSession,
    command: ForecastRefreshOperationCommand,
  ): Promise<number> {
    const context = readFeedingOperationSession(session);
    return this.projectTenant(
      context.manager,
      context.mutationSession,
      command.tenantId,
      context.operationId,
      feedingOperationObservedAt(context),
      command.emitCoverageEvents,
    );
  }

  async executeScheduledTenantProjection(session: FeedingOperationSession): Promise<number> {
    const context = readFeedingOperationSession(session);
    return this.projectTenant(
      context.manager,
      context.mutationSession,
      context.tenantId,
      context.operationId,
      feedingOperationObservedAt(context),
      true,
    );
  }

  private async projectTenant(
    manager: EntityManager,
    mutationSession: TenantMutationSession,
    tenantId: string,
    operationId: string,
    observedAt: Date,
    emitCoverageEvents: boolean,
  ): Promise<number> {
    const assignments = await manager.find(ProtocolAssignment, {
      where: { tenantId, status: ProtocolAssignmentStatus.ACTIVE },
      order: { id: 'ASC' },
    });
    if (assignments.length === 0) {
      await this.feedingMutations.reconcileForecastProjection(mutationSession, {
        operationId,
        sourceWatermark: observedAt,
        snapshots: [],
      });
      return 0;
    }

    const protocolIds = [...new Set(assignments.map((a) => a.protocolId))];
    const unitIds = assignments.map((a) => a.unitId);
    const [protocols, tankBatches, temperatures, sitesWithStorage, stockRows] = await Promise.all([
      manager.find(FeedingProtocolV2, {
        where: { tenantId, id: In(protocolIds), status: FeedingProtocolStatus.ACTIVE },
      }),
      manager.find(TankBatch, { where: { tenantId, tankId: In(unitIds) } }),
      this.temperatureService.getEffectiveTemperaturesForUnits(tenantId, unitIds),
      this.loadSitesWithStorage(manager, tenantId),
      loadFeedingForecastStockPoolV1(manager, tenantId),
    ]);
    const protocolById = new Map(protocols.map((p) => [p.id, p]));
    const tankBatchByUnit = new Map(tankBatches.map((tb) => [tb.tankId, tb]));
    const dailySurvivalBySpecies = await this.loadDailySurvivalRates(manager, tenantId, protocols);

    const bandFeedIds = new Set(
      protocols.flatMap((p) => p.bands.map((band) => band.feedId)).filter(Boolean),
    );
    const feeds = await this.loadFeeds(manager, tenantId, [...bandFeedIds], protocols);

    const units: ForecastUnitInput[] = [];
    for (const assignment of assignments) {
      const protocol = protocolById.get(assignment.protocolId);
      const tankBatch = tankBatchByUnit.get(assignment.unitId);
      if (!protocol || !tankBatch || tankBatch.totalQuantity <= 0) continue;
      // Motor/generator SSoT'siyle AYNI kolonlar (D-13): ÜRETİM biomass'ı
      // `totalBiomassKg` + entity `avgWeightG` — temizlikçi balık ve nullable
      // `currentBiomassKg` aynası hesaba giremez.
      const biomassKg = Number(tankBatch.totalBiomassKg || 0);
      const fishCount = Number(tankBatch.totalQuantity);
      const dailySurvivalRate = protocol.speciesId
        ? dailySurvivalBySpecies.get(protocol.speciesId)
        : undefined;
      const mortality: ForecastUnitInput['mortality'] =
        dailySurvivalRate === undefined
          ? { source: 'none', dailySurvivalRate: 1 }
          : { source: 'species_survival_rate', dailySurvivalRate };
      units.push({
        unitId: assignment.unitId,
        unitName: assignment.unitName,
        unitCode: assignment.unitCode,
        siteId: assignment.siteId,
        hasLocalStorage: sitesWithStorage.has(assignment.siteId),
        avgWeightG: Number(tankBatch.avgWeightG || 0),
        fishCount,
        biomassKg,
        temperatureC: temperatures.get(assignment.unitId)?.celsius ?? null,
        rateAdjustmentPercent: assignment.overrides?.rateAdjustmentPercent,
        fcrOverrides: assignment.overrides?.fcrOverrides,
        protocol,
        mortality,
      });
    }
    if (units.length === 0) {
      await this.feedingMutations.reconcileForecastProjection(mutationSession, {
        operationId,
        sourceWatermark: observedAt,
        snapshots: [],
      });
      return 0;
    }

    // Gün-0 KONTRATI (belgeli): forecast takvimi UTC günüdür — snapshot tüm
    // sitelerin kapsamlarını tek hesapta taşır, tek takvim tabanı gerekir.
    // FE tazelik damgası da computedAt'i UTC diliminde keser; site-TZ'li
    // day-plan `planDate`'iyle sınır saatlerde ±1 gün fark BİLİNÇLİDİR
    // (görselleştirme granülü gün, karar penceresi hafta ölçeğinde).
    const startDate = observedAt.toISOString().slice(0, 10);
    const results = this.projectionCompiler.compile({
      units,
      feeds: this.buildFeedInputs(feeds, stockRows, sitesWithStorage),
      horizonDays: FORECAST_MAX_HORIZON_DAYS,
      startDate,
    });

    const snapshots = results.map((result) => ({
      siteScopeKey: result.siteScopeKey,
      poolScope: result.poolScope,
      horizonDays: FORECAST_MAX_HORIZON_DAYS,
      computedAt: observedAt,
      perFeed: result.perFeed,
      perUnit: result.perUnit,
      alerts: result.alerts,
      mortalityAssumption: result.mortalityAssumption,
    }));
    for (const result of results) {
      if (emitCoverageEvents && result.poolScope === 'TENANT') {
        await this.emitCoverageEvents(manager, tenantId, result);
      }
    }
    await this.feedingMutations.reconcileForecastProjection(mutationSession, {
      operationId,
      sourceWatermark: observedAt,
      snapshots,
    });
    this.logger.log(
      `Forecast snapshot yenilendi: tenant=${tenantId} kapsam=${results.length} ünite=${units.length}`,
    );
    return results.length;
  }

  /**
   * Durable kapsama sinyalleri (plan §5/§6) — yalnız 07:00 cron yolunda:
   * event-driven her yenilemede yaymak teslimat başına alert üretirdi.
   * Snapshot upsert'üyle AYNI manager'da outbox'a yazılır (outbox invariantı).
   */
  private async emitCoverageEvents(
    manager: EntityManager,
    tenantId: string,
    result: ForecastScopeResult,
  ): Promise<void> {
    const gapByUnitFeed = new Map<string, number>(
      result.alerts
        .filter((a) => a.type === 'TRANSITION_COVERAGE_GAP' && a.unitId)
        .map((a) => [`${a.unitId}:${a.feedId}`, a.days]),
    );
    for (const feed of result.perFeed) {
      if (feed.daysOfCover === null || feed.stockoutDate === null) continue;
      const event: FeedStockoutForecastEvent = {
        ...createBaseEvent<FeedStockoutForecastEvent>('FeedStockoutForecast', tenantId, {
          aggregateId: feed.feedId,
          aggregateType: 'Feed',
        }),
        siteScopeKey: result.siteScopeKey,
        feedId: feed.feedId,
        feedCode: feed.feedCode,
        daysOfCover: feed.daysOfCover,
        stockoutDate: feed.stockoutDate,
        reorderDate: feed.reorderDate ?? undefined,
        procurementLeadTimeDays: feed.procurementLeadTimeDays,
      };
      await this.outboxPublisher.enqueue(event, manager);
    }
    for (const unit of result.perUnit) {
      for (const transition of unit.transitions) {
        const event: FeedTransitionUpcomingEvent = {
          ...createBaseEvent<FeedTransitionUpcomingEvent>('FeedTransitionUpcoming', tenantId, {
            aggregateId: unit.unitId,
            aggregateType: 'FeedingUnit',
          }),
          siteScopeKey: result.siteScopeKey,
          unitId: unit.unitId,
          unitCode: unit.unitCode,
          fromFeedId: transition.fromFeedId,
          toFeedId: transition.toFeedId,
          estimatedDate: transition.estimatedDate,
          daysFromNow: transition.daysFromNow,
          shortfallDays: gapByUnitFeed.get(`${unit.unitId}:${transition.toFeedId}`),
        };
        await this.outboxPublisher.enqueue(event, manager);
      }
    }
  }

  /** storage_locations taşıyan siteler — D-9 kapsam kararının girdisi. */
  /**
   * Tür başına günlük hayatta-kalma çarpanı (§5): protokolün türündeki
   * `growthParameters.expectedSurvivalRate` (döngü-toplamı %) NOMINAL_CYCLE_DAYS
   * üzerinden günlüğe indirgenir. Tanımsız ya da aralık dışı değer ölümsüz
   * (1.0, muhafazakâr) varsayıma düşer; hangi varsayımın uygulandığı çıktıda
   * `mortalityAssumption` ile işaretlenir — sessiz yok.
   */
  private async loadDailySurvivalRates(
    manager: EntityManager,
    tenantId: string,
    protocols: FeedingProtocolV2[],
  ): Promise<Map<string, number>> {
    const speciesIds = [
      ...new Set(protocols.map((p) => p.speciesId).filter((id): id is string => !!id)),
    ];
    const rates = new Map<string, number>();
    if (speciesIds.length === 0) return rates;
    const speciesRows = await manager.find(Species, {
      where: { tenantId, id: In(speciesIds) },
    });
    for (const species of speciesRows) {
      const dailyRate = dailySurvivalRateFromCyclePercent(
        species.growthParameters?.expectedSurvivalRate,
      );
      if (dailyRate !== null) rates.set(species.id, dailyRate);
    }
    return rates;
  }

  private async loadSitesWithStorage(
    manager: EntityManager,
    tenantId: string,
  ): Promise<Set<string>> {
    const rows: Array<{ siteId: string }> = await manager.query(
      `SELECT DISTINCT site_id AS "siteId"
         FROM storage_locations
        WHERE tenant_id = $1 AND is_deleted = false`,
      [tenantId],
    );
    return new Set(rows.map((r) => r.siteId));
  }

  private async loadFeeds(
    manager: EntityManager,
    tenantId: string,
    feedIds: string[],
    protocols: FeedingProtocolV2[],
  ): Promise<
    Array<{
      id: string;
      code: string;
      name: string;
      procurementLeadTimeDays: number | null;
      feedingMatrix2D: {
        temperatures?: number[];
        weights?: number[];
        fcrMatrix?: number[][];
      } | null;
    }>
  > {
    if (feedIds.length === 0) return [];
    const fcrSourceFeedIds = new Set(collectFeedSourceFeedIds(protocols));
    const rows: Array<{
      id: string;
      code: string;
      name: string;
      procurementLeadTimeDays: number | null;
      feedingMatrix2D: {
        temperatures?: number[];
        weights?: number[];
        fcrMatrix?: number[][];
      } | null;
    }> = await manager.query(
      `SELECT id, code, name, "procurementLeadTimeDays", "feedingMatrix2D"
       FROM feeds WHERE "tenantId" = $1 AND id = ANY($2::uuid[])`,
      [tenantId, feedIds],
    );
    // fcrSource=feed olmayan protokollerin yemlerinde matris taşımaya gerek yok.
    return rows.map((row) =>
      fcrSourceFeedIds.has(row.id) ? row : { ...row, feedingMatrix2D: null },
    );
  }

  private buildFeedInputs(
    feeds: ReadonlyArray<{
      id: string;
      code: string;
      name: string;
      procurementLeadTimeDays: number | null;
      feedingMatrix2D: {
        temperatures?: number[];
        weights?: number[];
        fcrMatrix?: number[][];
      } | null;
    }>,
    stockRows: readonly FeedingForecastStockPoolRowV1[],
    sitesWithStorage: ReadonlySet<string>,
  ): ForecastFeedInput[] {
    return feeds.map((feed) => {
      const stockKgByScope = new Map<string, number>();
      let tenantTotal = 0;
      for (const row of stockRows) {
        if (row.feedId !== feed.id) continue;
        tenantTotal += row.totalKg;
        if (sitesWithStorage.has(row.siteId)) {
          stockKgByScope.set(row.siteId, (stockKgByScope.get(row.siteId) ?? 0) + row.totalKg);
        }
      }
      // D-9 fallback kapsamı tenant-geneli toplamı okur.
      stockKgByScope.set(TENANT_SCOPE_KEY, tenantTotal);
      const matrix = feed.feedingMatrix2D;
      const feedFcrMatrix: FcrMatrix | undefined =
        matrix?.temperatures?.length && matrix.weights?.length && matrix.fcrMatrix?.length
          ? {
              temperatures: matrix.temperatures,
              weights: matrix.weights,
              fcrValues: matrix.fcrMatrix,
            }
          : undefined;
      return {
        feedId: feed.id,
        feedCode: feed.code,
        feedName: feed.name,
        stockKgByScope,
        procurementLeadTimeDays: feed.procurementLeadTimeDays,
        feedFcrMatrix,
      };
    });
  }
}

// ============================================================================
// SAF YARDIMCILAR
// ============================================================================

function addDays(isoDay: string, days: number): string {
  const date = new Date(`${isoDay}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mapGet<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = create();
  map.set(key, created);
  return created;
}
