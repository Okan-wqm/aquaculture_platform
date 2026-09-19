// ============================================================================
// MCP Farm Intelligence — Oksijen Bütçesi Hesaplama Aracı
// ============================================================================
//
// Bu araç, tanktaki oksijen dengesini hesaplar: üretim vs. tüketim,
// kritik zaman tahminleri ve sıcaklık etkisi analizi.
//
// NASIL ÇALIŞIR:
//   1. Weiss (1970) denklemi ile DO doygunluk değerini hesaplar
//   2. Mevcut DO ile doygunluk yüzdesini belirler
//   3. O2 tüketim hızını hesaplar (balık + biyofiltre + organik)
//   4. Havalandırma durduğunda minimum DO'ya ulaşma süresini tahmin eder
//   5. Sıcaklık etkisi analizi ve kritik sıcaklık tahmini yapar
//   6. Genel denge durumu değerlendirmesi verir
//
// REFERANSLAR:
//   - DO doygunluk: Weiss (1970) — "The solubility of nitrogen, oxygen and
//     argon in water and seawater" Deep-Sea Research 17:721-735
//   - O2 tüketim katsayıları: Colt (2006), Timmons & Ebeling (2013)
//   - Minimum güvenli DO: Boyd & Tucker (1998) — "Pond Aquaculture Water Quality"
//
// SAF HESAPLAMA — GraphQL çağrısı veya yan etki YOKTUR.
// ============================================================================

import { MIN_SAFE_DO_MG_L, oxygenBudget } from '@platform/aquaculture-engines';
import { z } from 'zod';
import { round } from '../../utils/formatters.js';

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================
//
// Parametreler:
//   - temperature: Su sıcaklığı °C (DO doygunluğunu doğrudan etkiler)
//   - salinity: Tuzluluk ppt (tuzlu su daha az O2 tutar)
//   - biomassKg: Tank biyokütlesi (O2 tüketiminin birincil kaynağı)
//   - dailyFeedKg: Günlük yem miktarı (metabolik O2 talebi belirler)
//   - tankVolumeM3: Tank hacmi (konsantrasyon hesabı için)
//   - currentDO: Mevcut çözünmüş oksijen seviyesi (mg/L)
//   - hasBiofilter: RAS sistemi mi? (nitrifikasyon O2 tüketimi ekler)
//   - waterFlowM3h: Su değişim debisi (opsiyonel — akışlı sistemler için)
// ============================================================================

