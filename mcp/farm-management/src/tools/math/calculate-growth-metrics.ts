// ============================================================================
// MCP Farm Intelligence — Büyüme Metrikleri Hesaplama Aracı
// ============================================================================
//
// Çok modlu büyüme hesaplayıcısı: SGR, FCR, biyokütle, projeksiyon, transfer.
//
// 5 HESAPLAMA MODU:
//   1. sgr          → Spesifik Büyüme Oranı (Specific Growth Rate)
//   2. fcr          → Yem Dönüşüm Oranı (Feed Conversion Ratio)
//   3. biomass      → Biyokütle ve stok yoğunluğu hesabı
//   4. projection   → Büyüme projeksiyonu (günlük simülasyon)
//   5. transfer_density → Tank transfer yoğunluk analizi
//
// NASIL ÇALIŞIR:
//   Kullanıcı bir `mode` seçer ve o moda uygun parametreleri gönderir.
//   Her mod kendi hesaplama mantığını çalıştırır ve yapılandırılmış sonuç döner.
//
// REFERANSLAR:
//   - SGR: Jobling (1994) — "Fish Bioenergetics"
//   - FCR: Tacon (1990) — "Standard Methods for the Nutrition of Farmed Fish"
//   - Büyüme projeksiyonu: Iwama & Tautz (1981), Brett & Groves (1979)
//
// SAF HESAPLAMA — GraphQL çağrısı veya yan etki YOKTUR.
// ============================================================================

import {
  biomass,
  feedConversionRatio,
  growthProjection,
  specificGrowthRate,
  transferDensity,
} from '@platform/aquaculture-engines';
import { z } from 'zod';
import { round } from '../../utils/formatters.js';

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================
//
// Discriminated union: `mode` alanına göre farklı parametreler beklenir.
// Zod'un discriminatedUnion kullanmak yerine tüm alanları opsiyonel yapıp
// handler içinde mod bazlı doğrulama yapıyoruz (daha esnek MCP uyumu).
// ============================================================================

