// ============================================================================
// MCP Farm Intelligence — Cross-Domain Korelasyon Analizi Aracı
// ============================================================================
//
// Farklı domain'lerdeki metriklerin birbirleriyle ilişkisini analiz eder.
// Pearson korelasyon katsayısı ve zaman gecikmesi (time lag) hesaplar.
//
// NASIL ÇALIŞIR:
//   1. Entity'ye ait tüm domain verilerini GraphQL ile çek
//   2. Her domain'i zaman serisine dönüştür (TimeSeriesPoint[])
//   3. Bilinen korelasyon haritasından (knowledge/correlation-map.js)
//      uygulanabilir korelasyonları filtrele
//   4. Her korelasyon çifti için correlateTimeSeries() çağır
//   5. İstatistiksel anlamlılık kontrolü yap
//   6. Bilinen ilişki açıklamalarını ekle
//   7. Reliability report ekle
//
// NEDEN CROSS-DOMAIN KORELASYON?
//   Akvakültürde domain'ler birbirine bağlıdır:
//     - Sıcaklık ↑ → DO ↓ → NH₃ toksisitesi ↑ → Mortalite ↑
//   Bu ilişkileri istatistiksel olarak doğrulamak:
//     - Kök neden analizini güçlendirir
//     - Sahte korelasyonları ayıklar (p-value kontrolü)
//     - Zaman gecikmesini (lag) ortaya çıkarır → müdahale penceresi
//
// DOMAIN METRİK EŞLEMESİ:
//   - water_quality → dissolvedOxygen, ammonia, ph, temperature, nitrite
//   - feeding → daily actual feed amounts
//   - growth → weight measurements, SGR values
//   - mortality → daily mortality counts
//   - weather → temperature, wind speed
//
// EXTENSIBLE:
//   - Yeni domain metrik çiftleri METRIC_EXTRACTORS haritasına eklenir
//   - Özel korelasyon fonksiyonları (ör: Spearman) entegre edilebilir
//   - Çoklu korelasyon (3+ domain) desteği eklenebilir
//   - Korelasyon sonuçları önbelleklenebilir
// ============================================================================

import { z } from 'zod';
import type { GraphQLClient } from '../../graphql/client.js';

// ── GraphQL Sorgu İmportları ────────────────────────────────────────────────
import { fetchFeedingRecords } from '../../graphql/queries/feeding.js';
import { fetchGrowthMeasurements } from '../../graphql/queries/growth.js';
import { fetchWaterQuality } from '../../graphql/queries/water-quality.js';
import { fetchWeatherObservations } from '../../graphql/queries/weather.js';
import { fetchBatch, fetchBatchHistory } from '../../graphql/queries/batches.js';
import { fetchTank } from '../../graphql/queries/tanks.js';

// ── Analytics Modül İmportları ──────────────────────────────────────────────
import { correlateTimeSeries } from '../../analytics/correlator.js';
import type { TimeSeriesPoint, CorrelationResult } from '../../analytics/correlator.js';
import { buildReliabilityReport } from '../../analytics/reliability.js';
import type { DataSource, ReliabilityReport } from '../../analytics/reliability.js';

// ── Knowledge Modül İmportları ─────────────────────────────────────────────
import { KNOWN_CORRELATIONS } from '../../knowledge/correlation-map.js';
import type { KnownCorrelation } from '../../knowledge/correlation-map.js';

// ── Tip Tanımları ───────────────────────────────────────────────────────────

/** MCP tool sonuç tipi */
type ToolResult = { content: Array<{ type: 'text'; text: string }> };

/**
 * Korelasyon analizi sonuç çıktısı.
 *
 * MCP tool yanıtı olarak döndürülecek yapı.
 */
interface CorrelationOutput {
  correlations: Array<{
    pairId: string;
    domainA: string;
    metricA: string;
    domainB: string;
    metricB: string;
    coefficient: number;
    strength: string;
    direction: string;
    pValue: number;
    significance: boolean;
    timeLagHours: number;
    sampleSize: number;
    confidenceInterval95: { lower: number; upper: number };
    knownRelationship: string;
    warning?: string;
  }>;
  summary: {
    totalPairsTested: number;
    significantCorrelations: number;
    strongCorrelations: number;
    entity: { type: string; id: string; name: string };
    timeWindowDays: number;
  };
  /** Türkçe özet cümlesi — LLM doğrudan kullanıcıya aktarabilir */
  insight: string;
  reliability: ReliabilityReport;
}

