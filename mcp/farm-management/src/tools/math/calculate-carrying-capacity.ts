// ============================================================================
// MCP Farm Intelligence — Taşıma Kapasitesi Hesaplama Aracı
// ============================================================================
//
// Bir tankın maksimum güvenli taşıma kapasitesini iki kısıt temelinde hesaplar:
//   1. Yoğunluk kısıtı (kg/m³ — fiziksel alan sınırı)
//   2. Oksijen kısıtı (DO doygunluk → metabolik O2 talebi dengesi)
//
// HANGİ KISIT DAHA DÜŞÜKse O BASKINDDIR (sınırlayıcı faktör).
//
// NASIL ÇALIŞIR:
//   1. Yoğunluk limiti: maxBiyokütle = maxYoğunluk × hacim
//   2. Oksijen limiti:
//      a) Weiss (1970) ile DO doygunluğunu hesapla
//      b) Kullanılabilir DO = DO_sat - minGüvenliDO
//      c) 1 kg biyokütle başına günlük O2 tüketimini hesapla
//      d) maxBiyokütle_O2 = kullanılabilir_DO_kg / O2_tüketim_per_kg_per_gün
//   3. Sınırlayıcı faktörü belirle (min)
//   4. Maksimum balık sayısını hesapla
//   5. Öneriler oluştur
//
// REFERANSLAR:
//   - Yoğunluk sınırları: Wedemeyer (1996), Ellis et al. (2002)
//   - Oksijen bütçesi: Colt (2006), Timmons & Ebeling (2013)
//   - DO doygunluk: Weiss (1970) — Deep-Sea Research 17:721-735
//
// SAF HESAPLAMA — GraphQL çağrısı veya yan etki YOKTUR.
// ============================================================================

import { carryingCapacity } from '@platform/aquaculture-engines';
import { z } from 'zod';
import { round } from '../../utils/formatters.js';

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================
//
// Parametreler:
//   - tankVolumeM3: Tank su hacmi
//   - temperature: Su sıcaklığı (DO doygunluğu ve metabolizma hızı belirler)
//   - salinity: Tuzluluk (DO doygunluğunu düşürür)
//   - minDOMgL: Minimum güvenli DO (varsayılan 5 mg/L)
//   - maxDensityKgM3: Tür bazlı maksimum yoğunluk (varsayılan 20 kg/m³)
//   - avgFishWeightG: Ortalama bireysel balık ağırlığı (balık sayısı hesabı için)
//   - dailyFeedingRatePercent: Günlük yemleme oranı (%BW — O2 talebi belirler)
//   - hasBiofilter: Biyofiltre varlığı (nitrifikasyon O2 tüketimi ekler)
// ============================================================================

