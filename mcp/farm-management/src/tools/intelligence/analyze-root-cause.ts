// ============================================================================
// MCP Farm Intelligence — Kök Neden Analizi Aracı
// ============================================================================
//
// Bir anomali olayının olası nedenlerini skorlayarak sıralar ve
// kaskad etkilerini tahmin eder.
//
// NASIL ÇALIŞIR:
//   1. Olay zamanını belirle (eventDate veya şimdi)
//   2. Lookback window'da tüm domain'leri GraphQL ile tara
//   3. Her potansiyel neden için skor hesapla:
//      - Zaman yakınlığı (timeProximityScore): Olaya ne kadar yakın?
//        Yakın = yüksek skor. Formül: max(0, 1 - hoursBeforeEvent / lookbackHours)
//      - İstatistiksel sapma (deviationScore): Z-score veya threshold aşımı
//        Formül: min(1, |zScore| / 4)
//      - Bilinen nedensellik (knownCausalityBonus): Cascade chains bilgi
//        tabanında bu neden → bu etki ilişkisi var mı? +0.3 bonus
//   4. Toplam skor: timeProximity * 0.4 + deviation * 0.35 + causality * 0.25
//   5. Skorlara göre sırala (en olası neden ilk)
//   6. includeCascadePrediction ise predictCascade() çağır
//   7. Veri boşluklarını tespit et (dataGaps)
//   8. Reliability report ekle
//
// SKOR FORMÜLÜ:
//   totalScore = timeProximityScore * 0.40
//              + deviationScore      * 0.35
//              + knownCausalityBonus * 0.25
//   confidence = min(1, totalScore)
//
// NEDEN BU AĞIRLIKLAR?
//   - timeProximity (0.40): En önemli sinyal. Akvakültürde neden-sonuç
//     ilişkisi genelde saatler içinde ortaya çıkar. Olaya yakın olan
//     değişiklikler daha güçlü aday.
//   - deviation (0.35): İstatistiksel sapma ne kadar büyükse, o değişikliğin
//     rastgele olmama olasılığı o kadar yüksek.
//   - knownCausality (0.25): Bilimsel bilgi tabanı — bilinen neden-sonuç
//     ilişkileri önceden tanımlanmıştır. Bu bonus, bilinen ilişkileri öne çıkarır.
//
// EXTENSIBLE:
//   - Yeni olay tipleri (ör: disease_outbreak) EVENT_TYPE_TRIGGERS'a eklenir
//   - Ağırlıklar konfigüre edilebilir hale getirilebilir
//   - Makine öğrenmesi modelleri skor hesaplamasına entegre edilebilir
//   - Çoklu neden (multi-causal) analizi desteği eklenebilir
// ============================================================================

import { z } from 'zod';
import type { GraphQLClient } from '../../graphql/client.js';
import { round } from '../../utils/formatters.js';
import { getThresholds } from '../../knowledge/thresholds.js';

// ── GraphQL Sorgu İmportları ────────────────────────────────────────────────
import { fetchTank } from '../../graphql/queries/tanks.js';
import { fetchBatch, fetchBatchHistory } from '../../graphql/queries/batches.js';
import { fetchFeedingRecords } from '../../graphql/queries/feeding.js';
import { fetchGrowthMeasurements } from '../../graphql/queries/growth.js';
import { fetchHealthEvents } from '../../graphql/queries/health.js';
import { fetchWaterQuality } from '../../graphql/queries/water-quality.js';
import { fetchOverdueWorkOrders } from '../../graphql/queries/maintenance.js';

// ── Analytics Modül İmportları ──────────────────────────────────────────────
import { predictCascade, matchTrigger } from '../../analytics/cascade-predictor.js';
import type { CascadePrediction } from '../../analytics/cascade-predictor.js';
import { buildReliabilityReport } from '../../analytics/reliability.js';
import type { DataSource, ReliabilityReport } from '../../analytics/reliability.js';