// ── Bilinen Korelasyon Çiftleri ─────────────────────────────────────────────
//
// Akvakültürde bilinen domain-arası ilişkiler.
// Veri kaynağı: knowledge/correlation-map.ts → KNOWN_CORRELATIONS
// ─────────────────────────────────────────────────────────────────────────────

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================

export const inputSchema = z.object({
  entityId: z.string()
    .describe('Tank, Batch veya Site UUID'),

  entityType: z.enum(['tank', 'batch', 'site'])
    .describe('Varlık tipi: tank, batch veya site'),

  timeWindowDays: z.number().int().positive().default(7)
    .describe('Veri penceresi gün sayısı (varsayılan: 7)'),

  domains: z.array(z.string()).optional()
    .describe('Analiz edilecek domain filtreleri: water_quality, feeding, growth, mortality, weather'),

  includePositive: z.boolean().default(true)
    .describe('Pozitif (iyi) korelasyonlar da dahil edilsin mi? (varsayılan: true)'),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'correlate_domains',
  description:
    'Farklı domain\'lerdeki metriklerin istatistiksel ilişkisini analiz eder. ' +
    'Pearson korelasyon katsayısı, zaman gecikmesi (lag), istatistiksel anlamlılık ' +
    've güven aralığı hesaplar. Bilinen 20 korelasyon çifti otomatik test edilir.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      entityId: { type: 'string', description: 'Varlık UUID' },
      entityType: {
        type: 'string',
        enum: ['tank', 'batch', 'site'],
        description: 'Varlık tipi',
      },
      timeWindowDays: {
        type: 'integer',
        description: 'Veri penceresi gün sayısı',
        default: 7,
      },
      domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Domain filtresi',
      },
      includePositive: {
        type: 'boolean',
        description: 'Pozitif korelasyonlar dahil edilsin mi?',
        default: true,
      },
    },
    required: ['entityId', 'entityType'],
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

