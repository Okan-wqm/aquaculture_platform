// ============================================================================
// MCP Farm Intelligence — Yem Etkisi Tahmin Aracı (Predict Feeding Impact)
// ============================================================================
//
// Bu araç, belirli bir yem miktarının su kalitesi üzerindeki etkisini önceden
// hesaplar. Çiftlik yöneticileri yemleme kararı vermeden ÖNCE olası sonuçları
// görebilir: TAN üretimi, NH3 toksisite riski, O2 talebi.
//
// NASIL ÇALIŞIR:
//   1. Yem miktarından TAN (Toplam Amonyak Azotu) üretimini hesaplar
//   2. Üretilen TAN'ın tank hacmine göre konsantrasyon artışını bulur
//   3. pH ve sıcaklığa göre toksik NH3 fraksiyonunu hesaplar
//   4. Kritik pH eşiğini ve güvenlik marjını belirler
//   5. Toplam oksijen talebini (balık + biyofiltre + organik) hesaplar
//   6. Yemleme oranını değerlendirir (düşük/normal/yüksek/aşırı)
//
// REFERANSLAR:
//   - TAN üretim katsayıları: Timmons & Ebeling (2013) — "Recirculating Aquaculture"
//   - NH3 toksisitesi: Emerson et al. (1975) — amonyak denge sabitleri
//   - O2 talebi: Colt (2006) — su ürünleri oksijen tüketimi
//   - Nitrifikasyon O2: 4.57 g O2 / g NH4-N oksidasyonu (stoikiyometrik)
//
// SAF HESAPLAMA — GraphQL çağrısı veya yan etki YOKTUR.
// ============================================================================

import { z } from 'zod';
import { feedingImpact } from '@platform/aquaculture-engines';
import { round } from '../../utils/formatters.js';

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================
//
// Her parametre açıklamalıdır:
//   - feedKg: Bugün verilecek toplam yem miktarı (kg cinsinden)
//   - biomassKg: Tanktaki toplam canlı biyokütle (kg cinsinden)
//   - tankVolumeM3: Tank su hacmi (m³ cinsinden)
//   - temperature: Su sıcaklığı (°C — Celsius derece)
//   - salinity: Tuzluluk (ppt — parts per thousand, tatlı su için 0)
//   - currentPH: Mevcut pH değeri (NBS ölçeğinde)
//   - currentTANmgL: Mevcut TAN konsantrasyonu (mg/L, opsiyonel)
//   - hasBiofilter: RAS (Recirculating Aquaculture System) mi? Biyofiltre var mı?
//   - speciesCode: Tür kodu — TAN katsayısı ve NH3 limiti belirler
// ============================================================================

export const inputSchema = z.object({
  feedKg: z.number().positive().describe('Bugün verilecek yem miktarı (kg)'),
  biomassKg: z.number().positive().describe('Mevcut biyokütle (kg)'),
  tankVolumeM3: z.number().positive().describe('Tank hacmi (m³)'),
  temperature: z.number().min(0).max(45).describe('Su sıcaklığı (°C)'),
  salinity: z.number().min(0).max(45).default(0).describe('Tuzluluk (ppt) — tatlı su için 0'),
  currentPH: z.number().min(4).max(12).describe('Mevcut pH değeri (NBS ölçeği)'),
  currentTANmgL: z
    .number()
    .min(0)
    .optional()
    .describe('Mevcut TAN seviyesi (mg/L) — varsa toplam TAN tahminine eklenir'),
  hasBiofilter: z.boolean().default(false).describe('Biyofiltre (RAS) sistemi mevcut mu?'),
  feedProteinPercent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Yem protein oranı (%) — verilirse TAN hesabı buna göre yapılır. Örn: 42 = %42 protein',
    ),
  speciesCode: z
    .string()
    .optional()
    .describe(
      'Tür kodu: salmon, tilapia, trout, seabass, seabream — feedProteinPercent verilmezse TAN katsayısı için',
    ),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'predict_feeding_impact',
  description:
    'Belirli bir yem miktarının su kalitesi üzerindeki etkisini tahmin eder: ' +
    'TAN üretimi, NH3 toksisite riski, oksijen talebi ve yemleme oranı değerlendirmesi. ' +
    'Yemleme kararı vermeden önce kullanılır.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      feedKg: { type: 'number', description: 'Bugün verilecek yem miktarı (kg)' },
      biomassKg: { type: 'number', description: 'Mevcut biyokütle (kg)' },
      tankVolumeM3: { type: 'number', description: 'Tank hacmi (m³)' },
      temperature: { type: 'number', description: 'Su sıcaklığı (°C)' },
      salinity: { type: 'number', description: 'Tuzluluk (ppt), varsayılan: 0' },
      currentPH: { type: 'number', description: 'Mevcut pH değeri (NBS ölçeği)' },
      currentTANmgL: { type: 'number', description: 'Mevcut TAN seviyesi (mg/L)' },
      hasBiofilter: { type: 'boolean', description: 'Biyofiltre var mı? varsayılan: false' },
      feedProteinPercent: {
        type: 'number',
        description:
          'Yem protein oranı (%) — TAN = 0.092 × protein% × yem_kg. Verilmezse tür katsayısı kullanılır',
      },
      speciesCode: {
        type: 'string',
        description:
          'Tür kodu: salmon, tilapia, trout, seabass, seabream — feedProteinPercent yoksa kullanılır',
      },
    },
    required: ['feedKg', 'biomassKg', 'tankVolumeM3', 'temperature', 'currentPH'],
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