// ── Tip Tanımları ───────────────────────────────────────────────────────────

/** MCP tool sonuç tipi */
type ToolResult = { content: Array<{ type: 'text'; text: string }> };

/**
 * Potansiyel neden — skor hesaplaması sonucu.
 *
 * Her neden, olayı açıklama potansiyeli ile sıralanır.
 */
interface PossibleCause {
  /** Neden tipi (ör: 'ammonia_high', 'temperature_deviation', 'feeding_excess') */
  causeType: string;

  /** İlişkili domain */
  domain: string;

  /** İlişkili metrik */
  metric: string;

  /** Türkçe açıklama */
  description: string;

  /** Mevcut değer */
  currentValue: number;

  /** Normal/beklenen değer */
  expectedValue: number;

  /** Sapma miktarı */
  deviation: number;

  /** Olaydan kaç saat önce tespit edildi */
  hoursBeforeEvent: number;

  /** Toplam güvenilirlik skoru (0-1) */
  confidence: number;

  /** Alt skor detayları */
  scoring: {
    timeProximityScore: number;
    deviationScore: number;
    knownCausalityBonus: number;
    totalScore: number;
  };

  /** Bilinen nedensellik ilişkisi (varsa) */
  knownRelationship?: string;
}

/** Veri boşluğu — analiz edilemeyen alanlar */
interface DataGap {
  domain: string;
  reason: string;
  impact: string;
}

/** Kök neden analizi sonucu */
interface RootCauseResult {
  event: {
    type: string;
    entityType: string;
    entityId: string;
    entityName: string;
    eventDate: string;
    lookbackHours: number;
  };
  possibleCauses: PossibleCause[];
  cascadePrediction?: CascadePrediction;
  dataGaps: DataGap[];
  /** Türkçe özet cümlesi — LLM doğrudan kullanıcıya aktarabilir */
  insight: string;
  reliability: ReliabilityReport;
}

// ── Bilinen Nedensellik Haritası ────────────────────────────────────────────
//
// Olay tipi → bilinen potansiyel nedenler.
// Bu harita, knownCausalityBonus hesaplamasında kullanılır.
//
// EXTENSIBLE: Yeni olay tipi → neden ilişkileri bu haritaya eklenir.
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_CAUSES: Record<string, string[]> = {
  mortality_spike: [
    'ammonia_high', 'dissolved_oxygen_low', 'temperature_deviation',
    'nitrite_high', 'disease_event', 'density_overload', 'feeding_excess',
  ],
  growth_slowdown: [
    'temperature_deviation', 'feeding_deficit', 'density_overload',
    'dissolved_oxygen_low', 'disease_event', 'ammonia_high',
  ],
  fcr_degradation: [
    'feeding_excess', 'temperature_deviation', 'disease_event',
    'density_overload', 'growth_slowdown',
  ],
  water_quality_alert: [
    'feeding_excess', 'density_overload', 'maintenance_overdue',
    'temperature_deviation', 'biofilter_failure',
  ],
  health_event: [
    'ammonia_high', 'dissolved_oxygen_low', 'temperature_deviation',
    'density_overload', 'nitrite_high',
  ],
  appetite_loss: [
    'ammonia_high', 'dissolved_oxygen_low', 'temperature_deviation',
    'disease_event', 'ph_deviation',
  ],
  custom: [],
};

// ── Olay Tipi → Cascade Trigger Eşlemesi ────────────────────────────────────
//
// Kök neden analizinden kaskad tahminine geçiş.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_TO_TRIGGER: Record<string, string[]> = {
  mortality_spike: ['ammonia_spike', 'dissolved_oxygen_drop', 'temperature_deviation', 'density_overload'],
  water_quality_alert: ['ammonia_spike', 'dissolved_oxygen_drop', 'temperature_deviation'],
  appetite_loss: ['ammonia_spike', 'temperature_deviation'],
  growth_slowdown: ['temperature_deviation', 'density_overload'],
  fcr_degradation: ['feeding_excess'],
  health_event: ['ammonia_spike', 'dissolved_oxygen_drop'],
};

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================

