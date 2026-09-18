/**
 * ProtocolFeedForecastService — protokol-FCR bileşik tükenme tahmini (Faz 7, plan §5).
 *
 * Motorla AYNI çözüm zincirini okur (ProtocolRateService: band → oran → FCR),
 * bu yüzden tahmin fiili yürütmeden sapamaz. Toplu yüklemeden sonra saf
 * in-memory O(N×H) simülasyon — ünite başına DB çağrısı YOKTUR.
 *
 * Kapsam (D-9): tüketim ve stok AYNI kapsamda karşılaştırılır — ünitenin
 * SİTESİNİN StorageLocation toplamları; site'ta hiç lokasyon yoksa BELGELİ
 * tenant-geneli fallback (scopeKey 'tenant'). Çıktı `feeding_forecast_snapshots`
 * satırına (tenantId, siteScopeKey) upsert edilir (K-10): 07:00 cron'u ve D-6
 * event-driven yenileme MAKS ufukta hesaplar, sorgular ufka diler.
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
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
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
  FeedingForecastSnapshot,
  ForecastAlert,
  ForecastMortalityAssumption,
  ForecastPerFeed,
  ForecastPerUnit,
  ForecastPoolScope,
  ForecastUnitTransition,
} from '../entities/feeding-forecast-snapshot.entity';
import { collectFeedSourceFeedIds } from './feed-fcr-source.util';
import { ProtocolRateService } from './protocol-rate.service';

// ============================================================================
// SABİTLER
// ============================================================================

/** MAKS hesap ufku — sorgular bunun altına diler (K-10). */
export const FORECAST_MAX_HORIZON_DAYS = 120;
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
export const TENANT_SCOPE_KEY = 'tenant';
/**
 * Snapshot bayatlık eşiği (W6, FARM-LOW-266). Forecast günde bir (07:00
 * yerel) hesaplanır; 26 saat bir koşuluk kaçırmayı kapsayan en dar penceredir.
 * Bayat satır silinmez — okuyucular `stale` bayrağıyla sunar, çünkü "veri yok"
 * ile "veri eski" operatör için farklı kararlardır.
 */
export const FORECAST_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

// ============================================================================
// SAF GİRDİ ŞEKİLLERİ
// ============================================================================

export interface ForecastUnitInput {
  unitId: string;
  unitName: string;
  unitCode: string;
  /** D-9 kapsam anahtarı: site UUID'si ya da 'tenant' (fallback). */
  scopeKey: string;
  avgWeightG: number;
  fishCount: number;
  biomassKg: number;
  temperatureC: number | null;
  rateAdjustmentPercent?: number;
  fcrOverrides?: { feedId: string; expectedFcr: number }[];
  protocol: Pick<FeedingProtocolV2, 'bands' | 'temperatureAdjustments' | 'settings' | 'fcrMatrix'>;
  /** Günlük hayatta-kalma çarpanı (1.0 = ölümsüz varsayım). */
  dailySurvivalRate: number;
  /** Gün → o gün üniteden çıkan biyokütle ORANI [0..1] (hasat planları, C-14). */
  harvestFractionByDay?: ReadonlyMap<number, number>;
}

