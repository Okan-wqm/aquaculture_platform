// ============================================================================
// MCP Farm Intelligence — Bileşke Risk Değerlendirme Aracı
// ============================================================================
//
// 7 risk faktörünü ağırlıklı ortalama ile birleştirerek 0-100 arası
// bileşke risk skoru hesaplar. Opsiyonel olarak optimizasyon fırsatları
// ve 24h/7d risk projeksiyonu sunar.
//
// NASIL ÇALIŞIR:
//   1. Scope'a göre entity'leri belirle (farm, site, tank, batch)
//   2. Tüm risk faktörü verilerini GraphQL ile çek:
//      - Mortalite kayıtları → mortalityTrend faktörü
//      - WQ ölçümleri → waterQualityDeviation faktörü
//      - Tank bilgileri → tankDensity faktörü
//      - Sağlık olayları → activeHealthEvents faktörü
//      - Yemleme + büyüme → fcrDeviation faktörü
//      - Bakım takvimleri → overdueMaintenance faktörü
//      - Hava durumu → weatherRisk faktörü
//   3. calculateRiskScore() analytics motorunu çağır
//   4. includeOpportunities ise detectOpportunities() çağır
//   5. includeProjection ise basit trend extrapolation ile 24h/7d projeksiyonu hesapla
//   6. Reliability report ekle
//
// RİSK SEVİYELERİ:
//   0-25:  normal   → Operasyonlar sağlıklı
//   26-50: dikkat   → Bazı faktörler izlenmeli
//   51-75: uyarı    → Müdahale gerekebilir
//   76-100: kritik  → Acil müdahale şart
//
// AĞIRLIK DAĞILIMI:
//   mortalityTrend:        0.25  (en yüksek — direkt ekonomik kayıp)
//   waterQualityDeviation: 0.20  (WQ bozulması tüm sorunların kökeni)
//   tankDensity:           0.15  (yoğunluk WQ ve stres etkiler)
//   activeHealthEvents:    0.15  (mevcut hastalık/tedavi durumu)
//   fcrDeviation:          0.10  (ekonomik verimlilik)
//   overdueMaintenance:    0.10  (gelecek risk potansiyeli)
//   weatherRisk:           0.05  (çevresel, kontrol dışı)
//
// PROJEKSİYON MANTIĞI:
//   Trend kötüleşiyorsa risk skoru artma eğilimindedir.
//   Basit lineer extrapolation: projectedScore = currentScore + trendRate × hours
//   Bu tahmin kısa vadede (24-168 saat) makul doğrulukta çalışır.
//   Uzun vadede (30+ gün) doğruluk düşer — güven aralığı genişler.
//
// EXTENSIBLE:
//   - Yeni risk faktörleri eklenebilir (ağırlıklar yeniden dengelenmeli)
//   - Projeksiyon modeli karmaşıklaştırılabilir (ör: exponential, ARIMA)
//   - Sektörel benchmark karşılaştırmaları eklenebilir
//   - Risk alert'leri SMS/email entegrasyonu ile genişletilebilir
// ============================================================================

import { z } from 'zod';
import type { GraphQLClient } from '../../graphql/client.js';
import { round } from '../../utils/formatters.js';

// ── GraphQL Sorgu İmportları ────────────────────────────────────────────────
import { fetchActiveSites } from '../../graphql/queries/sites.js';
import { fetchTanks, fetchTank } from '../../graphql/queries/tanks.js';
import { fetchActiveBatches, fetchBatch } from '../../graphql/queries/batches.js';
import { fetchFeedingRecords } from '../../graphql/queries/feeding.js';
import { fetchGrowthMeasurements } from '../../graphql/queries/growth.js';
import { fetchHealthEvents } from '../../graphql/queries/health.js';
import { fetchWaterQuality } from '../../graphql/queries/water-quality.js';
import { fetchOverdueWorkOrders } from '../../graphql/queries/maintenance.js';
import {
  fetchCurrentWeather,
  type CurrentWeather,
  type EnvironmentValue,
} from '../../graphql/queries/weather.js';

// ── Analytics Modül İmportları ──────────────────────────────────────────────
import { calculateRiskScore } from '../../analytics/risk-scorer.js';
import type {
  RiskInput,
  RiskAssessment,
  RiskFactor,
  RiskAlert,
} from '../../analytics/risk-scorer.js';
import { detectOpportunities } from '../../analytics/optimizer.js';
import type { OptimizerInput, Opportunity } from '../../analytics/optimizer.js';
import { buildReliabilityReport } from '../../analytics/reliability.js';
import type { DataSource, ReliabilityReport } from '../../analytics/reliability.js';