export const inputSchema = z.object({
  tankVolumeM3: z.number().positive().describe('Tank su hacmi (m³)'),
  temperature: z.number().min(0).max(45).describe('Su sıcaklığı (°C)'),
  salinity: z.number().min(0).max(45).default(0).describe('Tuzluluk (ppt) — tatlı su için 0'),
  minDOMgL: z
    .number()
    .min(0)
    .default(5)
    .describe('Minimum güvenli DO seviyesi (mg/L) — varsayılan: 5'),
  maxDensityKgM3: z
    .number()
    .positive()
    .default(20)
    .describe('Maksimum stok yoğunluğu (kg/m³) — varsayılan: 20'),
  avgFishWeightG: z.number().positive().describe('Ortalama bireysel balık ağırlığı (gram)'),
  dailyFeedingRatePercent: z
    .number()
    .min(0)
    .max(20)
    .default(2)
    .describe('Günlük yemleme oranı (%BW) — varsayılan: 2'),
  hasBiofilter: z.boolean().default(false).describe('Biyofiltre (RAS) sistemi mevcut mu?'),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'calculate_carrying_capacity',
  description:
    'Tank taşıma kapasitesini yoğunluk ve oksijen kısıtlarına göre hesaplar. ' +
    'Maksimum güvenli biyokütle, balık sayısı ve sınırlayıcı faktörü belirler.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tankVolumeM3: { type: 'number', description: 'Tank su hacmi (m³)' },
      temperature: { type: 'number', description: 'Su sıcaklığı (°C)' },
      salinity: { type: 'number', description: 'Tuzluluk (ppt), varsayılan: 0' },
      minDOMgL: { type: 'number', description: 'Minimum güvenli DO (mg/L), varsayılan: 5' },
      maxDensityKgM3: { type: 'number', description: 'Maks yoğunluk (kg/m³), varsayılan: 20' },
      avgFishWeightG: { type: 'number', description: 'Ortalama balık ağırlığı (gram)' },
      dailyFeedingRatePercent: {
        type: 'number',
        description: 'Yemleme oranı (%BW), varsayılan: 2',
      },
      hasBiofilter: { type: 'boolean', description: 'Biyofiltre var mı? varsayılan: false' },
    },
    required: ['tankVolumeM3', 'temperature', 'avgFishWeightG'],
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

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

export async function handler(params: unknown): Promise<ToolResult> {
  const input = inputSchema.parse(params);
  const {
    tankVolumeM3,
    temperature,
    salinity,
    minDOMgL,
    maxDensityKgM3,
    avgFishWeightG,
    dailyFeedingRatePercent,
    hasBiofilter,
  } = input;

  // Hesabın tamamı @platform/aquaculture-engines `carryingCapacity` motorunda
  // (yoğunluk ve oksijen kısıtları, Weiss 1970 doygunluk, kg biyokütle başına
  // O2 talebi). Bu araç girdiyi doğrular, motoru çağırır, yuvarlar ve önerir.
  const capacity = carryingCapacity({
    tankVolumeM3,
    temperatureC: temperature,
    salinityPpt: salinity,
    minSafeDoMgL: minDOMgL,
    maxDensityKgM3,
    avgFishWeightG,
    dailyFeedingRatePercent,
    hasBiofilter,
  });
  const {
    maxBiomassKg,
    maxFishCount,
    effectiveMaxDensityKgM3: effectiveMaxDensity,
    limitingFactor,
  } = capacity;
  const maxBiomassDensity = capacity.density.maxBiomassKg;
  const maxBiomassOxygen = capacity.oxygen.maxBiomassKg;
  const {
    doSaturationMgL: doSaturation,
    doAvailableMgL,
    o2PerKgBiomassPerDayKg: o2PerKgPerDay,
  } = capacity.oxygen;

  const recommendations: string[] = [];
  if (limitingFactor === 'oxygen') {
    recommendations.push(
      'Oksijen sınırlayıcı faktör — havalandırma kapasitesini artırmayı değerlendirin.',
    );
    recommendations.push(
      'Saf oksijen enjeksiyonu ile DO doygunluğunun üzerine çıkılabilir (süpersatürasyon).',
    );
    if (!hasBiofilter) {
      recommendations.push(
        'Biyofiltre eklenmesi (RAS dönüşümü) su kalitesini iyileştirir ama ek O2 tüketimi yaratır.',
      );
    }
  }
  if (limitingFactor === 'density') {
    recommendations.push(
      'Yoğunluk sınırlayıcı faktör — daha büyük tank veya ek tank eklemeyi değerlendirin.',
    );
    recommendations.push(
      `Mevcut yoğunluk sınırı: ${maxDensityKgM3} kg/m³. ` +
        `Tür ve koşullara göre bu sınır ayarlanabilir.`,
    );
  }
  if (temperature > 25) {
    recommendations.push(
      `Yüksek sıcaklık (${temperature}°C) DO doygunluğunu düşürür. ` +
        `Soğutma sistemleri O2 kapasitesini artırabilir.`,
    );
  }
  if (doAvailableMgL < 2) {
    recommendations.push(
      `DİKKAT: Kullanılabilir O2 marjı çok düşük (${round(doAvailableMgL, 2)} mg/L). ` +
        `Havalandırma arızasında hızlı O2 düşüşü yaşanabilir.`,
    );
  }

  const result = {
    maxBiomassKg: round(maxBiomassKg, 2),
    maxFishCount,
    effectiveMaxDensityKgM3: round(effectiveMaxDensity, 2),
    limitingFactor,
    limits: {
      density: {
        maxBiomassKg: round(maxBiomassDensity, 2),
        maxDensityKgM3: maxDensityKgM3,
        tankVolumeM3,
        explanation: `Yoğunluk kısıtı: ${maxDensityKgM3} kg/m³ × ${tankVolumeM3} m³ = ${round(maxBiomassDensity, 2)} kg.`,
      },
      oxygen: {
        maxBiomassKg: maxBiomassOxygen !== null ? round(maxBiomassOxygen, 2) : null,
        doSaturationMgL: round(doSaturation, 2),
        doAvailableMgL: round(doAvailableMgL, 2),
        minSafeDOMgL: minDOMgL,
        o2PerKgPerDayKg: round(o2PerKgPerDay, 6),
        o2BreakdownPerKg: {
          fishRespiration: round(capacity.oxygen.breakdownPerKg.fish, 6),
          organicDecomposition: round(capacity.oxygen.breakdownPerKg.organic, 6),
          biofilterNitrification: round(capacity.oxygen.breakdownPerKg.biofilter, 6),
        },
        explanation:
          `Oksijen kısıtı: DO_sat=${round(doSaturation, 2)} mg/L, ` +
          `kullanılabilir=${round(doAvailableMgL, 2)} mg/L → ` +
          `${maxBiomassOxygen !== null ? round(maxBiomassOxygen, 2) + ' kg maks biyokütle' : 'sınırsız (yem oranı 0)'}.`,
      },
    },
    parameters: {
      temperature,
      salinity,
      dailyFeedingRatePercent,
      hasBiofilter,
      avgFishWeightG,
    },
    recommendations,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}