export const inputSchema = z.object({
  eventType: z.enum([
    'mortality_spike', 'growth_slowdown', 'fcr_degradation',
    'water_quality_alert', 'health_event', 'appetite_loss', 'custom',
  ]).describe('Analiz edilecek olay tipi'),

  entityId: z.string()
    .describe('Tank veya Batch UUID'),

  entityType: z.enum(['tank', 'batch'])
    .describe('Varlık tipi'),

  eventDate: z.string().optional()
    .describe('Olay tarihi (ISO 8601) — varsayılan: şimdi'),

  lookbackHours: z.number().positive().default(72)
    .describe('Geriye bakış penceresi (saat) — varsayılan: 72'),

  includeCascadePrediction: z.boolean().default(true)
    .describe('Kaskad tahmin analizi dahil edilsin mi? — varsayılan: true'),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'analyze_root_cause',
  description:
    'Bir anomali olayının kök nedenini analiz eder. Lookback penceresi içindeki ' +
    'tüm domain\'leri tarar, her potansiyel nedeni skorlar (zaman yakınlığı, ' +
    'istatistiksel sapma, bilinen nedensellik) ve sıralar. Opsiyonel olarak ' +
    'kaskad etkilerini tahmin eder.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      eventType: {
        type: 'string',
        enum: ['mortality_spike', 'growth_slowdown', 'fcr_degradation',
               'water_quality_alert', 'health_event', 'appetite_loss', 'custom'],
        description: 'Olay tipi',
      },
      entityId: { type: 'string', description: 'Tank veya Batch UUID' },
      entityType: { type: 'string', enum: ['tank', 'batch'], description: 'Varlık tipi' },
      eventDate: { type: 'string', description: 'Olay tarihi (ISO) — varsayılan: şimdi' },
      lookbackHours: { type: 'number', description: 'Geriye bakış penceresi (saat)', default: 72 },
      includeCascadePrediction: { type: 'boolean', description: 'Kaskad tahmini', default: true },
    },
    required: ['eventType', 'entityId', 'entityType'],
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

  // ── Olay Zamanı ve Lookback Penceresi ──────────────────────────────
  const eventDate = input.eventDate ? new Date(input.eventDate) : new Date();
  const lookbackHours = input.lookbackHours ?? 72;
  const lookbackStart = new Date(eventDate.getTime() - lookbackHours * 60 * 60 * 1000);
  const fromISO = lookbackStart.toISOString();
  const eventISO = eventDate.toISOString();

  // ── Varlık Bilgisi ─────────────────────────────────────────────────
  let entityName = input.entityId;
  try {
    if (input.entityType === 'tank') {
      const tank = await fetchTank(client, input.entityId);
      entityName = tank.name || tank.code;
    } else {
      const batch = await fetchBatch(client, input.entityId);
      entityName = batch.batchNumber || batch.name || input.entityId;
    }
  } catch {
    // ID kullanılır
  }

  // ── Tüm Domain Verilerini Çek ─────────────────────────────────────
  //
  // Lookback penceresi içindeki tüm verileri paralel çek.
  // Her domain'den potansiyel nedenler çıkarılacak.
  // ──────────────────────────────────────────────────────────────────

  const dataGaps: DataGap[] = [];
  const dataSources: DataSource[] = [];
  const usedDomains: string[] = [];
  const possibleCauses: PossibleCause[] = [];

  // ── Paralel Sorgular ───────────────────────────────────────────────
  const wqFilter = {
    tankId: input.entityType === 'tank' ? input.entityId : undefined,
    startDate: fromISO,
    endDate: eventISO,
  };
  const feedingFilter = {
    batchId: input.entityType === 'batch' ? input.entityId : undefined,
    tankId: input.entityType === 'tank' ? input.entityId : undefined,
    startDate: fromISO,
    endDate: eventISO,
  };
  const healthFilter = {
    batchId: input.entityType === 'batch' ? input.entityId : undefined,
    tankId: input.entityType === 'tank' ? input.entityId : undefined,
    startDate: fromISO,
    endDate: eventISO,
  };

  const [wqResult, feedingResult, healthResult, maintenanceResult] =
    await Promise.allSettled([
      fetchWaterQuality(client, wqFilter),
      fetchFeedingRecords(client, feedingFilter),
      fetchHealthEvents(client, healthFilter),
      fetchOverdueWorkOrders(client),
    ]);

  // ── WQ Neden Analizi ───────────────────────────────────────────────
  //
  // Su kalitesi parametrelerinde sapma varsa potansiyel neden olarak ekle.
  // Her parametre için ayrı analiz yapılır.
  // ──────────────────────────────────────────────────────────────────

  if (wqResult.status === 'fulfilled') {
    const items = wqResult.value.items ?? [];
    usedDomains.push('water_quality');
    dataSources.push({
      domain: 'water_quality',
      dataPointCount: items.length,
      expectedPointCount: Math.max(1, Math.ceil(lookbackHours / 6)),
      lastDataTimestamp: items.length > 0 ? items[0]!.measuredAt : null,
      maxStaleHours: 6,
      minReliableN: 5,
    });

    // Default thresholds — knowledge/thresholds.ts'den
    const thresholds = getThresholds();

    // Son WQ ölçümlerini analiz et
    for (const m of items) {
      const p = m.parameters;
      if (!p) continue;

      const hoursBeforeEvent = (eventDate.getTime() - new Date(m.measuredAt).getTime()) / (1000 * 60 * 60);

      // Amonyak
      if (p.ammonia !== undefined && p.ammonia > thresholds.ammonia.warning) {
        const deviation = p.ammonia / thresholds.ammonia.warning;
        possibleCauses.push(buildCause(
          'ammonia_high', 'water_quality', 'ammonia',
          `NH₃ seviyesi yüksek: ${p.ammonia} mg/L (uyarı: ${thresholds.ammonia.warning} mg/L)`,
          p.ammonia, thresholds.ammonia.warning, deviation,
          hoursBeforeEvent, lookbackHours, input.eventType,
        ));
      }

      // Çözünmüş Oksijen
      if (p.dissolvedOxygen !== undefined && p.dissolvedOxygen < thresholds.dissolvedOxygen.min) {
        const deviation = (thresholds.dissolvedOxygen.min - p.dissolvedOxygen) / thresholds.dissolvedOxygen.min;
        possibleCauses.push(buildCause(
          'dissolved_oxygen_low', 'water_quality', 'dissolvedOxygen',
          `DO seviyesi düşük: ${p.dissolvedOxygen} mg/L (min: ${thresholds.dissolvedOxygen.min} mg/L)`,
          p.dissolvedOxygen, thresholds.dissolvedOxygen.min, deviation * 4,
          hoursBeforeEvent, lookbackHours, input.eventType,
        ));
      }

      // Sıcaklık
      if (p.temperature !== undefined &&
          (p.temperature < thresholds.temperature.min || p.temperature > thresholds.temperature.max)) {
        const deviation = Math.abs(p.temperature - thresholds.temperature.optimal) /
                          (thresholds.temperature.max - thresholds.temperature.min);
        possibleCauses.push(buildCause(
          'temperature_deviation', 'water_quality', 'temperature',
          `Sıcaklık sapması: ${p.temperature}°C (optimal: ${thresholds.temperature.optimal}°C)`,
          p.temperature, thresholds.temperature.optimal, deviation * 4,
          hoursBeforeEvent, lookbackHours, input.eventType,
        ));
      }

      // Nitrit
      if (p.nitrite !== undefined && p.nitrite > thresholds.nitrite.warning) {
        const deviation = p.nitrite / thresholds.nitrite.warning;
        possibleCauses.push(buildCause(
          'nitrite_high', 'water_quality', 'nitrite',
          `NO₂ seviyesi yüksek: ${p.nitrite} mg/L (uyarı: ${thresholds.nitrite.warning} mg/L)`,
          p.nitrite, thresholds.nitrite.warning, deviation,
          hoursBeforeEvent, lookbackHours, input.eventType,
        ));
      }

      // pH
      if (p.pH !== undefined && (p.pH < thresholds.ph.min || p.pH > thresholds.ph.max)) {
        const deviation = Math.abs(p.pH - thresholds.ph.optimal) * 2;
        possibleCauses.push(buildCause(
          'ph_deviation', 'water_quality', 'pH',
          `pH sapması: ${p.pH} (optimal: ${thresholds.ph.optimal})`,
          p.pH, thresholds.ph.optimal, deviation,
          hoursBeforeEvent, lookbackHours, input.eventType,
        ));
      }
    }

    if (items.length === 0) {
      dataGaps.push({
        domain: 'water_quality',
        reason: 'Lookback penceresi içinde WQ ölçümü bulunamadı',
        impact: 'Su kalitesi kaynaklı nedenler tespit edilemedi',
      });
    }
  } else {
    dataGaps.push({
      domain: 'water_quality',
      reason: 'WQ sorgusu başarısız',
      impact: 'Su kalitesi kaynaklı nedenler analiz edilemedi',
    });
  }

  // ── Yemleme Neden Analizi ──────────────────────────────────────────
  if (feedingResult.status === 'fulfilled') {
    const items = feedingResult.value.items ?? [];
    usedDomains.push('feeding');
    dataSources.push({
      domain: 'feeding',
      dataPointCount: items.length,
      expectedPointCount: Math.max(1, Math.ceil(lookbackHours / 8)),
      lastDataTimestamp: items.length > 0 ? items[0]!.feedingDate : null,
      maxStaleHours: 24,
      minReliableN: 3,
    });

    // Yemleme sapması kontrol
    for (const f of items) {
      if (f.plannedAmount <= 0) continue;

      const ratio = f.actualAmount / f.plannedAmount;
      const hoursBeforeEvent = (eventDate.getTime() - new Date(f.feedingDate).getTime()) / (1000 * 60 * 60);

      if (ratio > 1.3) {
        possibleCauses.push(buildCause(
          'feeding_excess', 'feeding', 'feed_amount',
          `Aşırı yemleme: ${f.actualAmount.toFixed(1)} kg (plan: ${f.plannedAmount.toFixed(1)} kg, +%${((ratio - 1) * 100).toFixed(0)})`,
          f.actualAmount, f.plannedAmount, (ratio - 1) * 4,
          hoursBeforeEvent, lookbackHours, input.eventType,
        ));
      } else if (ratio < 0.6) {
        possibleCauses.push(buildCause(
          'feeding_deficit', 'feeding', 'feed_amount',
          `Yemleme eksikliği: ${f.actualAmount.toFixed(1)} kg (plan: ${f.plannedAmount.toFixed(1)} kg, -%${((1 - ratio) * 100).toFixed(0)})`,
          f.actualAmount, f.plannedAmount, (1 - ratio) * 4,
          hoursBeforeEvent, lookbackHours, input.eventType,
        ));
      }
    }
  } else {
    dataGaps.push({
      domain: 'feeding',
      reason: 'Yemleme sorgusu başarısız',
      impact: 'Yemleme kaynaklı nedenler analiz edilemedi',
    });
  }

  // ── Sağlık Olayları Neden Analizi ──────────────────────────────────
  if (healthResult.status === 'fulfilled') {
    const items = healthResult.value.items ?? [];
    usedDomains.push('health');
    dataSources.push({
      domain: 'health',
      dataPointCount: items.length,
      expectedPointCount: 1,
      lastDataTimestamp: items.length > 0 ? items[0]!.createdAt : null,
      maxStaleHours: 24,
      minReliableN: 1,
    });

    for (const h of items) {
      // Şema tek bir `eventDate` taşır (eski startDate alanı yoktur).
      const hoursBeforeEvent = (eventDate.getTime() - new Date(h.eventDate).getTime()) / (1000 * 60 * 60);
      const severityScore = h.severity === 'critical' ? 4 : h.severity === 'high' ? 3 : h.severity === 'medium' ? 2 : 1;

      possibleCauses.push(buildCause(
        'disease_event', 'health', 'health_event',
        `Sağlık olayı: ${h.title} (şiddet: ${h.severity}, durum: ${h.status})`,
        severityScore, 0, severityScore,
        hoursBeforeEvent, lookbackHours, input.eventType,
      ));
    }
  }

  // ── Bakım Neden Analizi ────────────────────────────────────────────
  if (maintenanceResult.status === 'fulfilled') {
    const items = maintenanceResult.value ?? [];
    usedDomains.push('maintenance');
    dataSources.push({
      domain: 'maintenance',
      dataPointCount: items.length,
      expectedPointCount: 1,
      lastDataTimestamp: items.length > 0 ? items[0]!.createdAt : null,
      maxStaleHours: 48,
      minReliableN: 1,
    });

    for (const wo of items) {
      if (!wo.dueDate) continue;
      const delayDays = (Date.now() - new Date(wo.dueDate).getTime()) / (1000 * 60 * 60 * 24);
      if (delayDays > 0) {
        possibleCauses.push(buildCause(
          'maintenance_overdue', 'maintenance', 'work_order',
          `Gecikmiş bakım: ${wo.title} (${delayDays.toFixed(1)} gün gecikme)`,
          delayDays, 0, Math.min(4, delayDays / 3),
          delayDays * 24, lookbackHours, input.eventType,
        ));
      }
    }
  }

  // ── Nedenleri Sırala ───────────────────────────────────────────────
  // En yüksek güven skoru başta
  possibleCauses.sort((a, b) => b.confidence - a.confidence);

  // ── Kaskad Tahmin (Opsiyonel) ──────────────────────────────────────
  let cascadePrediction: CascadePrediction | undefined;

  if (input.includeCascadePrediction && possibleCauses.length > 0) {
    // En olası nedenin tetikleyicisini bul
    const topCause = possibleCauses[0]!;
    const triggers = EVENT_TO_TRIGGER[input.eventType] ?? [];

    // Neden-tetikleyici eşlemesi dene
    const trigger = matchTrigger(topCause.causeType, [topCause.domain, topCause.metric]);
    if (trigger) {
      const hoursElapsed = topCause.hoursBeforeEvent;
      cascadePrediction = predictCascade(trigger, hoursElapsed);
    } else if (triggers.length > 0) {
      // Olay tipine göre varsayılan tetikleyici
      cascadePrediction = predictCascade(triggers[0]!, 0);
    }
  }

  // ── Güvenilirlik Raporu ────────────────────────────────────────────
  const allDomains = ['water_quality', 'feeding', 'growth', 'health', 'maintenance'];
  const reliability = buildReliabilityReport(dataSources, usedDomains, allDomains);

  // ── Insight Cümlesi ──────────────────────────────────────────────
  const topCauses = possibleCauses.slice(0, 15);
  const insight = generateRootCauseInsight(topCauses);

  // ── Sonuç ──────────────────────────────────────────────────────────
  const result: RootCauseResult = {
    event: {
      type: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      entityName,
      eventDate: eventISO,
      lookbackHours,
    },
    possibleCauses: topCauses,
    cascadePrediction,
    dataGaps,
    insight,
    reliability,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

// ============================================================================
// YARDIMCI FONKSİYONLAR
// ============================================================================

/**
 * Potansiyel neden objesi oluşturur ve skor hesaplar.
 *
 * NASIL ÇALIŞIR:
 *   1. timeProximityScore = max(0, 1 - hoursBeforeEvent / lookbackHours)
 *      Olaya yakın nedenler daha yüksek skor alır.
 *
 *   2. deviationScore = min(1, |zScore_approx| / 4)
 *      İstatistiksel sapma büyüklüğüne göre.
 *      zScore_approx parametresi doğrudan geçirilir.
 *
 *   3. knownCausalityBonus = 0.3 if causeType in KNOWN_CAUSES[eventType]
 *      Bilinen neden-sonuç ilişkisi varsa bonus eklenir.
 *
 *   4. totalScore = proximity * 0.40 + deviation * 0.35 + causality * 0.25
 *      Ağırlıklı toplam — [0, 1] aralığında.
 *
 * @param causeType - Neden tipi
 * @param domain - İlişkili domain
 * @param metric - İlişkili metrik
 * @param description - Türkçe açıklama
 * @param currentValue - Mevcut değer
 * @param expectedValue - Beklenen değer
 * @param zScoreApprox - Z-score yaklaşımı (0-4+ arası)
 * @param hoursBeforeEvent - Olaydan kaç saat önce
 * @param lookbackHours - Toplam lookback penceresi
 * @param eventType - Ana olay tipi
 * @returns PossibleCause nesnesi
 */
function buildCause(
  causeType: string,
  domain: string,
  metric: string,
  description: string,
  currentValue: number,
  expectedValue: number,
  zScoreApprox: number,
  hoursBeforeEvent: number,
  lookbackHours: number,
  eventType: string,
): PossibleCause {
  // ── Skor Hesaplaması ───────────────────────────────────────────────

  // 1. Zaman yakınlığı: 0 saat = 1.0, lookbackHours saat = 0.0
  const timeProximityScore = Math.max(0, 1 - (Math.abs(hoursBeforeEvent) / lookbackHours));

  // 2. İstatistiksel sapma: |z| / 4, max 1.0
  const deviationScore = Math.min(1, Math.abs(zScoreApprox) / 4);

  // 3. Bilinen nedensellik: bu neden bu olay tipi için biliniyor mu?
  const knownCauses = KNOWN_CAUSES[eventType] ?? [];
  const hasCausality = knownCauses.includes(causeType);
  const knownCausalityBonus = hasCausality ? 0.3 : 0;

  // 4. Toplam skor
  const totalScore = timeProximityScore * 0.40 +
                     deviationScore * 0.35 +
                     knownCausalityBonus * 0.25;
  const confidence = Math.min(1, Math.round(totalScore * 1000) / 1000);

  // Bilinen ilişki açıklaması
  const knownRelationship = hasCausality
    ? `${causeType} → ${eventType} ilişkisi bilgi tabanında tanımlıdır`
    : undefined;

  return {
    causeType,
    domain,
    metric,
    description,
    currentValue: round(currentValue, 4),
    expectedValue: round(expectedValue, 4),
    deviation: round(Math.abs(currentValue - expectedValue), 4),
    hoursBeforeEvent: round(hoursBeforeEvent, 1),
    confidence,
    scoring: {
      timeProximityScore: round(timeProximityScore, 3),
      deviationScore: round(deviationScore, 3),
      knownCausalityBonus: round(knownCausalityBonus, 3),
      totalScore: round(totalScore, 3),
    },
    knownRelationship,
  };
}

/**
 * En olası kök nedenlerin Türkçe özet cümlesini üretir.
 *
 * LLM bu cümleyi doğrudan kullanıcıya aktarabilir; detay gerekirse
 * possibleCauses dizisi hâlâ mevcuttur.
 */
function generateRootCauseInsight(causes: PossibleCause[]): string {
  if (causes.length === 0) return 'Olası neden bulunamadı.';
  const top = causes[0]!;
  return `En olası neden: ${top.description} (%${Math.round(top.confidence * 100)} güven). ${top.knownRelationship ?? ''} ${causes.length > 1 ? `Toplam ${causes.length} olası neden değerlendirildi.` : ''}`.trim();
}