/**
 * ToolResult tipi — MCP protokolüne uygun yanıt formatı
 */
type ToolResult = { content: Array<{ type: 'text'; text: string }> };

/**
 * Yem etkisi tahmin işleyicisi.
 *
 * HESAPLAMA AKIŞI:
 *   1. TAN Üretimi
 *      - TAN_kg = feedKg × TAN_coefficient
 *      - TAN artışı (mg/L) = TAN_kg × 1.000.000 / (hacim_m3 × 1000)
 *      - Zirve TAN = mevcutTAN + TAN artışı
 *
 *   2. Amonyak Riski
 *      - fractionNH3() ile NH3 fraksiyonu hesaplanır
 *      - NH3 = zirveTAN × fraksiyon
 *      - criticalPHforNH3() ile kritik pH bulunur
 *      - Güvenlik marjı = mevcutPH - kritikPH
 *
 *   3. Oksijen Talebi
 *      - Balık solunumu: feedKg × 0.35 (kg O2/kg yem)
 *      - Nitrifikasyon: TAN_kg × 4.57 (kg O2/kg TAN — stokiyometrik)
 *      - Organik ayrışma: feedKg × 0.10 (kg O2/kg yem)
 *      - Toplam → mg/L/saat dönüşümü
 *
 *   4. Yemleme Oranı
 *      - Oran = (feedKg / biomassKg) × 100 (% vücut ağırlığı)
 *      - Değerlendirme: <0.5% düşük, 0.5-3% normal, 3-5% yüksek, >5% aşırı
 */