export const inputSchema = z.object({
  mode: z
    .enum(['sgr', 'fcr', 'biomass', 'projection', 'transfer_density'])
    .describe('Hesaplama modu: sgr, fcr, biomass, projection, transfer_density'),

  // ── SGR Modu Parametreleri ──────────────────────────────────
  initialWeightG: z.number().positive().optional().describe('SGR: Başlangıç ağırlığı (gram)'),
  finalWeightG: z.number().positive().optional().describe('SGR: Bitiş ağırlığı (gram)'),
  days: z.number().positive().optional().describe('SGR: Süre (gün)'),

  // ── FCR Modu Parametreleri ──────────────────────────────────
  feedConsumedKg: z.number().positive().optional().describe('FCR: Tüketilen toplam yem (kg)'),
  biomassGainKg: z.number().positive().optional().describe('FCR: Kazanılan biyokütle (kg)'),
  speciesCode: z
    .string()
    .optional()
    .describe('FCR: Tür kodu — endüstri ortalamasıyla karşılaştırma için'),

  // ── Biyokütle Modu Parametreleri ────────────────────────────
  quantity: z.number().int().positive().optional().describe('Biomass/Projection: Balık adedi'),
  avgWeightG: z
    .number()
    .positive()
    .optional()
    .describe('Biomass: Ortalama bireysel ağırlık (gram)'),
  tankVolumeM3: z
    .number()
    .positive()
    .optional()
    .describe('Biomass/Transfer: Tank hacmi (m³) — yoğunluk hesabı için'),

  // ── Projeksiyon Modu Parametreleri ──────────────────────────
  currentWeightG: z
    .number()
    .positive()
    .optional()
    .describe('Projection: Mevcut ortalama ağırlık (gram)'),
  currentQuantity: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Projection: Mevcut balık adedi'),
  targetWeightG: z.number().positive().optional().describe('Projection: Hedef ağırlık (gram)'),
  sgr: z.number().positive().optional().describe('Projection: Spesifik büyüme oranı (%/gün)'),
  mortalityRatePercent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Projection: Günlük ölüm oranı (%)'),
  projectionDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Projection: Simülasyon süresi (gün) — verilmezse hedef ağırlığa kadar'),
  dailyFeedingRatePercent: z
    .number()
    .min(0)
    .max(20)
    .optional()
    .describe('Projection: Günlük yemleme oranı (% BW) — varsayılan: 2'),

  // ── Transfer Yoğunluk Modu Parametreleri ────────────────────
  sourceTank: z
    .object({
      volumeM3: z.number().positive(),
      currentBiomassKg: z.number().min(0),
      maxDensityKgM3: z.number().positive(),
    })
    .optional()
    .describe('Transfer: Kaynak tank bilgileri'),

  destTank: z
    .object({
      volumeM3: z.number().positive(),
      currentBiomassKg: z.number().min(0),
      maxDensityKgM3: z.number().positive(),
    })
    .optional()
    .describe('Transfer: Hedef tank bilgileri'),

  transferBiomassKg: z
    .number()
    .positive()
    .optional()
    .describe('Transfer: Aktarılacak biyokütle (kg)'),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'calculate_growth_metrics',
  description:
    'Çok modlu büyüme hesaplayıcısı: SGR (spesifik büyüme oranı), FCR (yem dönüşüm oranı), ' +
    'biyokütle, büyüme projeksiyonu ve transfer yoğunluk analizi.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      mode: {
        type: 'string',
        enum: ['sgr', 'fcr', 'biomass', 'projection', 'transfer_density'],
        description: 'Hesaplama modu',
      },
      initialWeightG: { type: 'number', description: 'SGR: Başlangıç ağırlığı (gram)' },
      finalWeightG: { type: 'number', description: 'SGR: Bitiş ağırlığı (gram)' },
      days: { type: 'number', description: 'SGR: Süre (gün)' },
      feedConsumedKg: { type: 'number', description: 'FCR: Tüketilen yem (kg)' },
      biomassGainKg: { type: 'number', description: 'FCR: Biyokütle kazanımı (kg)' },
      speciesCode: { type: 'string', description: 'FCR: Tür kodu' },
      quantity: { type: 'integer', description: 'Biomass/Projection: Balık adedi' },
      avgWeightG: { type: 'number', description: 'Biomass: Ortalama ağırlık (gram)' },
      tankVolumeM3: { type: 'number', description: 'Tank hacmi (m³)' },
      currentWeightG: { type: 'number', description: 'Projection: Mevcut ağırlık (gram)' },
      currentQuantity: { type: 'integer', description: 'Projection: Mevcut adet' },
      targetWeightG: { type: 'number', description: 'Projection: Hedef ağırlık (gram)' },
      sgr: { type: 'number', description: 'Projection: SGR (%/gün)' },
      mortalityRatePercent: { type: 'number', description: 'Projection: Günlük ölüm oranı (%)' },
      projectionDays: { type: 'integer', description: 'Projection: Simülasyon süresi (gün)' },
      dailyFeedingRatePercent: { type: 'number', description: 'Projection: Yemleme oranı (%BW)' },
      sourceTank: {
        type: 'object',
        properties: {
          volumeM3: { type: 'number' },
          currentBiomassKg: { type: 'number' },
          maxDensityKgM3: { type: 'number' },
        },
        description: 'Transfer: Kaynak tank',
      },
      destTank: {
        type: 'object',
        properties: {
          volumeM3: { type: 'number' },
          currentBiomassKg: { type: 'number' },
          maxDensityKgM3: { type: 'number' },
        },
        description: 'Transfer: Hedef tank',
      },
      transferBiomassKg: { type: 'number', description: 'Transfer: Aktarılacak biyokütle (kg)' },
    },
    required: ['mode'],
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
// Hesabın tamamı @platform/aquaculture-engines büyüme motorunda
// (`specificGrowthRate`, `feedConversionRatio`, `biomass`, `growthProjection`,
// `transferDensity`). Bu araç mod başına zorunlu alanları doğrular, motoru
// çağırır ve sonucu yuvarlayıp açıklamalarla sunar — aynı motor ai-service'in
// `calculate_growth_metrics` aracını da besler (tek kaynak).
// ============================================================================

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

export async function handler(params: unknown): Promise<ToolResult> {
  const input = inputSchema.parse(params);

  switch (input.mode) {
    case 'sgr':
      return handleSGR(input);
    case 'fcr':
      return handleFCR(input);
    case 'biomass':
      return handleBiomass(input);
    case 'projection':
      return handleProjection(input);
    case 'transfer_density':
      return handleTransferDensity(input);
    default:
      return {
        content: [
          {
            type: 'text',
            text: `Bilinmeyen hesaplama modu: ${input.mode}. Geçerli modlar: sgr, fcr, biomass, projection, transfer_density`,
          },
        ],
      };
  }
}

// ── SGR ─────────────────────────────────────────────────────────────────────
// SGR = ((ln(Wf) − ln(Wi)) / t) × 100 — Jobling (1994).

