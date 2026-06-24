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
  mode: z.enum(['sgr', 'fcr', 'biomass', 'projection', 'transfer_density'])
    .describe('Hesaplama modu: sgr, fcr, biomass, projection, transfer_density'),

  // ── SGR Modu Parametreleri ──────────────────────────────────
  initialWeightG: z.number().positive().optional()
    .describe('SGR: Başlangıç ağırlığı (gram)'),
  finalWeightG: z.number().positive().optional()
    .describe('SGR: Bitiş ağırlığı (gram)'),
  days: z.number().positive().optional()
    .describe('SGR: Süre (gün)'),

  // ── FCR Modu Parametreleri ──────────────────────────────────
  feedConsumedKg: z.number().positive().optional()
    .describe('FCR: Tüketilen toplam yem (kg)'),
  biomassGainKg: z.number().positive().optional()
    .describe('FCR: Kazanılan biyokütle (kg)'),
  speciesCode: z.string().optional()
    .describe('FCR: Tür kodu — endüstri ortalamasıyla karşılaştırma için'),

  // ── Biyokütle Modu Parametreleri ────────────────────────────
  quantity: z.number().int().positive().optional()
    .describe('Biomass/Projection: Balık adedi'),
  avgWeightG: z.number().positive().optional()
    .describe('Biomass: Ortalama bireysel ağırlık (gram)'),
  tankVolumeM3: z.number().positive().optional()
    .describe('Biomass/Transfer: Tank hacmi (m³) — yoğunluk hesabı için'),

  // ── Projeksiyon Modu Parametreleri ──────────────────────────
  currentWeightG: z.number().positive().optional()
    .describe('Projection: Mevcut ortalama ağırlık (gram)'),
  currentQuantity: z.number().int().positive().optional()
    .describe('Projection: Mevcut balık adedi'),
  targetWeightG: z.number().positive().optional()
    .describe('Projection: Hedef ağırlık (gram)'),
  sgr: z.number().positive().optional()
    .describe('Projection: Spesifik büyüme oranı (%/gün)'),
  mortalityRatePercent: z.number().min(0).max(100).optional()
    .describe('Projection: Günlük ölüm oranı (%)'),
  projectionDays: z.number().int().positive().optional()
    .describe('Projection: Simülasyon süresi (gün) — verilmezse hedef ağırlığa kadar'),
  dailyFeedingRatePercent: z.number().min(0).max(20).optional()
    .describe('Projection: Günlük yemleme oranı (% BW) — varsayılan: 2'),

  // ── Transfer Yoğunluk Modu Parametreleri ────────────────────
  sourceTank: z.object({
    volumeM3: z.number().positive(),
    currentBiomassKg: z.number().min(0),
    maxDensityKgM3: z.number().positive(),
  }).optional().describe('Transfer: Kaynak tank bilgileri'),

  destTank: z.object({
    volumeM3: z.number().positive(),
    currentBiomassKg: z.number().min(0),
    maxDensityKgM3: z.number().positive(),
  }).optional().describe('Transfer: Hedef tank bilgileri'),

  transferBiomassKg: z.number().positive().optional()
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
// TÜR BAZLI FCR ORTALAMA DEĞERLERİ
// ============================================================================
//
// FCR (Feed Conversion Ratio) = tüketilen yem / kazanılan biyokütle
// Düşük FCR daha iyi yem verimliliği demektir.
//
// Bu değerler endüstri ortalamasıdır ve karşılaştırma için kullanılır:
//   - Salmon: 1.2 (çok verimli — yüksek proteinli yem, soğuk su)
//   - Trout:  1.1 (en verimli türlerden — benzer genetik ve yem teknolojisi)
//   - Seabass: 1.8 (Akdeniz türü — daha yavaş büyüme)
//   - Seabream: 2.0 (Akdeniz türü — mevsimsel büyüme değişkenliği)
//   - Tilapia: 1.6 (tropikal — bitkisel yem kullanımı nedeniyle orta verimlilik)
//
// KAYNAK: Tacon & Metian (2015), "Feed Matters: Satisfying the Feed Demand of Aquaculture"
// ============================================================================