export async function handler(
  params: unknown,
  client: GraphQLClient,
): Promise<ToolResult> {
  const input = inputSchema.parse(params);

  // ── Tarih Aralığı ─────────────────────────────────────────────────
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (input.timeWindowDays ?? 7));
  const fromISO = from.toISOString();
  const toISO = to.toISOString();

  // ── Varlık Bilgisini Çek ──────────────────────────────────────────
  let entityName = input.entityId;
  let siteId: string | undefined;

  try {
    if (input.entityType === 'tank') {
      const tank = await fetchTank(client, input.entityId);
      entityName = tank.name || tank.code;
      siteId = tank.department?.site?.id ?? tank.department?.siteId;
    } else if (input.entityType === 'batch') {
      const batch = await fetchBatch(client, input.entityId);
      entityName = batch.batchNumber || batch.name || input.entityId;
    }
  } catch {
    // Varlık bilgisi alınamadı — ID kullanılır
  }

  // ── Domain Verilerini Çek ──────────────────────────────────────────
  //
  // Tüm domain'lerin zaman serisi verileri paralel çekilir.
  // Her domain bir Map<metricName, TimeSeriesPoint[]> olarak saklanır.
  // ──────────────────────────────────────────────────────────────────

  const domainTimeSeries = new Map<string, Map<string, TimeSeriesPoint[]>>();
  const dataSources: DataSource[] = [];
  const usedDomains: string[] = [];

  const requestedDomains = input.domains ?? ['water_quality', 'feeding', 'growth', 'mortality', 'weather'];

  // ── Paralel veri çekimi ────────────────────────────────────────────
  const [wqResult, feedingResult, growthResult, mortalityResult, weatherResult] =
    await Promise.allSettled([
      // WQ verileri
      requestedDomains.includes('water_quality')
        ? fetchWaterQuality(client, {
            tankId: input.entityType === 'tank' ? input.entityId : undefined,
            startDate: fromISO,
            endDate: toISO,
          })
        : Promise.resolve(null),

      // Yemleme verileri
      requestedDomains.includes('feeding')
        ? fetchFeedingRecords(client, {
            batchId: input.entityType === 'batch' ? input.entityId : undefined,
            tankId: input.entityType === 'tank' ? input.entityId : undefined,
            startDate: fromISO,
            endDate: toISO,
          })
        : Promise.resolve(null),

      // Büyüme verileri
      requestedDomains.includes('growth') && input.entityType === 'batch'
        ? fetchGrowthMeasurements(client, {
            batchId: input.entityId,
            startDate: fromISO,
            endDate: toISO,
          })
        : Promise.resolve(null),

      // Mortalite verileri (batch history'den)
      requestedDomains.includes('mortality') && input.entityType === 'batch'
        ? fetchBatchHistory(client, input.entityId, ['MORTALITY', 'MORTALITY_EVENT'], fromISO, toISO)
        : Promise.resolve(null),

      // Hava durumu
      requestedDomains.includes('weather') && siteId
        ? fetchWeatherObservations(client, siteId, fromISO, toISO)
        : Promise.resolve(null),
    ]);

  // ── WQ → Zaman Serisi ─────────────────────────────────────────────
  if (wqResult.status === 'fulfilled' && wqResult.value) {
    const items = 'items' in wqResult.value ? wqResult.value.items : [];
    const wqMetrics = new Map<string, TimeSeriesPoint[]>();

    const temperatureSeries: TimeSeriesPoint[] = [];
    const doSeries: TimeSeriesPoint[] = [];
    const ammoniaSeries: TimeSeriesPoint[] = [];
    const phSeries: TimeSeriesPoint[] = [];
    const nitriteSeries: TimeSeriesPoint[] = [];

    for (const m of items) {
      const ts = m.measuredAt;
      const p = m.parameters;
      if (!p) continue;

      if (p.temperature !== undefined) temperatureSeries.push({ timestamp: ts, value: p.temperature });
      if (p.dissolvedOxygen !== undefined) doSeries.push({ timestamp: ts, value: p.dissolvedOxygen });
      if (p.ammonia !== undefined) ammoniaSeries.push({ timestamp: ts, value: p.ammonia });
      if (p.pH !== undefined) phSeries.push({ timestamp: ts, value: p.pH });
      if (p.nitrite !== undefined) nitriteSeries.push({ timestamp: ts, value: p.nitrite });
    }

    if (temperatureSeries.length > 0) wqMetrics.set('temperature', temperatureSeries);
    if (doSeries.length > 0) wqMetrics.set('dissolvedOxygen', doSeries);
    if (ammoniaSeries.length > 0) wqMetrics.set('ammonia', ammoniaSeries);
    if (phSeries.length > 0) wqMetrics.set('ph', phSeries);
    if (nitriteSeries.length > 0) wqMetrics.set('nitrite', nitriteSeries);

    if (wqMetrics.size > 0) {
      domainTimeSeries.set('water_quality', wqMetrics);
      usedDomains.push('water_quality');
      dataSources.push({
        domain: 'water_quality',
        dataPointCount: items.length,
        expectedPointCount: Math.max(7, daysBetween(fromISO, toISO) * 4),
        lastDataTimestamp: items.length > 0 ? items[0]!.measuredAt : null,
        maxStaleHours: 6,
        minReliableN: 10,
      });
    }
  }

  // ── Feeding → Zaman Serisi ─────────────────────────────────────────
  if (feedingResult.status === 'fulfilled' && feedingResult.value) {
    const items = 'items' in feedingResult.value ? feedingResult.value.items : [];
    const feedingMetrics = new Map<string, TimeSeriesPoint[]>();
    const dailyAmounts: TimeSeriesPoint[] = [];

    for (const f of items) {
      dailyAmounts.push({ timestamp: f.feedingDate, value: f.actualAmount });
    }

    if (dailyAmounts.length > 0) {
      feedingMetrics.set('daily_amount', dailyAmounts);
      domainTimeSeries.set('feeding', feedingMetrics);
      usedDomains.push('feeding');
      dataSources.push({
        domain: 'feeding',
        dataPointCount: items.length,
        expectedPointCount: Math.max(7, daysBetween(fromISO, toISO) * 3),
        lastDataTimestamp: items.length > 0 ? items[0]!.feedingDate : null,
        maxStaleHours: 24,
        minReliableN: 7,
      });
    }
  }

  // ── Growth → Zaman Serisi ──────────────────────────────────────────
  if (growthResult.status === 'fulfilled' && growthResult.value) {
    const items = 'items' in growthResult.value ? growthResult.value.items : [];
    const growthMetrics = new Map<string, TimeSeriesPoint[]>();
    const weightSeries: TimeSeriesPoint[] = [];

    for (const g of items) {
      weightSeries.push({ timestamp: g.measurementDate, value: g.averageWeight });
    }

    if (weightSeries.length > 0) {
      growthMetrics.set('weight', weightSeries);
      domainTimeSeries.set('growth', growthMetrics);
      usedDomains.push('growth');
      dataSources.push({
        domain: 'growth',
        dataPointCount: items.length,
        expectedPointCount: Math.max(2, Math.ceil(daysBetween(fromISO, toISO) / 7)),
        lastDataTimestamp: items.length > 0 ? items[0]!.measurementDate : null,
        maxStaleHours: 168,
        minReliableN: 3,
      });
    }
  }

  // ── Mortality → Zaman Serisi ───────────────────────────────────────
  if (mortalityResult.status === 'fulfilled' && mortalityResult.value) {
    const items = mortalityResult.value as Array<{ timestamp: string; quantityChange?: number }>;
    const mortalityMetrics = new Map<string, TimeSeriesPoint[]>();
    const countSeries: TimeSeriesPoint[] = [];

    for (const h of items) {
      if (h.quantityChange) {
        countSeries.push({ timestamp: h.timestamp, value: Math.abs(h.quantityChange) });
      }
    }

    if (countSeries.length > 0) {
      mortalityMetrics.set('daily_count', countSeries);
      domainTimeSeries.set('mortality', mortalityMetrics);
      usedDomains.push('mortality');
      dataSources.push({
        domain: 'mortality',
        dataPointCount: countSeries.length,
        expectedPointCount: daysBetween(fromISO, toISO),
        lastDataTimestamp: countSeries.length > 0 ? countSeries[0]!.timestamp : null,
        maxStaleHours: 24,
        minReliableN: 5,
      });
    }
  }

  // ── Weather → Zaman Serisi ─────────────────────────────────────────
  if (weatherResult.status === 'fulfilled' && weatherResult.value) {
    const items = weatherResult.value as Array<{
      observedAt: string;
      temperature?: number;
      windSpeed?: number;
    }>;
    const weatherMetrics = new Map<string, TimeSeriesPoint[]>();
    const tempSeries: TimeSeriesPoint[] = [];
    const windSeries: TimeSeriesPoint[] = [];

    for (const w of items) {
      if (w.temperature !== undefined) tempSeries.push({ timestamp: w.observedAt, value: w.temperature });
      if (w.windSpeed !== undefined) windSeries.push({ timestamp: w.observedAt, value: w.windSpeed });
    }

    if (tempSeries.length > 0) weatherMetrics.set('temperature', tempSeries);
    if (windSeries.length > 0) weatherMetrics.set('windSpeed', windSeries);

    if (weatherMetrics.size > 0) {
      domainTimeSeries.set('weather', weatherMetrics);
      usedDomains.push('weather');
      dataSources.push({
        domain: 'weather',
        dataPointCount: items.length,
        expectedPointCount: daysBetween(fromISO, toISO) * 24,
        lastDataTimestamp: items.length > 0 ? items[0]!.observedAt : null,
        maxStaleHours: 6,
        minReliableN: 10,
      });
    }
  }

  // ── Korelasyon Çiftlerini Filtrele ─────────────────────────────────
  //
  // Sadece mevcut verilere sahip çiftleri test et.
  // Domain filtresi varsa ona göre de süz.
  // ──────────────────────────────────────────────────────────────────

  const applicablePairs = KNOWN_CORRELATIONS.filter(pair => {
    // Her iki domain'in verisi mevcut mu?
    const seriesMapA = domainTimeSeries.get(pair.domainA);
    const seriesMapB = domainTimeSeries.get(pair.domainB);
    if (!seriesMapA || !seriesMapB) return false;

    // İlgili metrikler mevcut mu?
    const hasA = seriesMapA.has(pair.metricA);
    const hasB = seriesMapB.has(pair.metricB);
    return hasA && hasB;
  });

  // ── Korelasyonları Hesapla ─────────────────────────────────────────
  //
  // Her geçerli çift için correlateTimeSeries() çağrılır.
  // Bu fonksiyon optimal lag'ı bulur ve Pearson r hesaplar.
  // ──────────────────────────────────────────────────────────────────

  const correlations: CorrelationOutput['correlations'] = [];

  for (const pair of applicablePairs) {
    const seriesA = domainTimeSeries.get(pair.domainA)!.get(pair.metricA)!;
    const seriesB = domainTimeSeries.get(pair.domainB)!.get(pair.metricB)!;

    // Korelasyon hesapla — optimal lag otomatik bulunur
    const result = correlateTimeSeries(seriesA, seriesB, pair.typicalLagHours);

    // Pozitif korelasyon filtresi
    if (!input.includePositive && result.direction === 'positive' && result.significance) {
      continue;
    }

    correlations.push({
      pairId: pair.id,
      domainA: pair.domainA,
      metricA: pair.metricA,
      domainB: pair.domainB,
      metricB: pair.metricB,
      coefficient: result.coefficient,
      strength: result.strength,
      direction: result.direction,
      pValue: result.pValue,
      significance: result.significance,
      timeLagHours: result.timeLagHours,
      sampleSize: result.sampleSize,
      confidenceInterval95: result.confidenceInterval95,
      knownRelationship: pair.mechanism,
      warning: result.warning,
    });
  }

  // ── Sonuçları Sırala ───────────────────────────────────────────────
  // En güçlü korelasyon başta (|r| azalan sıra)
  correlations.sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));

  // ── Güvenilirlik Raporu ────────────────────────────────────────────
  const allDomains = ['water_quality', 'feeding', 'growth', 'mortality', 'weather'];
  const reliability = buildReliabilityReport(dataSources, usedDomains, allDomains);

  // ── Özet ───────────────────────────────────────────────────────────
  const summary = {
    totalPairsTested: correlations.length,
    significantCorrelations: correlations.filter(c => c.significance).length,
    strongCorrelations: correlations.filter(c => c.strength === 'strong').length,
    entity: {
      type: input.entityType,
      id: input.entityId,
      name: entityName,
    },
    timeWindowDays: input.timeWindowDays ?? 7,
  };

  // ── Insight Cümlesi ──────────────────────────────────────────────
  const insight = generateCorrelationInsight(correlations);

  // ── Sonuç ──────────────────────────────────────────────────────────
  const output: CorrelationOutput = {
    correlations,
    summary,
    insight,
    reliability,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
  };
}