function handleSGR(input: z.infer<typeof inputSchema>): ToolResult {
  const { initialWeightG, finalWeightG, days } = input;
  if (initialWeightG == null || finalWeightG == null || days == null) {
    return errorResult(
      'SGR modu için initialWeightG, finalWeightG ve days parametreleri zorunludur.',
    );
  }

  const sgr = specificGrowthRate(initialWeightG, finalWeightG, days);

  const result = {
    mode: 'sgr',
    sgrPercentPerDay: round(sgr.sgrPercentPerDay, 4),
    rating: sgr.rating,
    initialWeightG,
    finalWeightG,
    days,
    weightGainG: round(sgr.weightGainG, 2),
    weightGainPercent: round(sgr.weightGainPercent, 2),
    doublingTimeDays: sgr.doublingTimeDays !== null ? round(sgr.doublingTimeDays, 1) : null,
    explanation:
      `SGR = ((ln(${finalWeightG}) - ln(${initialWeightG})) / ${days}) × 100 = ${round(sgr.sgrPercentPerDay, 4)}%/gün. ` +
      `${days} günde ${round(sgr.weightGainG, 1)}g ağırlık kazanımı (%${round(sgr.weightGainPercent, 1)}). ` +
      `Performans: ${sgr.rating}.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ── FCR ─────────────────────────────────────────────────────────────────────
// FCR = yem / biyokütle kazanımı; endüstri ortalaması motorun tür tablosundan.

function handleFCR(input: z.infer<typeof inputSchema>): ToolResult {
  const { feedConsumedKg, biomassGainKg, speciesCode } = input;
  if (feedConsumedKg == null || biomassGainKg == null) {
    return errorResult('FCR modu için feedConsumedKg ve biomassGainKg parametreleri zorunludur.');
  }

  const fcr = feedConversionRatio(feedConsumedKg, biomassGainKg, speciesCode);

  const result = {
    mode: 'fcr',
    fcr: round(fcr.fcr, 3),
    feedConsumedKg,
    biomassGainKg,
    speciesCode: speciesCode ?? 'default',
    industryAverageFCR: fcr.industryAverageFcr,
    deviationFromIndustryPercent: round(fcr.deviationFromIndustryPercent, 1),
    efficiency: fcr.efficiency,
    feedSavingsKgIfImproved01: round(fcr.feedSavingsKgIfImproved01, 2),
    explanation:
      `FCR = ${feedConsumedKg} kg yem / ${biomassGainKg} kg biyokütle = ${round(fcr.fcr, 3)}. ` +
      `Endüstri ortalaması (${speciesCode ?? 'genel'}): ${fcr.industryAverageFcr}. ` +
      `Sapma: %${round(fcr.deviationFromIndustryPercent, 1)}. Verimlilik: ${fcr.efficiency}.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ── Biyokütle ───────────────────────────────────────────────────────────────

function handleBiomass(input: z.infer<typeof inputSchema>): ToolResult {
  const { quantity, avgWeightG, tankVolumeM3 } = input;
  if (quantity == null || avgWeightG == null) {
    return errorResult('Biomass modu için quantity ve avgWeightG parametreleri zorunludur.');
  }

  const b = biomass(quantity, avgWeightG, tankVolumeM3);

  const result = {
    mode: 'biomass',
    quantity,
    avgWeightG,
    biomassKg: round(b.biomassKg, 2),
    biomassMetricTons: round(b.biomassKg / 1000, 4),
    ...(tankVolumeM3 != null
      ? {
          tankVolumeM3,
          densityKgM3: b.densityKgM3 !== null ? round(b.densityKgM3, 2) : null,
          densityStatus: b.densityStatus,
        }
      : {}),
    explanation:
      `${quantity} adet × ${avgWeightG}g = ${round(b.biomassKg, 2)} kg biyokütle` +
      `${b.densityKgM3 !== null ? ` (${round(b.densityKgM3, 2)} kg/m³ yoğunluk — ${b.densityStatus})` : ''}.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ── Projeksiyon ─────────────────────────────────────────────────────────────
// Üstel büyüme (W_t = W_0 · e^(SGR·t)), günlük ölüm, %BW yemleme; ≤365 gün.

function handleProjection(input: z.infer<typeof inputSchema>): ToolResult {
  const {
    currentWeightG,
    currentQuantity,
    targetWeightG,
    sgr: sgrInput,
    mortalityRatePercent,
    projectionDays,
    dailyFeedingRatePercent,
  } = input;

  if (currentWeightG == null || currentQuantity == null || sgrInput == null) {
    return errorResult(
      'Projection modu için currentWeightG, currentQuantity ve sgr parametreleri zorunludur.',
    );
  }
  if (targetWeightG == null && projectionDays == null) {
    return errorResult(
      'Projection modu için targetWeightG veya projectionDays parametrelerinden biri zorunludur.',
    );
  }

  const projection = growthProjection({
    currentWeightG,
    currentQuantity,
    sgrPercentPerDay: sgrInput,
    targetWeightG,
    mortalityRatePercent,
    projectionDays,
    dailyFeedingRatePercent,
  });

  const dailyData = projection.samples.map((sample) => ({
    day: sample.day,
    avgWeightG: round(sample.avgWeightG, 2),
    quantity: Math.round(sample.quantity),
    biomassKg: round(sample.biomassKg, 2),
    dailyFeedKg: round(sample.dailyFeedKg, 2),
    cumulativeFeedKg: round(sample.cumulativeFeedKg, 2),
    cumulativeMortality: Math.round(sample.cumulativeMortality),
  }));
  const finalEntry = dailyData[dailyData.length - 1]!;
  const survivalRate = round((finalEntry.quantity / currentQuantity) * 100, 2);

  const result = {
    mode: 'projection',
    parameters: {
      currentWeightG,
      currentQuantity,
      targetWeightG: targetWeightG ?? null,
      sgrPercentPerDay: sgrInput,
      mortalityRatePercent: mortalityRatePercent ?? 0,
      feedingRatePercent: dailyFeedingRatePercent ?? 2,
    },
    summary: {
      simulationDays: projection.simulationDays,
      estimatedHarvestDays:
        projection.estimatedHarvestDays !== null ? round(projection.estimatedHarvestDays, 1) : null,
      targetReachedDay: projection.targetReachedDay,
      finalAvgWeightG: finalEntry.avgWeightG,
      finalQuantity: finalEntry.quantity,
      finalBiomassKg: finalEntry.biomassKg,
      totalFeedConsumedKg: finalEntry.cumulativeFeedKg,
      totalMortality: finalEntry.cumulativeMortality,
      survivalRate,
    },
    dailyData,
    explanation:
      `${projection.simulationDays} günlük projeksiyon: ` +
      `Ağırlık ${currentWeightG}g → ${finalEntry.avgWeightG}g, ` +
      `Adet ${currentQuantity} → ${finalEntry.quantity} (hayatta kalma: %${round((finalEntry.quantity / currentQuantity) * 100, 1)}), ` +
      `Toplam yem: ${finalEntry.cumulativeFeedKg} kg.` +
      `${projection.targetReachedDay !== null ? ` Hedef (${targetWeightG}g) ${projection.targetReachedDay}. günde ulaşıldı.` : ''}`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ── Transfer yoğunluğu ──────────────────────────────────────────────────────

function handleTransferDensity(input: z.infer<typeof inputSchema>): ToolResult {
  const { sourceTank, destTank, transferBiomassKg } = input;
  if (sourceTank == null || destTank == null || transferBiomassKg == null) {
    return errorResult(
      'Transfer modu için sourceTank, destTank ve transferBiomassKg parametreleri zorunludur.',
    );
  }

  const t = transferDensity(sourceTank, destTank, transferBiomassKg);
  const load = (l: {
    biomassKg: number;
    densityKgM3: number;
    utilizationPercent: number;
  }): { biomassKg: number; densityKgM3: number; utilizationPercent: number } => ({
    biomassKg: round(l.biomassKg, 2),
    densityKgM3: round(l.densityKgM3, 2),
    utilizationPercent: round(l.utilizationPercent, 1),
  });

  const warnings: string[] = [];
  if (t.sourceInsufficient) {
    warnings.push(
      `UYARI: Kaynak tankta yeterli biyokütle yok! ` +
        `Mevcut: ${sourceTank.currentBiomassKg} kg, Transfer: ${transferBiomassKg} kg.`,
    );
  }
  if (t.destinationOverMax) {
    warnings.push(
      `UYARI: Hedef tank maksimum yoğunluğu aşılıyor! ` +
        `Sonrası: ${round(t.destination.after.densityKgM3, 2)} kg/m³, Maks: ${destTank.maxDensityKgM3} kg/m³. ` +
        `Fazla: ${round(t.destinationExcessKg, 2)} kg.`,
    );
  }

  const sourceBefore = load(t.source.before);
  const sourceAfter = load(t.source.after);
  const destBefore = load(t.destination.before);
  const destAfter = load(t.destination.after);

  const result = {
    mode: 'transfer_density',
    transferBiomassKg,
    sourceTank: {
      volumeM3: sourceTank.volumeM3,
      maxDensityKgM3: sourceTank.maxDensityKgM3,
      before: sourceBefore,
      after: sourceAfter,
    },
    destTank: {
      volumeM3: destTank.volumeM3,
      maxDensityKgM3: destTank.maxDensityKgM3,
      before: destBefore,
      after: destAfter,
    },
    maxSafeTransferKg: round(t.maxSafeTransferKg, 2),
    feasible: t.feasible,
    warnings,
    explanation:
      `${transferBiomassKg} kg transfer: ` +
      `Kaynak ${sourceBefore.densityKgM3} → ${sourceAfter.densityKgM3} kg/m³, ` +
      `Hedef ${destBefore.densityKgM3} → ${destAfter.densityKgM3} kg/m³. ` +
      `${warnings.length > 0 ? 'DİKKAT: Uyarılar mevcut!' : 'Transfer güvenli.'}`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

/**
 * Hata sonucu oluşturur — eksik parametre durumlarında.
 */
function errorResult(message: string): ToolResult & { isError: true } {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