// ── Tip Tanımları ───────────────────────────────────────────────────────────

/** MCP tool sonuç tipi */
type ToolResult = { content: Array<{ type: 'text'; text: string }> };

/** Risk projeksiyonu — 24h ve 7d sonrası tahmini risk skoru */
interface RiskProjection {
  /** Mevcut risk skoru */
  current: number;
  /** 24 saat sonrası tahmini risk skoru */
  projected24h: number;
  /** 7 gün sonrası tahmini risk skoru */
  projected7d: number;
  /** Trend yönü */
  trendDirection: 'improving' | 'stable' | 'worsening';
  /** Günlük değişim oranı (puan/gün) */
  dailyChangeRate: number;
  /** Tahmin güvenilirliği */
  projectionConfidence: 'low' | 'medium' | 'high';
}

/** Tam risk değerlendirme çıktısı */
interface RiskAssessmentOutput {
  overallRisk: number;
  riskLevel: string;
  factors: RiskFactor[];
  alerts: RiskAlert[];
  opportunities: Opportunity[];
  projection?: RiskProjection;
  /** Türkçe özet cümlesi — LLM doğrudan kullanıcıya aktarabilir */
  insight: string;
  metadata: {
    scope: string;
    entityId: string;
    entityName: string;
    assessmentTimestamp: string;
    factorsEvaluated: number;
    dataDomainsUsed: string[];
  };
  reliability: ReliabilityReport;
}

export interface WeatherRiskContext {
  weather: NonNullable<RiskInput['weather']>;
  values: EnvironmentValue[];
  lastDataTimestamp: string;
}

export function buildWeatherRiskContext(weather: CurrentWeather): WeatherRiskContext | null {
  const values = weather.metrics
    .filter(
      (value) =>
        value.freshness === 'CURRENT' &&
        (value.metric === 'AIR_TEMPERATURE' || value.metric === 'WIND_SPEED'),
    )
    .sort((left, right) => new Date(right.validAt).getTime() - new Date(left.validAt).getTime());
  const latestValue = values[0];
  if (latestValue === undefined) {
    return null;
  }

  const riskWeather: NonNullable<RiskInput['weather']> = {};
  const wind = values.find((value) => value.metric === 'WIND_SPEED');
  if (wind !== undefined) {
    riskWeather.windSpeedKph = round(wind.value * 3.6, 1);
    riskWeather.stormWarning = wind.value > 20;
  }

  const temperature = values.find((value) => value.metric === 'AIR_TEMPERATURE');
  if (temperature !== undefined) {
    riskWeather.temperatureC = temperature.value;
    riskWeather.extremeHeat = temperature.value > 35;
    riskWeather.extremeCold = temperature.value < 5;
  }

  return {
    weather: riskWeather,
    values,
    lastDataTimestamp: latestValue.validAt,
  };
}

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================