// ============================================================================
// YARDIMCI FONKSİYONLAR
// ============================================================================

/**
 * İki tarih arasındaki gün sayısını hesaplar.
 *
 * @param from - Başlangıç tarihi (ISO string)
 * @param to - Bitiş tarihi (ISO string)
 * @returns Gün sayısı (minimum 1)
 */
function daysBetween(from: string, to: string): number {
  const diffMs = new Date(to).getTime() - new Date(from).getTime();
  return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * Anlamlı korelasyonların Türkçe özet cümlesini üretir.
 *
 * LLM bu cümleyi doğrudan kullanıcıya aktarabilir; detay gerekirse
 * correlations dizisi hâlâ mevcuttur.
 */
function generateCorrelationInsight(
  correlations: CorrelationOutput['correlations'],
): string {
  const significant = correlations.filter(c => c.significance);
  if (significant.length === 0) return 'Anlamlı korelasyon bulunamadı.';

  const parts = significant.slice(0, 3).map(c =>
    `${c.domainA}:${c.metricA} ${c.direction === 'positive' ? '↑' : '↓'} → ${c.domainB}:${c.metricB} ${c.direction === 'positive' ? '↑' : '↓'} (r=${c.coefficient.toFixed(2)}, ${c.strength}${c.knownRelationship ? ', ' + c.knownRelationship : ''})`,
  );
  return `${significant.length} anlamlı korelasyon: ${parts.join('; ')}.`;
}