const INDUSTRY_FCR: Record<string, number> = {
  salmon: 1.2,
  trout: 1.1,
  seabass: 1.8,
  seabream: 2.0,
  tilapia: 1.6,
};

const DEFAULT_INDUSTRY_FCR = 1.5;

// ============================================================================
// ARAÇ İŞLEYİCİSİ (Handler)
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
        content: [{
          type: 'text',
          text: `Bilinmeyen hesaplama modu: ${input.mode}. Geçerli modlar: sgr, fcr, biomass, projection, transfer_density`,
        }],
      };
  }
}

// ============================================================================
// MOD 1: SGR — Spesifik Büyüme Oranı
// ============================================================================
//
// SGR (Specific Growth Rate), balığın günlük büyüme hızını ölçer.
//
// FORMÜL:
//   SGR = ((ln(Wf) - ln(Wi)) / t) × 100
//
//   Wi = başlangıç ağırlığı (gram)
//   Wf = bitiş ağırlığı (gram)
//   t  = süre (gün)
//   ln = doğal logaritma
//
// NEDEN LOGARİTMA?
//   Balık büyümesi eksponansiyel bir süreçtir (bileşik faiz gibi):
//   W(t) = Wi × e^(SGR/100 × t)
//   Bu formülü SGR için çözersek yukarıdaki denklem elde edilir.
//
// BİRİM: %/gün (yüzde vücut ağırlığı artışı günde)
//
// DEĞERLENDİRME:
//   > 3%  → Mükemmel (genç balıklar, optimum koşullar)
//   2-3%  → İyi (standart üretim performansı)
//   1-2%  → Orta (alt-optimal koşullar veya yetişkin balıklar)
//   < 1%  → Zayıf (stres, hastalık veya kötü koşullar)
//
// KAYNAK: Jobling (1994), "Fish Bioenergetics" Bölüm 7
// ============================================================================