export async function handler(params: unknown): Promise<ToolResult> {
  const input = inputSchema.parse(params);
  const {
    feedKg,
    biomassKg,
    tankVolumeM3,
    temperature,
    salinity,
    currentPH,
    currentTANmgL,
    hasBiofilter,
    speciesCode,
    feedProteinPercent,
  } = input;

  // Hesabın tamamı @platform/aquaculture-engines `feedingImpact` motorunda
  // (TAN üretimi, NH3 fraksiyonu/kritik pH — amonyak motoru, O2 talebi,
  // yemleme oranı). Bu araç girdiyi doğrular, motoru çağırır ve sunar.
  const impact = feedingImpact({
    feedKg,
    biomassKg,
    tankVolumeM3,
    temperatureC: temperature,
    salinityPpt: salinity,
    currentPH,
    currentTanMgL: currentTANmgL,
    hasBiofilter,
    feedProteinPercent,
    speciesCode,
  });
  const speciesKey = speciesCode?.toLowerCase() ?? '';
  const tanCoefficient = impact.tan.coefficientKgPerKgFeed;
  const tanMethod =
    impact.tan.method === 'protein_based'
      ? `protein_based (0.092 × ${feedProteinPercent}% = ${round(tanCoefficient, 4)})`
      : `species_coefficient (${speciesKey || 'default'} = ${tanCoefficient})`;
  const {
    producedKg: tanProductionKg,
    increaseMgL: tanIncreaseMgL,
    peakMgL: peakTANmgL,
  } = impact.tan;
  const {
    nh3Fraction,
    peakNh3MgL: peakNH3mgL,
    limitMgL: nh3Limit,
    exceedsLimit: nh3ExceedsLimit,
    criticalPH,
    safetyMarginPH: safetyMargin,
    status: ammoniaSafetyStatus,
  } = impact.ammonia;
  const {
    fishKgPerDay: o2FishKg,
    biofilterKgPerDay: o2BiofilterKg,
    organicKgPerDay: o2OrganicKg,
    totalKgPerDay: totalO2DemandKg,
    consumptionRateMgLPerHour: o2DemandMgLPerHour,
  } = impact.oxygen;
  const { ratePercentBw: feedingRatePercent, status: feedingRateStatus } = impact.feedingRate;

  const result = {
    tanProduction: {
      tanMethod,
      tanCoefficientUsed: round(tanCoefficient, 5),
      feedProteinPercent: feedProteinPercent ?? null,
      speciesCode: speciesCode ?? 'default',
      tanProducedKg: round(tanProductionKg, 6),
      tanIncreaseMgL: round(tanIncreaseMgL, 4),
      peakTANmgL: round(peakTANmgL, 4),
      currentTANmgL: currentTANmgL ?? 0,
      explanation:
        `${feedKg} kg yem × ${tanCoefficient} katsayı = ${round(tanProductionKg, 4)} kg TAN üretimi. ` +
        `Tank hacmi (${tankVolumeM3} m³) içinde konsantrasyon artışı: +${round(tanIncreaseMgL, 4)} mg/L.`,
    },
    ammoniaRisk: {
      nh3FractionAtCurrentPH: round(nh3Fraction, 6),
      nh3FractionPercent: round(nh3Fraction * 100, 4),
      peakNH3mgL: round(peakNH3mgL, 6),
      nh3SafeLimitMgL: nh3Limit,
      exceedsLimit: nh3ExceedsLimit,
      criticalPH: criticalPH === null ? null : round(criticalPH, 4),
      currentPH,
      safetyMarginPH: safetyMargin !== null ? round(safetyMargin, 4) : null,
      status: ammoniaSafetyStatus,
      explanation:
        criticalPH === null || safetyMargin === null
          ? `TAN seviyesi (${round(peakTANmgL, 2)} mg/L) yeterince düşük — NH3 limiti herhangi bir pH'da aşılmaz.`
          : `pH ${round(criticalPH, 2)} değerini aşarsa NH3 toksik limite (${nh3Limit} mg/L) ulaşır. ` +
            `Mevcut pH: ${currentPH}, marj: ${round(safetyMargin, 2)} pH birimi.`,
    },
    oxygenDemand: {
      fishRespirationKgO2: round(o2FishKg, 4),
      biofilterNitrificationKgO2: round(o2BiofilterKg, 4),
      organicDecompositionKgO2: round(o2OrganicKg, 4),
      totalO2DemandKg: round(totalO2DemandKg, 4),
      consumptionRateMgLPerHour: round(o2DemandMgLPerHour, 4),
      hasBiofilter,
      explanation:
        `Toplam O2 talebi: ${round(totalO2DemandKg, 3)} kg/gün ` +
        `(balık: ${round(o2FishKg, 3)}, ` +
        `${hasBiofilter ? `biyofiltre: ${round(o2BiofilterKg, 3)}, ` : ''}` +
        `organik: ${round(o2OrganicKg, 3)}). ` +
        `Saatlik tüketim hızı: ${round(o2DemandMgLPerHour, 3)} mg/L/saat.`,
    },
    feedingRate: {
      feedKg,
      biomassKg,
      ratePercent: round(feedingRatePercent, 2),
      status: feedingRateStatus,
      explanation:
        `Yemleme oranı: ${round(feedingRatePercent, 2)}% BW/gün — ` +
        `${
          feedingRateStatus === 'low'
            ? 'düşük (yetersiz beslenme riski)'
            : feedingRateStatus === 'normal'
              ? 'normal aralıkta'
              : feedingRateStatus === 'high'
                ? 'yüksek (su kalitesi izlenmeli)'
                : 'aşırı yemleme! Su kalitesi bozulma riski yüksek.'
        }`,
    },
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}