export const inputSchema = z.object({
  scope: z
    .enum(['tank', 'batch', 'site', 'farm'])
    .describe('Değerlendirme kapsamı: tank, batch, site veya farm'),

  entityId: z.string().optional().describe('Varlık UUID — scope=farm hariç zorunlu'),

  includeProjection: z
    .boolean()
    .default(false)
    .describe('24h/7d risk projeksiyonu dahil edilsin mi? — varsayılan: false'),

  includeOpportunities: z
    .boolean()
    .default(true)
    .describe('Optimizasyon fırsatları dahil edilsin mi? — varsayılan: true'),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'assess_risk',
  description:
    'Çiftliğin bileşke risk skorunu hesaplar (0-100). 7 faktör: mortalite trendi, ' +
    'su kalitesi sapması, tank yoğunluğu, aktif sağlık olayları, FCR sapması, ' +
    'geciken bakım, hava durumu riski. Opsiyonel olarak optimizasyon fırsatları ' +
    've 24h/7d risk projeksiyonu sunar.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      scope: {
        type: 'string',
        enum: ['tank', 'batch', 'site', 'farm'],
        description: 'Değerlendirme kapsamı',
      },
      entityId: { type: 'string', description: 'Varlık UUID' },
      includeProjection: {
        type: 'boolean',
        description: '24h/7d risk projeksiyonu',
        default: false,
      },
      includeOpportunities: {
        type: 'boolean',
        description: 'Optimizasyon fırsatları',
        default: true,
      },
    },
    required: ['scope'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ============================================================================
// ARAÇ İŞLEYİCİSİ (Handler)
// ============================================================================

export async function handler(params: unknown, client: GraphQLClient): Promise<ToolResult> {
  const input = inputSchema.parse(params);

  // ── Parametre Doğrulama ────────────────────────────────────────────
  if (input.scope !== 'farm' && !input.entityId) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'entityId parametresi scope=farm dışında zorunludur.',
          }),
        },
      ],
    };
  }

  // ── Tarih Aralığı ─────────────────────────────────────────────────
  // Risk skoru son 7 günlük veriye dayanır
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 7);
  const fromISO = from.toISOString();
  const toISO = to.toISOString();

  // ── Varlık Bilgisi ─────────────────────────────────────────────────
  let entityName = input.entityId ?? 'Tüm Çiftlik';
  let primarySiteId: string | undefined;

  try {
    if (input.scope === 'tank' && input.entityId) {
      const tank = await fetchTank(client, input.entityId);
      entityName = tank.name || tank.code;
      primarySiteId = tank.department?.site?.id ?? tank.department?.siteId;
    } else if (input.scope === 'batch' && input.entityId) {
      const batch = await fetchBatch(client, input.entityId);
      entityName = batch.batchNumber || batch.name || input.entityId;
    } else if (input.scope === 'site' && input.entityId) {
      primarySiteId = input.entityId;
    } else if (input.scope === 'farm') {
      // İlk aktif site'ı bul (hava durumu için)
      try {
        const sites = await fetchActiveSites(client);
        if (sites.length > 0) primarySiteId = sites[0]!.id;
      } catch {
        /* site yoksa devam */
      }
    }
  } catch {
    // ID kullanılır
  }

  // ── Tüm Risk Verilerini Paralel Çek ───────────────────────────────
  //
  // 7 farklı domain'den veri çekilir.
  // Her domain bir risk faktörünü besler.
  // ──────────────────────────────────────────────────────────────────

  const dataSources: DataSource[] = [];
  const usedDomains: string[] = [];

  // Filtreler
  const wqFilter: { tankId?: string; startDate?: string; endDate?: string } = {
    startDate: fromISO,
    endDate: toISO,
  };
  if (input.scope === 'tank' && input.entityId) wqFilter.tankId = input.entityId;

  const feedingFilter: { batchId?: string; tankId?: string; startDate?: string; endDate?: string } =
    {
      startDate: fromISO,
      endDate: toISO,
    };
  if (input.scope === 'batch' && input.entityId) feedingFilter.batchId = input.entityId;
  if (input.scope === 'tank' && input.entityId) feedingFilter.tankId = input.entityId;

  const healthFilter: { batchId?: string; tankId?: string } = {};
  if (input.scope === 'batch' && input.entityId) healthFilter.batchId = input.entityId;
  if (input.scope === 'tank' && input.entityId) healthFilter.tankId = input.entityId;

  const growthFilter: { batchId?: string; startDate?: string; endDate?: string } = {
    startDate: fromISO,
    endDate: toISO,
  };
  if (input.scope === 'batch' && input.entityId) growthFilter.batchId = input.entityId;

  const [
    tanksResult,
    wqResult,
    feedingResult,
    healthResult,
    overdueResult,
    weatherResult,
    growthResult,
  ] = await Promise.allSettled([
    input.scope === 'tank' && input.entityId
      ? fetchTank(client, input.entityId).then((t) => ({ items: [t] }))
      : fetchTanks(client, { isActive: true }),
    fetchWaterQuality(client, wqFilter),
    fetchFeedingRecords(client, feedingFilter),
    fetchHealthEvents(client, healthFilter),
    fetchOverdueWorkOrders(client),
    primarySiteId ? fetchCurrentWeather(client, primarySiteId) : Promise.resolve(null),
    fetchGrowthMeasurements(client, growthFilter),
  ]);

  // ── RiskInput Hazırla ──────────────────────────────────────────────
  const riskInput: RiskInput = {};
  const optimizerInput: OptimizerInput = {};

  // ── Tanklar ────────────────────────────────────────────────────────
  if (tanksResult.status === 'fulfilled') {
    const tanks = tanksResult.value.items ?? [];
    riskInput.tanks = tanks.map((t) => ({
      id: t.id,
      name: t.name,
      currentBiomass: t.currentBiomass,
      volume: t.effectiveVolume || t.volume,
      maxDensity: t.maxDensity,
    }));
    optimizerInput.tanks = riskInput.tanks;
    usedDomains.push('density');
    dataSources.push({
      domain: 'density',
      dataPointCount: tanks.length,
      expectedPointCount: Math.max(1, tanks.length),
      lastDataTimestamp: new Date().toISOString(),
      maxStaleHours: 24,
      minReliableN: 1,
    });
  }

  // ── WQ ─────────────────────────────────────────────────────────────
  if (wqResult.status === 'fulfilled') {
    const items = wqResult.value.items ?? [];
    riskInput.waterQualityMeasurements = items.map((m) => ({
      tankId: m.tankId ?? '',
      temperature: m.parameters?.temperature,
      ph: m.parameters?.pH,
      dissolvedOxygen: m.parameters?.dissolvedOxygen,
      ammonia: m.parameters?.ammonia,
      nitrite: m.parameters?.nitrite,
      nitrate: m.parameters?.nitrate,
    }));
    optimizerInput.waterQuality = riskInput.waterQualityMeasurements?.map((wq) => ({
      tankId: wq.tankId,
      temperature: wq.temperature,
      ph: wq.ph,
      dissolvedOxygen: wq.dissolvedOxygen,
      ammonia: wq.ammonia,
      nitrite: wq.nitrite,
      nitrate: wq.nitrate,
    }));
    usedDomains.push('water_quality');
    dataSources.push({
      domain: 'water_quality',
      dataPointCount: items.length,
      expectedPointCount: Math.max(7, 7 * 4),
      lastDataTimestamp: items.length > 0 ? items[0]!.measuredAt : null,
      maxStaleHours: 6,
      minReliableN: 10,
    });
  }

  // ── Yemleme ────────────────────────────────────────────────────────
  if (feedingResult.status === 'fulfilled') {
    const items = feedingResult.value.items ?? [];
    riskInput.feedingRecords = items.map((f) => ({ actual: f.actualAmount }));
    optimizerInput.feedingRecords = items.map((f) => ({
      date: f.feedingDate,
      batchId: f.batchId,
      tankId: f.tankId,
      planned: f.plannedAmount,
      actual: f.actualAmount,
    }));
    usedDomains.push('feeding');
    dataSources.push({
      domain: 'feeding',
      dataPointCount: items.length,
      expectedPointCount: Math.max(7, 7 * 3),
      lastDataTimestamp: items.length > 0 ? items[0]!.feedingDate : null,
      maxStaleHours: 24,
      minReliableN: 7,
    });
  }

  // ── Sağlık ─────────────────────────────────────────────────────────
  if (healthResult.status === 'fulfilled') {
    const items = healthResult.value.items ?? [];
    riskInput.healthEvents = items.map((h) => ({
      id: h.id,
      severity: h.severity as 'low' | 'medium' | 'high' | 'critical',
      status: h.status,
    }));
    usedDomains.push('health');
    dataSources.push({
      domain: 'health',
      dataPointCount: items.length,
      expectedPointCount: 1,
      lastDataTimestamp: items.length > 0 ? items[0]!.createdAt : null,
      maxStaleHours: 24,
      minReliableN: 1,
    });
  }

  // ── Bakım ──────────────────────────────────────────────────────────
  if (overdueResult.status === 'fulfilled') {
    const items = overdueResult.value ?? [];
    riskInput.maintenanceSchedules = items.map((wo) => ({
      dueDate: wo.dueDate ?? wo.createdAt,
      status: wo.status,
    }));
    usedDomains.push('maintenance');
    dataSources.push({
      domain: 'maintenance',
      dataPointCount: items.length,
      expectedPointCount: 1,
      lastDataTimestamp: items.length > 0 ? items[0]!.createdAt : null,
      maxStaleHours: 48,
      minReliableN: 1,
    });
  }

  // ── Büyüme ─────────────────────────────────────────────────────────
  if (growthResult.status === 'fulfilled') {
    const items = growthResult.value.items ?? [];
    riskInput.growthData = items.map((g) => ({
      batchId: g.batchId,
      date: g.measurementDate,
      avgWeight: g.averageWeight,
    }));
    optimizerInput.growthData = items.map((g) => ({
      batchId: g.batchId,
      date: g.measurementDate,
      avgWeight: g.averageWeight,
      sgr: g.specificGrowthRate ?? undefined,
    }));
    usedDomains.push('growth');
    dataSources.push({
      domain: 'growth',
      dataPointCount: items.length,
      expectedPointCount: Math.max(1, Math.ceil(7 / 7)),
      lastDataTimestamp: items.length > 0 ? items[0]!.measurementDate : null,
      maxStaleHours: 168,
      minReliableN: 2,
    });
  }

  // ── Hava Durumu ────────────────────────────────────────────────────
  if (weatherResult.status === 'fulfilled' && weatherResult.value) {
    const context = buildWeatherRiskContext(weatherResult.value);
    if (context !== null) {
      riskInput.weather = context.weather;
      usedDomains.push('weather');
      dataSources.push({
        domain: 'weather',
        dataPointCount: context.values.length,
        expectedPointCount: 2,
        lastDataTimestamp: context.lastDataTimestamp,
        maxStaleHours: 6,
        minReliableN: 1,
      });
    }
  }

  // ── Risk Skoru Hesapla ─────────────────────────────────────────────
  //
  // calculateRiskScore() analytics motorunu çağır.
  // Motor 7 faktörü ağırlıklı ortalama ile birleştirir.
  // ──────────────────────────────────────────────────────────────────

  const riskAssessment: RiskAssessment = calculateRiskScore(riskInput);

  // ── Optimizasyon Fırsatları (Opsiyonel) ────────────────────────────
  //
  // detectOpportunities() çağrılır.
  // Risk değerlendirmesinin "saldırı" tarafı — neyin daha iyi olabileceği.
  // ──────────────────────────────────────────────────────────────────

  let opportunities: Opportunity[] = [];
  if (input.includeOpportunities) {
    opportunities = detectOpportunities(optimizerInput);
  }

  // ── Risk Projeksiyonu (Opsiyonel) ──────────────────────────────────
  //
  // NASIL ÇALIŞIR:
  //   1. Kötüleşme trendindeki faktörlerin sayısını belirle
  //   2. İyileşme trendindeki faktörlerin sayısını belirle
  //   3. Net trend yönü = kötüleşme - iyileşme
  //   4. Günlük değişim oranı = net_trend * 3 (puan/gün)
  //   5. Projeksiyon: mevcut + oran × süre
  //   6. Sonucu [0, 100] aralığında sınırla
  //
  // Bu basit lineer model kısa vadede (1-7 gün) makul tahminler üretir.
  // Uzun vadede (30+ gün) güvenilirliği düşer — güven seviyesi buna göre atanır.
  //
  // EXTENSIBLE:
  //   - Exponential trend modeli eklenebilir
  //   - Mevsimsel düzeltme eklenebilir
  //   - Monte Carlo simülasyonu ile güven aralığı hesaplanabilir
  // ──────────────────────────────────────────────────────────────────

  let projection: RiskProjection | undefined;
  if (input.includeProjection) {
    projection = calculateProjection(riskAssessment);
  }

  // ── Güvenilirlik Raporu ────────────────────────────────────────────
  const allDomains = [
    'water_quality',
    'feeding',
    'growth',
    'health',
    'maintenance',
    'density',
    'weather',
  ];
  const reliability = buildReliabilityReport(dataSources, usedDomains, allDomains);

  // ── Insight Cümlesi ──────────────────────────────────────────────
  const insight = generateRiskInsight(
    riskAssessment.overallRisk,
    riskAssessment.riskLevel,
    riskAssessment.factors,
    riskAssessment.alerts,
  );

  // ── Sonuç ──────────────────────────────────────────────────────────
  const output: RiskAssessmentOutput = {
    overallRisk: riskAssessment.overallRisk,
    riskLevel: riskAssessment.riskLevel,
    factors: riskAssessment.factors,
    alerts: riskAssessment.alerts,
    opportunities,
    projection,
    insight,
    metadata: {
      scope: input.scope,
      entityId: input.entityId ?? 'farm-wide',
      entityName,
      assessmentTimestamp: new Date().toISOString(),
      factorsEvaluated: riskAssessment.factors.length,
      dataDomainsUsed: usedDomains,
    },
    reliability,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
  };
}