export const inputSchema = z.object({
  temperature: z.number().min(0).max(45).describe('Su sıcaklığı (°C)'),
  salinity: z.number().min(0).max(45).default(0).describe('Tuzluluk (ppt) — tatlı su için 0'),
  biomassKg: z.number().positive().describe('Tank biyokütlesi (kg)'),
  dailyFeedKg: z.number().positive().describe('Günlük yem miktarı (kg)'),
  tankVolumeM3: z.number().positive().describe('Tank hacmi (m³)'),
  currentDO: z.number().min(0).describe('Mevcut çözünmüş oksijen (mg/L)'),
  hasBiofilter: z.boolean().default(false).describe('Biyofiltre (RAS) sistemi mevcut mu?'),
  waterFlowM3h: z.number().min(0).optional().describe('Su değişim debisi (m³/saat) — opsiyonel'),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'calculate_oxygen_budget',
  description:
    'Oksijen bütçesi hesaplar: DO doygunluk, tüketim hızı, kritik süre tahmini, ' +
    'sıcaklık etkisi ve denge durumu değerlendirmesi. Havalandırma/acil durum planlaması için.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      temperature: { type: 'number', description: 'Su sıcaklığı (°C)' },
      salinity: { type: 'number', description: 'Tuzluluk (ppt), varsayılan: 0' },
      biomassKg: { type: 'number', description: 'Tank biyokütlesi (kg)' },
      dailyFeedKg: { type: 'number', description: 'Günlük yem miktarı (kg)' },
      tankVolumeM3: { type: 'number', description: 'Tank hacmi (m³)' },
      currentDO: { type: 'number', description: 'Mevcut çözünmüş oksijen (mg/L)' },
      hasBiofilter: { type: 'boolean', description: 'Biyofiltre var mı? varsayılan: false' },
      waterFlowM3h: { type: 'number', description: 'Su değişim debisi (m³/saat)' },
    },
    required: ['temperature', 'biomassKg', 'dailyFeedKg', 'tankVolumeM3', 'currentDO'],
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
//
// Hesabın tamamı @platform/aquaculture-engines `oxygenBudget` motorunda
// (Weiss 1970 doygunluk, Colt/Timmons O2 talebi, kritik süre, sıcaklık
// duyarlılığı, CSTR su değişimi). Bu araç yalnızca girdiyi doğrular,
// motoru çağırır ve sonucu yuvarlayıp açıklamalarla sunar — aynı motor
// ai-service'in `calculate_oxygen_budget` aracını da besler (tek kaynak).
// ============================================================================

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

export async function handler(params: unknown): Promise<ToolResult> {
  const input = inputSchema.parse(params);
  const {
    temperature,
    salinity,
    dailyFeedKg,
    tankVolumeM3,
    currentDO,
    hasBiofilter,
    waterFlowM3h,
  } = input;

  const budget = oxygenBudget({
    temperatureC: temperature,
    salinityPpt: salinity,
    dailyFeedKg,
    tankVolumeM3,
    currentDoMgL: currentDO,
    hasBiofilter,
    waterFlowM3h,
  });
  const MIN_SAFE_DO = MIN_SAFE_DO_MG_L;
  const {
    doSaturationMgL: doSaturation,
    saturationPercent,
    saturationStatus,
    demand,
    consumptionRateMgLPerHour: consumptionRateMgLPerH,
    hoursToMinDo: hoursToMinDO,
    balanceStatus,
    doChangePerDegreeC: temperatureEffect,
    criticalTemperatureC: criticalTemperature,
    waterExchange,
  } = budget;

  const waterExchangeInfo: Record<string, unknown> | null = waterExchange
    ? {
        flowRateM3h: waterFlowM3h,
        exchangeRatePerHour: round(waterExchange.exchangeRatePerHour, 4),
        exchangesPerDay: round(waterExchange.exchangesPerDay, 2),
        estimatedSteadyStateDO: round(waterExchange.steadyStateDoMgL, 2),
        steadyStateAdequate: waterExchange.steadyStateAdequate,
      }
    : null;

  const result = {
    // ── Doygunluk Bilgileri ─────────────────────────────────────
    saturation: {
      doSaturationMgL: round(doSaturation, 2),
      currentDOMgL: currentDO,
      saturationPercent: round(saturationPercent, 1),
      status: saturationStatus,
      minSafeDOMgL: MIN_SAFE_DO,
      explanation:
        `Weiss (1970): ${temperature}°C ve ${salinity} ppt tuzlulukta DO doygunluğu = ${round(doSaturation, 2)} mg/L. ` +
        `Mevcut DO: ${currentDO} mg/L (%${round(saturationPercent, 1)} doygunluk) — durum: ${saturationStatus}.`,
    },

    // ── Tüketim Analizi ─────────────────────────────────────────
    consumption: {
      fishRespirationKgO2: round(demand.fishKgPerDay, 4),
      biofilterNitrificationKgO2: round(demand.biofilterKgPerDay, 4),
      organicDecompositionKgO2: round(demand.organicKgPerDay, 4),
      totalDailyO2DemandKg: round(demand.totalKgPerDay, 4),
      consumptionRateMgLPerHour: round(consumptionRateMgLPerH, 4),
      explanation:
        `Günlük O2 tüketimi: ${round(demand.totalKgPerDay, 3)} kg ` +
        `(${round(consumptionRateMgLPerH, 3)} mg/L/saat).`,
    },

    // ── Kritik Süre Tahmini ─────────────────────────────────────
    criticalTime: {
      hoursToMinDO: hoursToMinDO !== null ? round(hoursToMinDO, 1) : null,
      balanceStatus,
      explanation:
        hoursToMinDO !== null
          ? `Havalandırma olmadan DO ${MIN_SAFE_DO} mg/L'ye ${round(hoursToMinDO, 1)} saatte düşer. Durum: ${balanceStatus}.`
          : currentDO <= MIN_SAFE_DO
            ? `DİKKAT: Mevcut DO (${currentDO} mg/L) zaten minimum güvenli seviyenin (${MIN_SAFE_DO} mg/L) altında!`
            : 'O2 tüketimi hesaplanamadı.',
    },

    // ── Sıcaklık Etkisi ────────────────────────────────────────
    temperatureEffect: {
      doChangePerDegreeC: round(temperatureEffect, 3),
      criticalTemperatureC: criticalTemperature,
      explanation:
        `Her 1°C artışta DO doygunluğu yaklaşık ${round(Math.abs(temperatureEffect), 2)} mg/L düşer. ` +
        `${
          criticalTemperature !== null
            ? `${criticalTemperature}°C'de doygunluk ${MIN_SAFE_DO} mg/L'nin altına düşer.`
            : '50°C altında kritik sıcaklığa ulaşılmaz.'
        }`,
    },

    // ── Su Değişimi (opsiyonel) ─────────────────────────────────
    waterExchange: waterExchangeInfo,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}