function handleSGR(input: z.infer<typeof inputSchema>): ToolResult {
  // ── Parametre doğrulama ───────────────────────────────────────
  const { initialWeightG, finalWeightG, days } = input;
  if (initialWeightG == null || finalWeightG == null || days == null) {
    return errorResult('SGR modu için initialWeightG, finalWeightG ve days parametreleri zorunludur.');
  }

  // ── SGR Hesabı ────────────────────────────────────────────────
  //
  // SGR = ((ln(Wf) - ln(Wi)) / t) × 100
  //
  // Adım adım:
  //   1. ln(Wf) → bitiş ağırlığının doğal logaritması
  //   2. ln(Wi) → başlangıç ağırlığının doğal logaritması
  //   3. Fark / süre → günlük logaritmik büyüme hızı
  //   4. × 100 → yüzdeye dönüştürme
  const sgrValue = ((Math.log(finalWeightG) - Math.log(initialWeightG)) / days) * 100;

  // ── Ağırlık kazanımı ─────────────────────────────────────────
  const weightGainG = finalWeightG - initialWeightG;
  const weightGainPercent = (weightGainG / initialWeightG) * 100;

  // ── İki katına çıkma süresi ───────────────────────────────────
  //
  // FORMÜL: t_double = ln(2) / (SGR/100) = 69.3 / SGR
  //
  // SGR %2/gün ise: 69.3 / 2 = ~35 gün'de ağırlık iki katına çıkar.
  // Bu, yatırımcılar için anlaşılması kolay bir metriktir.
  const doublingTimeDays = sgrValue > 0 ? (Math.log(2) / (sgrValue / 100)) : null;

  // ── Performans değerlendirmesi ────────────────────────────────
  let rating: string;
  if (sgrValue > 3) {
    rating = 'excellent';  // Mükemmel
  } else if (sgrValue >= 2) {
    rating = 'good';       // İyi
  } else if (sgrValue >= 1) {
    rating = 'average';    // Orta
  } else {
    rating = 'poor';       // Zayıf
  }

  const result = {
    mode: 'sgr',
    sgrPercentPerDay: round(sgrValue, 4),
    rating,
    initialWeightG,
    finalWeightG,
    days,
    weightGainG: round(weightGainG, 2),
    weightGainPercent: round(weightGainPercent, 2),
    doublingTimeDays: doublingTimeDays !== null ? round(doublingTimeDays, 1) : null,
    explanation:
      `SGR = ((ln(${finalWeightG}) - ln(${initialWeightG})) / ${days}) × 100 = ${round(sgrValue, 4)}%/gün. ` +
      `${days} günde ${round(weightGainG, 1)}g ağırlık kazanımı (%${round(weightGainPercent, 1)}). ` +
      `Performans: ${rating}.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ============================================================================
// MOD 2: FCR — Yem Dönüşüm Oranı
// ============================================================================
//
// FCR (Feed Conversion Ratio), ne kadar yem ile ne kadar biyokütle
// kazanıldığını ölçer.
//
// FORMÜL:
//   FCR = tüketilen_yem_kg / kazanılan_biyokütle_kg
//
// YORUM:
//   FCR = 1.2 → 1.2 kg yem ile 1 kg balık eti üretildi
//   Düşük FCR → daha iyi (daha az yem ile daha fazla büyüme)
//   Yüksek FCR → kötü (yem israfı, kötü büyüme veya hastalık)
//
// KAYNAK: Tacon (1990), "Standard Methods for the Nutrition of Farmed Fish"
// ============================================================================

function handleFCR(input: z.infer<typeof inputSchema>): ToolResult {
  const { feedConsumedKg, biomassGainKg, speciesCode } = input;
  if (feedConsumedKg == null || biomassGainKg == null) {
    return errorResult('FCR modu için feedConsumedKg ve biomassGainKg parametreleri zorunludur.');
  }

  // ── FCR Hesabı ────────────────────────────────────────────────
  const fcrValue = feedConsumedKg / biomassGainKg;

  // ── Endüstri Ortalamasıyla Karşılaştırma ──────────────────────
  const speciesKey = speciesCode?.toLowerCase() ?? '';
  const industryAvg = INDUSTRY_FCR[speciesKey] ?? DEFAULT_INDUSTRY_FCR;

  // ── Verimlilik Farkı ──────────────────────────────────────────
  //
  // Negatif fark → endüstri ortalamasından DAHA İYİ (daha az yem)
  // Pozitif fark → endüstri ortalamasından DAHA KÖTÜ (daha fazla yem)
  const deviationPercent = ((fcrValue - industryAvg) / industryAvg) * 100;

  // ── Verimlilik Değerlendirmesi ────────────────────────────────
  let efficiency: string;
  if (fcrValue <= industryAvg * 0.85) {
    efficiency = 'excellent';  // Ortalamanın %15'inden daha iyi
  } else if (fcrValue <= industryAvg) {
    efficiency = 'good';       // Ortalamada veya daha iyi
  } else if (fcrValue <= industryAvg * 1.2) {
    efficiency = 'average';    // Ortalamanın %20'sine kadar kötü
  } else {
    efficiency = 'poor';       // Ortalamanın %20'sinden fazla kötü
  }

  // ── Yem Maliyeti Etkisi ───────────────────────────────────────
  //
  // FCR 0.1 birim iyileştirilse ne kadar yem tasarrufu sağlanır?
  // Tasarruf = biyokütleKazanımı × 0.1 (kg yem)
  const feedSavingsIfImproved01 = biomassGainKg * 0.1;

  const result = {
    mode: 'fcr',
    fcr: round(fcrValue, 3),
    feedConsumedKg,
    biomassGainKg,
    speciesCode: speciesCode ?? 'default',
    industryAverageFCR: industryAvg,
    deviationFromIndustryPercent: round(deviationPercent, 1),
    efficiency,
    feedSavingsKgIfImproved01: round(feedSavingsIfImproved01, 2),
    explanation:
      `FCR = ${feedConsumedKg} kg yem / ${biomassGainKg} kg biyokütle = ${round(fcrValue, 3)}. ` +
      `Endüstri ortalaması (${speciesCode ?? 'genel'}): ${industryAvg}. ` +
      `Sapma: %${round(deviationPercent, 1)}. Verimlilik: ${efficiency}.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ============================================================================
// MOD 3: BİYOKÜTLE HESABI
// ============================================================================
//
// Tanktaki toplam biyokütle ve stok yoğunluğunu hesaplar.
//
// FORMÜLLER:
//   Biyokütle (kg) = adet × ortalama_ağırlık_g / 1000
//   Yoğunluk (kg/m³) = biyokütle_kg / hacim_m3
//
// YOĞUNLUK DEĞERLENDİRMESİ:
//   < 5 kg/m³  → Düşük (verimsiz alan kullanımı)
//   5-15 kg/m³ → Normal (çoğu tür için uygun)
//   15-30 kg/m³ → Yüksek (RAS sistemler için kabul edilebilir)
//   > 30 kg/m³ → Aşırı (sadece intensif RAS, sürekli izleme gerekli)
// ============================================================================

function handleBiomass(input: z.infer<typeof inputSchema>): ToolResult {
  const { quantity, avgWeightG, tankVolumeM3 } = input;
  if (quantity == null || avgWeightG == null) {
    return errorResult('Biomass modu için quantity ve avgWeightG parametreleri zorunludur.');
  }

  // ── Biyokütle Hesabı ──────────────────────────────────────────
  //
  // FORMÜL: biyokütle = adet × ağırlık / 1000
  //
  // Birim dönüşümü: gram → kilogram (/ 1000)
  const biomassKg = (quantity * avgWeightG) / 1000;

  // ── Yoğunluk Hesabı (opsiyonel) ──────────────────────────────
  let density: number | null = null;
  let densityStatus: string | null = null;

  if (tankVolumeM3 != null && tankVolumeM3 > 0) {
    // FORMÜL: yoğunluk = biyokütle / hacim
    // BİRİM: kg/m³
    density = biomassKg / tankVolumeM3;

    if (density < 5) {
      densityStatus = 'low';       // Düşük yoğunluk
    } else if (density <= 15) {
      densityStatus = 'normal';    // Normal aralık
    } else if (density <= 30) {
      densityStatus = 'high';      // Yüksek — dikkatli izleme
    } else {
      densityStatus = 'excessive'; // Aşırı yoğun
    }
  }

  const result = {
    mode: 'biomass',
    quantity,
    avgWeightG,
    biomassKg: round(biomassKg, 2),
    biomassMetricTons: round(biomassKg / 1000, 4),
    ...(tankVolumeM3 != null ? {
      tankVolumeM3,
      densityKgM3: density !== null ? round(density, 2) : null,
      densityStatus,
    } : {}),
    explanation:
      `${quantity} adet × ${avgWeightG}g = ${round(biomassKg, 2)} kg biyokütle` +
      `${density !== null ? ` (${round(density, 2)} kg/m³ yoğunluk — ${densityStatus})` : ''}.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ============================================================================
// MOD 4: BÜYÜME PROJEKSİYONU
// ============================================================================
//
// Günlük iteratif simülasyonla balık büyümesini ileriye tahmin eder.
//
// HER GÜN İÇİN:
//   1. Ağırlık artışı: W(t+1) = W(t) × e^(SGR/100)
//      → Eksponansiyel büyüme modeli (Iwama & Tautz 1981)
//
//   2. Ölüm (mortalite): Q(t+1) = Q(t) × (1 - günlük_ölüm_oranı/100)
//      → Sabit oran varsayımı (doğrusal olmayan azalma)
//
//   3. Biyokütle: B(t) = Q(t) × W(t) / 1000
//      → Toplam canlı ağırlık
//
//   4. Günlük yem: F(t) = B(t) × yemleme_oranı / 100
//      → Biyokütle yüzdesi olarak yem
//
// HASAT TARİHİ TAHMİNİ:
//   W(t) = Wi × e^(SGR/100 × t)
//   hedefW = Wi × e^(SGR/100 × t_hasat)
//   t_hasat = ln(hedefW/Wi) / (SGR/100)
//
// KAYNAK: Iwama & Tautz (1981), Brett & Groves (1979)
// ============================================================================

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
    return errorResult('Projection modu için currentWeightG, currentQuantity ve sgr parametreleri zorunludur.');
  }
  if (targetWeightG == null && projectionDays == null) {
    return errorResult('Projection modu için targetWeightG veya projectionDays parametrelerinden biri zorunludur.');
  }

  // ── Parametrelerin atanması ───────────────────────────────────
  const dailyMortalityRate = mortalityRatePercent ?? 0;
  const feedingRate = dailyFeedingRatePercent ?? 2; // Varsayılan %2 BW/gün

  // ── Hasat tarihini tahmini (teorik) ───────────────────────────
  //
  // FORMÜL: t_hasat = ln(hedefW / mevcutW) / (SGR / 100)
  //
  // Bu formül, eksponansiyel büyüme denklemini t için çözer.
  // Mortaliteyi hesaba katmaz (sadece bireysel büyüme).
  let estimatedHarvestDays: number | null = null;
  if (targetWeightG != null && targetWeightG > currentWeightG) {
    estimatedHarvestDays = Math.log(targetWeightG / currentWeightG) / (sgrInput / 100);
  }

  // ── Simülasyon süresi belirleme ───────────────────────────────
  //
  // projectionDays verilmişse onu kullan.
  // Verilmemişse hasat tarihine kadar simüle et (en fazla 365 gün).
  const simDays = projectionDays
    ?? (estimatedHarvestDays !== null ? Math.ceil(estimatedHarvestDays) : 90);
  const maxSimDays = Math.min(simDays, 365); // Güvenlik sınırı

  // ── Günlük Simülasyon Döngüsü ────────────────────────────────
  //
  // Her iterasyonda:
  //   1. Mevcut durum kaydedilir
  //   2. Ağırlık artışı uygulanır (eksponansiyel)
  //   3. Mortalite uygulanır (sabit günlük oran)
  //   4. Biyokütle ve yem hesaplanır
  //
  interface DailyData {
    day: number;
    avgWeightG: number;
    quantity: number;
    biomassKg: number;
    dailyFeedKg: number;
    cumulativeFeedKg: number;
    cumulativeMortality: number;
  }

  const dailyData: DailyData[] = [];
  let weight = currentWeightG;
  let qty = currentQuantity;
  let cumulativeFeed = 0;
  let cumulativeMort = 0;
  let targetReachedDay: number | null = null;

  for (let day = 0; day <= maxSimDays; day++) {
    const biomass = (qty * weight) / 1000;
    const dailyFeed = biomass * (feedingRate / 100);
    cumulativeFeed += day === 0 ? 0 : dailyFeed; // 0. gün yem yok

    // ── Her 7 günde bir veya önemli günlerde kayıt ──────────────
    // Çok uzun projeksiyonlarda çıktı boyutunu sınırlamak için
    // her gün yerine belirli aralıklarla kayıt tutuyoruz.
    if (day === 0 || day === maxSimDays ||
        day % 7 === 0 ||
        (targetWeightG != null && weight >= targetWeightG && targetReachedDay === null)) {
      dailyData.push({
        day,
        avgWeightG: round(weight, 2),
        quantity: Math.round(qty),
        biomassKg: round(biomass, 2),
        dailyFeedKg: round(dailyFeed, 2),
        cumulativeFeedKg: round(cumulativeFeed, 2),
        cumulativeMortality: Math.round(cumulativeMort),
      });
    }

    // ── Hedef ağırlık kontrolü ──────────────────────────────────
    if (targetWeightG != null && weight >= targetWeightG && targetReachedDay === null) {
      targetReachedDay = day;
    }

    // ── Güncelleme ──────────────────────────────────────────────
    //
    // Ağırlık artışı: W(t+1) = W(t) × e^(SGR/100)
    //   e^(SGR/100) → bir günlük büyüme çarpanı
    //   SGR = 2% ise: e^0.02 ≈ 1.0202 → %2.02 günlük artış
    //
    // Mortalite: Q(t+1) = Q(t) × (1 - mortalite/100)
    //   mortalite = 0.1% ise: Q × 0.999 → günde %0.1 kayıp
    weight *= Math.exp(sgrInput / 100);
    const deaths = qty * (dailyMortalityRate / 100);
    qty -= deaths;
    cumulativeMort += deaths;
  }

  // ── Özet ──────────────────────────────────────────────────────
  const finalEntry = dailyData[dailyData.length - 1]!;

  const result = {
    mode: 'projection',
    parameters: {
      currentWeightG,
      currentQuantity,
      targetWeightG: targetWeightG ?? null,
      sgrPercentPerDay: sgrInput,
      mortalityRatePercent: dailyMortalityRate,
      feedingRatePercent: feedingRate,
    },
    summary: {
      simulationDays: maxSimDays,
      estimatedHarvestDays: estimatedHarvestDays !== null ? round(estimatedHarvestDays, 1) : null,
      targetReachedDay,
      finalAvgWeightG: finalEntry.avgWeightG,
      finalQuantity: finalEntry.quantity,
      finalBiomassKg: finalEntry.biomassKg,
      totalFeedConsumedKg: finalEntry.cumulativeFeedKg,
      totalMortality: finalEntry.cumulativeMortality,
      survivalRate: round((finalEntry.quantity / currentQuantity) * 100, 2),
    },
    // ── Haftalık veri noktaları ──────────────────────────────────
    dailyData,
    explanation:
      `${maxSimDays} günlük projeksiyon: ` +
      `Ağırlık ${currentWeightG}g → ${finalEntry.avgWeightG}g, ` +
      `Adet ${currentQuantity} → ${finalEntry.quantity} (hayatta kalma: %${round((finalEntry.quantity / currentQuantity) * 100, 1)}), ` +
      `Toplam yem: ${finalEntry.cumulativeFeedKg} kg.` +
      `${targetReachedDay !== null ? ` Hedef (${targetWeightG}g) ${targetReachedDay}. günde ulaşıldı.` : ''}`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ============================================================================
// MOD 5: TRANSFER YOĞUNLUK ANALİZİ
// ============================================================================
//
// İki tank arasında biyokütle transferinin etkisini hesaplar.
//
// HESAPLAMALAR:
//   Kaynak tank: sonraBiyokütle = mevcutBiyokütle - transferEdilen
//   Hedef tank: sonraBiyokütle = mevcutBiyokütle + transferEdilen
//   Her ikisi için yoğunluk = biyokütle / hacim
//   maxDensity aşılıp aşılmadığı kontrol edilir
//
// UYARILAR:
//   - Kaynak tankta negatif biyokütle oluşursa → transfer fazla
//   - Hedef tankta maxDensity aşılırsa → kapasite yetersiz
// ============================================================================

function handleTransferDensity(input: z.infer<typeof inputSchema>): ToolResult {
  const { sourceTank, destTank, transferBiomassKg } = input;
  if (sourceTank == null || destTank == null || transferBiomassKg == null) {
    return errorResult('Transfer modu için sourceTank, destTank ve transferBiomassKg parametreleri zorunludur.');
  }

  const warnings: string[] = [];

  // ── Kaynak Tank — Transfer Öncesi ─────────────────────────────
  const sourceBefore = {
    biomassKg: sourceTank.currentBiomassKg,
    densityKgM3: round(sourceTank.currentBiomassKg / sourceTank.volumeM3, 2),
    utilizationPercent: round(
      (sourceTank.currentBiomassKg / (sourceTank.maxDensityKgM3 * sourceTank.volumeM3)) * 100, 1
    ),
  };

  // ── Kaynak Tank — Transfer Sonrası ────────────────────────────
  const sourceAfterBiomass = sourceTank.currentBiomassKg - transferBiomassKg;
  if (sourceAfterBiomass < 0) {
    warnings.push(
      `UYARI: Kaynak tankta yeterli biyokütle yok! ` +
      `Mevcut: ${sourceTank.currentBiomassKg} kg, Transfer: ${transferBiomassKg} kg.`
    );
  }
  const sourceAfter = {
    biomassKg: round(Math.max(0, sourceAfterBiomass), 2),
    densityKgM3: round(Math.max(0, sourceAfterBiomass) / sourceTank.volumeM3, 2),
    utilizationPercent: round(
      (Math.max(0, sourceAfterBiomass) / (sourceTank.maxDensityKgM3 * sourceTank.volumeM3)) * 100, 1
    ),
  };

  // ── Hedef Tank — Transfer Öncesi ──────────────────────────────
  const destBefore = {
    biomassKg: destTank.currentBiomassKg,
    densityKgM3: round(destTank.currentBiomassKg / destTank.volumeM3, 2),
    utilizationPercent: round(
      (destTank.currentBiomassKg / (destTank.maxDensityKgM3 * destTank.volumeM3)) * 100, 1
    ),
  };

  // ── Hedef Tank — Transfer Sonrası ─────────────────────────────
  const destAfterBiomass = destTank.currentBiomassKg + transferBiomassKg;
  const destAfterDensity = destAfterBiomass / destTank.volumeM3;
  if (destAfterDensity > destTank.maxDensityKgM3) {
    warnings.push(
      `UYARI: Hedef tank maksimum yoğunluğu aşılıyor! ` +
      `Sonrası: ${round(destAfterDensity, 2)} kg/m³, Maks: ${destTank.maxDensityKgM3} kg/m³. ` +
      `Fazla: ${round(destAfterBiomass - destTank.maxDensityKgM3 * destTank.volumeM3, 2)} kg.`
    );
  }
  const destAfter = {
    biomassKg: round(destAfterBiomass, 2),
    densityKgM3: round(destAfterDensity, 2),
    utilizationPercent: round(
      (destAfterBiomass / (destTank.maxDensityKgM3 * destTank.volumeM3)) * 100, 1
    ),
  };

  // ── Maksimum Transfer Miktarı ─────────────────────────────────
  //
  // Hedef tankın kalan kapasitesine göre en fazla ne kadar transfer edilebilir?
  const destMaxCapacity = destTank.maxDensityKgM3 * destTank.volumeM3;
  const destAvailableCapacity = Math.max(0, destMaxCapacity - destTank.currentBiomassKg);

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
    maxSafeTransferKg: round(Math.min(sourceTank.currentBiomassKg, destAvailableCapacity), 2),
    feasible: warnings.length === 0,
    warnings,
    explanation:
      `${transferBiomassKg} kg transfer: ` +
      `Kaynak ${sourceBefore.densityKgM3} → ${sourceAfter.densityKgM3} kg/m³, ` +
      `Hedef ${destBefore.densityKgM3} → ${destAfter.densityKgM3} kg/m³. ` +
      `${warnings.length > 0 ? 'DİKKAT: Uyarılar mevcut!' : 'Transfer güvenli.'}`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ============================================================================
// YARDIMCI FONKSİYONLAR
// ============================================================================

/**
 * Hata sonucu oluşturur — eksik parametre durumlarında.
 */
function errorResult(message: string): ToolResult & { isError: true } {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