// ============================================================================
// PROJEKSİYON HESAPLAMA
// ============================================================================
//
// NASIL ÇALIŞIR:
//   1. Her risk faktörünün trend yönüne bak
//   2. Kötüleşme (worsening) sayısı ve iyileşme (improving) sayısını hesapla
//   3. Net trend = worsening_count - improving_count
//   4. Günlük değişim oranı = net_trend × 3 puan/gün
//      (her kötüleşen faktör günde ~3 puan risk artışı ekler)
//   5. 24h projeksiyon = mevcut + oran × 1
//   6. 7d projeksiyon = mevcut + oran × 7
//   7. [0, 100] sınırlaması uygula
//
// EXTENSIBLE:
//   - Faktör bazlı ağırlıklı projeksiyon eklenebilir
//   - Geçmiş risk skorları ile trend doğrulanabilir
//   - Mevsimsel kalıplar (yaz sıcaklığı vb.) hesaba katılabilir
// ============================================================================

function calculateProjection(assessment: RiskAssessment): RiskProjection {
  // ── Trend Analizi ──────────────────────────────────────────────────
  let worseningCount = 0;
  let improvingCount = 0;

  for (const factor of assessment.factors) {
    if (factor.trend === 'worsening') worseningCount++;
    if (factor.trend === 'improving') improvingCount++;
  }

  // Net trend yönü
  const netTrend = worseningCount - improvingCount;

  // Trend yönü etiketi
  let trendDirection: RiskProjection['trendDirection'];
  if (netTrend > 0) {
    trendDirection = 'worsening';
  } else if (netTrend < 0) {
    trendDirection = 'improving';
  } else {
    trendDirection = 'stable';
  }

  // ── Günlük Değişim Oranı ──────────────────────────────────────────
  //
  // Her kötüleşen faktör günde ~3 puan risk artışı ekler.
  // Her iyileşen faktör günde ~2 puan risk azaltması sağlar (asimetrik).
  // Asimetri nedeni: kötüleşme iyileşmeden hızlı ilerler.
  //
  const dailyChangeRate = round(worseningCount * 3 - improvingCount * 2, 2);

  // ── Projeksiyon Hesabı ─────────────────────────────────────────────
  const current = assessment.overallRisk;
  const projected24h = clamp(current + dailyChangeRate * 1, 0, 100);
  const projected7d = clamp(current + dailyChangeRate * 7, 0, 100);

  // ── Projeksiyon Güvenilirliği ──────────────────────────────────────
  //
  // Güven seviyesi:
  //   - Veri faktörleri çok varsa ve trend tutarlıysa → high
  //   - Bazı faktörler karışık trendde → medium
  //   - Az veri veya çelişkili trendler → low
  //
  const factorsWithData = assessment.factors.filter((f) => f.dataPoints > 0).length;
  let projectionConfidence: RiskProjection['projectionConfidence'];

  if (factorsWithData >= 5 && (worseningCount === 0 || improvingCount === 0)) {
    projectionConfidence = 'high';
  } else if (factorsWithData >= 3) {
    projectionConfidence = 'medium';
  } else {
    projectionConfidence = 'low';
  }

  return {
    current: round(current, 1),
    projected24h: round(projected24h, 1),
    projected7d: round(projected7d, 1),
    trendDirection,
    dailyChangeRate,
    projectionConfidence,
  };
}