export interface ForecastFeedInput {
  feedId: string;
  feedCode: string;
  feedName: string;
  /** scopeKey → mevcut stok (kg). */
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

export interface ForecastScopeResult {
  scopeKey: string;
  /** `TENANT` = kapsama/alarm otoritesi; `SITE` = bilgilendirici (W6). */
  poolScope: ForecastPoolScope;
  perFeed: ForecastPerFeed[];
  perUnit: ForecastPerUnit[];
  alerts: ForecastAlert[];
  mortalityAssumption: ForecastMortalityAssumption;
}

// ============================================================================
// SERVİS
// ============================================================================

@Injectable()
export class ProtocolFeedForecastService {
  private readonly logger = new Logger(ProtocolFeedForecastService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rateService: ProtocolRateService,
    private readonly temperatureService: WaterTemperatureService,
    // Durable kapsama event'leri yalnız 07:00 cron yolunda (emitCoverageEvents).
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // SAF HESAP — O(N×H); DB erişimi yok, spec'ler doğrudan pinler
  // ──────────────────────────────────────────────────────────────────────────

  computeForecast(input: ForecastComputeInput): ForecastScopeResult[] {
    const horizon = Math.max(1, Math.min(input.horizonDays, FORECAST_MAX_HORIZON_DAYS));
    const feedById = new Map(input.feeds.map((f) => [f.feedId, f]));
    // scopeKey → feedId → günlük tüketim serisi
    const consumption = new Map<string, Map<string, number[]>>();
    const perUnitByScope = new Map<string, ForecastPerUnit[]>();
    const survivalByScope = new Map<string, boolean>();

    for (const unit of input.units) {
      const transitions: ForecastUnitTransition[] = [];
      let avgWeightG = unit.avgWeightG;
      let count = unit.fishCount;
      let biomassKg = unit.biomassKg;
      /** Ufuk sonunda ulaşılan yem (simülasyonun yürüyen bandı). */
      let terminalFeedId: string | null = null;
      /** Ünitenin BUGÜNKÜ yemi — gün-0 bandı (FARM-LOW-265). */
      let currentFeedId: string | null = null;

      // Ünitenin tüketimi ÖNCE kendi defterine yazılır, sonra kapsamlara
      // fan-out edilir: aynı seri hem otorite (tenant havuzu) hem
      // bilgilendirici (site) deftere girer, ama tek kez simüle edilir.
      const unitSeries = new Map<string, number[]>();

      for (let day = 0; day < horizon; day++) {
        count *= unit.dailySurvivalRate;
        biomassKg *= unit.dailySurvivalRate;
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

        if (day === 0) currentFeedId = band.feedId;
        if (band.feedId !== terminalFeedId) {
          if (terminalFeedId !== null) {
            transitions.push({
              fromFeedId: terminalFeedId,
              toFeedId: band.feedId,
              estimatedDate: addDays(input.startDate, day),
              daysFromNow: day,
            });
          }
          terminalFeedId = band.feedId;
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

      const perUnitEntry: ForecastPerUnit = {
        unitId: unit.unitId,
        unitName: unit.unitName,
        unitCode: unit.unitCode,
        currentFeedId,
        terminalFeedId,
        transitions,
      };

      // Kullanıcı kararı 1: havuz TEK tenant havuzudur. Her ünite otorite
      // deftere (TENANT) yazar; deposu olan bir sitenin ünitesi AYRICA
      // sitenin bilgilendirici defterine yazar. Deposuz ünitede iki anahtar
      // aynıdır, çift yazım olmaz.
      const scopeKeys =
        unit.scopeKey === TENANT_SCOPE_KEY ? [TENANT_SCOPE_KEY] : [TENANT_SCOPE_KEY, unit.scopeKey];
      for (const scopeKey of scopeKeys) {
        const scopeSeries = mapGet(consumption, scopeKey, () => new Map<string, number[]>());
        for (const [feedId, series] of unitSeries) {
          const target = mapGet(scopeSeries, feedId, () => new Array<number>(horizon).fill(0));
          for (let day = 0; day < horizon; day++) {
            target[day] = (target[day] ?? 0) + (series[day] ?? 0);
          }
        }
        mapGet(perUnitByScope, scopeKey, () => [] as ForecastPerUnit[]).push(perUnitEntry);
        // Varsayım KAPSAM BAŞINA (FARM-LOW-272): ölüm oranı uygulanmamış bir
        // sitenin satırı `applied: true` damgası taşıyamaz.
        if (unit.dailySurvivalRate < 1) survivalByScope.set(scopeKey, true);
      }
    }

    // Otorite kapsam ÖNCE hesaplanır: site satırlarının "taşıma gerekli"
    // sinyali, havuzun gerçekten iyi olup olmadığını bilmek zorundadır.
    const buildScope = (scopeKey: string): ForecastScopeResult => {
      const feedSeries = consumption.get(scopeKey) ?? new Map<string, number[]>();
      const perFeed = [...feedSeries.entries()].map(([feedId, series]) =>
        this.buildPerFeed(feedId, series, feedById.get(feedId), scopeKey, input.startDate),
      );
      const survivalApplied = survivalByScope.get(scopeKey) === true;
      return {
        scopeKey,
        poolScope: scopeKey === TENANT_SCOPE_KEY ? 'TENANT' : 'SITE',
        perFeed,
        perUnit: perUnitByScope.get(scopeKey) ?? [],
        alerts: [],
        mortalityAssumption: {
          applied: survivalApplied,
          source: survivalApplied ? 'species_survival_rate' : 'none',
        },
      };
    };

    const results: ForecastScopeResult[] = [];
    if (consumption.has(TENANT_SCOPE_KEY)) {
      const tenantScope = buildScope(TENANT_SCOPE_KEY);
      tenantScope.alerts = this.buildAlerts(
        tenantScope.perFeed,
        tenantScope.perUnit,
        input.startDate,
      );
      results.push(tenantScope);

      // Havuzda GERÇEKTEN sıkıntı olan yemler: site satırı bunlar için
      // "taşıma" demez — satın alma sinyali zaten otorite kapsamda verildi.
      const pooledShortfall = new Set(
        tenantScope.perFeed
          .filter(
            (feed) => feed.daysOfCover !== null && feed.daysOfCover < feed.procurementLeadTimeDays,
          )
          .map((feed) => feed.feedId),
      );
      for (const scopeKey of consumption.keys()) {
        if (scopeKey === TENANT_SCOPE_KEY) continue;
        const siteScope = buildScope(scopeKey);
        siteScope.alerts = this.buildSiteTransferAlerts(siteScope.perFeed, pooledShortfall);
        results.push(siteScope);
      }
    }
    return results;
  }

  /**
   * Site kapsamının TEK alarm sınıfı (W6): havuz iyi ama sitenin YEREL stoğu
   * tedarik süresi boyunca kendi tüketimini karşılamıyor → yem satın alınmaz,
   * TAŞINIR. Kapsama kararı tenant havuzundan verildiği için bu ihtiyaç aksi
   * hâlde hiçbir yerde görünmezdi.
   */
  private buildSiteTransferAlerts(
    perFeed: ForecastPerFeed[],
    pooledShortfall: ReadonlySet<string>,
  ): ForecastAlert[] {
    const alerts: ForecastAlert[] = [];
    for (const feed of perFeed) {
      if (feed.daysOfCover === null) continue;
      if (pooledShortfall.has(feed.feedId)) continue;
      if (feed.daysOfCover >= feed.procurementLeadTimeDays) continue;
      alerts.push({
        type: 'SITE_TRANSFER_NEEDED',
        feedId: feed.feedId,
        days: feed.daysOfCover,
        atDay: feed.daysOfCover,
      });
    }
    return alerts;
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
        alerts.push({
          type: 'STOCKOUT_FORECAST',
          feedId: feed.feedId,
          days: feed.daysOfCover,
          atDay: feed.daysOfCover,
        });
        if (feed.reorderDate !== null && feed.reorderDate <= startDate) {
          // Sipariş BUGÜN verilmeli — dilimleme birimi gün indeksidir (0).
          alerts.push({
            type: 'REORDER_NOW',
            feedId: feed.feedId,
            days: feed.daysOfCover,
            atDay: 0,
          });
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
          alerts.push({
            type: 'TRANSITION_COVERAGE_GAP',
            feedId: transition.toFeedId,
            unitId: unit.unitId,
            // `days` EKSİK GÜN büyüklüğüdür; dilimleme `atDay` (geçişin
            // gerçekleştiği gün indeksi) üzerinden yapılır (FARM-LOW-266).
            days: required - stockoutDay,
            atDay: transition.daysFromNow,
          });
        }
      }
    }
    return alerts;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // YÜKLEYİCİ + SNAPSHOT UPSERT — 07:00 cron ve D-6 yenileme buraya delege eder
  // ──────────────────────────────────────────────────────────────────────────

  async refreshTenant(
    tenantId: string,
    options: { emitCoverageEvents?: boolean } = {},
  ): Promise<number> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const assignments = await manager.find(ProtocolAssignment, {
        where: { tenantId, status: ProtocolAssignmentStatus.ACTIVE },
        order: { id: 'ASC' },
      });
      // Erken çıkışlar da BUDAR (FARM-LOW-266): son ataması kalkan bir
      // tenant'ın fosil kapsamı aksi hâlde sonsuza dek okunur ve
      // `computedAt` bayat olsa bile "kapsama var" iddia ederdi.
      if (assignments.length === 0) return this.pruneScopes(manager, tenantId, new Set());

      const protocolIds = [...new Set(assignments.map((a) => a.protocolId))];
      const unitIds = assignments.map((a) => a.unitId);
      const [protocols, tankBatches, temperatures, sitesWithStorage, stockRows] = await Promise.all(
        [
          manager.find(FeedingProtocolV2, {
            where: { tenantId, id: In(protocolIds), status: FeedingProtocolStatus.ACTIVE },
          }),
          manager.find(TankBatch, { where: { tenantId, tankId: In(unitIds) } }),
          this.temperatureService.getEffectiveTemperaturesForUnits(tenantId, unitIds),
          this.loadSitesWithStorage(manager, tenantId),
          this.loadFeedStock(manager, tenantId),
        ],
      );
      const protocolById = new Map(protocols.map((p) => [p.id, p]));
      const tankBatchByUnit = new Map(tankBatches.map((tb) => [tb.tankId, tb]));
      const dailySurvivalBySpecies = await this.loadDailySurvivalRates(
        manager,
        tenantId,
        protocols,
      );

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
        units.push({
          unitId: assignment.unitId,
          unitName: assignment.unitName,
          unitCode: assignment.unitCode,
          scopeKey: sitesWithStorage.has(assignment.siteId) ? assignment.siteId : TENANT_SCOPE_KEY,
          avgWeightG: Number(tankBatch.avgWeightG || 0),
          fishCount,
          biomassKg,
          temperatureC: temperatures.get(assignment.unitId)?.celsius ?? null,
          rateAdjustmentPercent: assignment.overrides?.rateAdjustmentPercent,
          fcrOverrides: assignment.overrides?.fcrOverrides,
          protocol,
          dailySurvivalRate:
            (protocol.speciesId && dailySurvivalBySpecies.get(protocol.speciesId)) || 1.0,
        });
      }
      if (units.length === 0) return this.pruneScopes(manager, tenantId, new Set());

      // Gün-0 KONTRATI (belgeli): forecast takvimi UTC günüdür — snapshot tüm
      // sitelerin kapsamlarını tek hesapta taşır, tek takvim tabanı gerekir.
      // FE tazelik damgası da computedAt'i UTC diliminde keser; site-TZ'li
      // day-plan `planDate`'iyle sınır saatlerde ±1 gün fark BİLİNÇLİDİR
      // (görselleştirme granülü gün, karar penceresi hafta ölçeğinde).
      const startDate = new Date().toISOString().slice(0, 10);
      const results = this.computeForecast({
        units,
        feeds: this.buildFeedInputs(feeds, stockRows, sitesWithStorage),
        horizonDays: FORECAST_MAX_HORIZON_DAYS,
        startDate,
      });

      const computedAt = new Date();
      for (const result of results) {
        // Durable kapsama sinyalleri YALNIZ otorite kapsamdan (W6): site
        // satırları bilgilendiricidir ve aynı tükenişi site sayısı kadar
        // tekrar yayarlardı.
        if (options.emitCoverageEvents && result.poolScope === 'TENANT') {
          await this.emitCoverageEvents(queryRunner.manager, tenantId, result);
        }
        await manager.upsert(
          FeedingForecastSnapshot,
          {
            tenantId,
            siteScopeKey: result.scopeKey,
            poolScope: result.poolScope,
            horizonDays: FORECAST_MAX_HORIZON_DAYS,
            computedAt,
            perFeed: result.perFeed,
            perUnit: result.perUnit,
            alerts: result.alerts,
            mortalityAssumption: result.mortalityAssumption,
          },
          ['tenantId', 'siteScopeKey'],
        );
      }
      // Bu koşuda ÜRETİLMEYEN kapsamlar aynı transaction'da silinir: site
      // kapatıldığında ya da son ünitesi boşaldığında fosil satır canlı
      // veriye tercih edilemez (FARM-LOW-266).
      await this.pruneScopes(manager, tenantId, new Set(results.map((r) => r.scopeKey)));
      this.logger.log(
        `Forecast snapshot yenilendi: tenant=${tenantId} kapsam=${results.length} ünite=${units.length}`,
      );
      return results.length;
    });
  }

  /**
   * Bu koşuda üretilmeyen kapsam satırlarını siler ve üretilen sayıyı döner.
   * Snapshot upsert'üyle AYNI transaction'da koşar — yarıda kesilen bir
   * yenileme yarım budanmış bir tabloyla kalmaz.
   */
  private async pruneScopes(
    manager: EntityManager,
    tenantId: string,
    keepScopeKeys: ReadonlySet<string>,
  ): Promise<number> {
    const stale = await manager.find(FeedingForecastSnapshot, {
      where: { tenantId },
      select: ['id', 'siteScopeKey'],
    });
    const removable = stale.filter((row) => !keepScopeKeys.has(row.siteScopeKey));
    if (removable.length > 0) {
      await manager.delete(
        FeedingForecastSnapshot,
        removable.map((row) => row.id),
      );
      this.logger.log(
        `Forecast snapshot budandı: tenant=${tenantId} silinen kapsam=${removable.length}`,
      );
    }
    return keepScopeKeys.size;
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
        siteScopeKey: result.scopeKey,
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
          siteScopeKey: result.scopeKey,
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

  /**
   * Tek ledger okuması (P-10): site × feed stok toplamları.
   *
   * `is_deleted` ve `tenant_id` predikatları ZORUNLU (FARM-MEDIUM-293):
   * kapatılan bir deponun envanter satırları silinmez, lokasyonu soft-delete
   * edilir — filtresiz toplam o stoğu hâlâ "mevcut" sayıyor ve tükeniş
   * uyarısını geciktiriyordu. search_path tenant'ı yönlendirse de yazılı
   * predikat tek başına savunma değil, okunabilir sözleşmedir.
   */
  private async loadFeedStock(
    manager: EntityManager,
    tenantId: string,
  ): Promise<Array<{ siteId: string; feedId: string; totalKg: number }>> {
    const rows: Array<{ siteId: string; feedId: string; totalKg: string }> = await manager.query(
      `SELECT sl.site_id AS "siteId", si.item_id AS "feedId",
              COALESCE(SUM(si.quantity), 0) AS "totalKg"
       FROM storage_inventory si
       JOIN storage_locations sl
         ON sl.id = si.storage_location_id
        AND sl.tenant_id = si.tenant_id
        AND sl.is_deleted = false
       WHERE si.item_type = 'feed' AND si.tenant_id = $1
       GROUP BY sl.site_id, si.item_id`,
      [tenantId],
    );
    return rows.map((r) => ({ siteId: r.siteId, feedId: r.feedId, totalKg: Number(r.totalKg) }));
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
    feeds: Array<{
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
    stockRows: Array<{ siteId: string; feedId: string; totalKg: number }>,
    sitesWithStorage: Set<string>,
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