// ============================================================================
// YARDIMCI FONKSİYONLAR
// ============================================================================

/**
 * Değeri min-max aralığında sınırlar.
 *
 * @param value - Sınırlanacak değer
 * @param min - Minimum sınır
 * @param max - Maksimum sınır
 * @returns Sınırlanmış değer
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Risk değerlendirmesinin Türkçe özet cümlesini üretir.
 *
 * LLM bu cümleyi doğrudan kullanıcıya aktarabilir; detay gerekirse
 * factors ve alerts dizileri hâlâ mevcuttur.
 */
function generateRiskInsight(
  risk: number,
  level: string,
  factors: RiskFactor[],
  alerts: RiskAlert[],
): string {
  const worstFactor =
    factors.length > 0 ? factors.reduce((a, b) => (a.score > b.score ? a : b)) : null;
  const criticalAlerts = alerts.filter((a) => a.priority === 'critical' || a.priority === 'high');

  const levelLabel = level.toUpperCase();
  const factorPart = worstFactor
    ? `Ana faktör: ${worstFactor.name} (${worstFactor.score}/100, ${worstFactor.trend}).`
    : '';
  const alertPart =
    criticalAlerts.length > 0 ? `${criticalAlerts.length} kritik uyarı var.` : 'Kritik uyarı yok.';

  return `Risk skoru: ${risk}/100 (${levelLabel}). ${factorPart} ${alertPart}`.trim();
}
