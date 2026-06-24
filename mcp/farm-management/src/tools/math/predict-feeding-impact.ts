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
import {
  fractionNH3,
  criticalPHforNH3,
  uiaStatus,
} from '@platform/aquaculture-engines';
import { round } from '../../utils/formatters.js';
import { calcO2Consumption } from '../../utils/formulas.js';

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
  feedKg: z.number().positive()
    .describe('Bugün verilecek yem miktarı (kg)'),
  biomassKg: z.number().positive()
    .describe('Mevcut biyokütle (kg)'),
  tankVolumeM3: z.number().positive()
    .describe('Tank hacmi (m³)'),
  temperature: z.number().min(0).max(45)
    .describe('Su sıcaklığı (°C)'),
  salinity: z.number().min(0).max(45).default(0)
    .describe('Tuzluluk (ppt) — tatlı su için 0'),
  currentPH: z.number().min(4).max(12)
    .describe('Mevcut pH değeri (NBS ölçeği)'),
  currentTANmgL: z.number().min(0).optional()
    .describe('Mevcut TAN seviyesi (mg/L) — varsa toplam TAN tahminine eklenir'),
  hasBiofilter: z.boolean().default(false)
    .describe('Biyofiltre (RAS) sistemi mevcut mu?'),
  feedProteinPercent: z.number().min(0).max(100).optional()
    .describe('Yem protein oranı (%) — verilirse TAN hesabı buna göre yapılır. Örn: 42 = %42 protein'),
  speciesCode: z.string().optional()
    .describe('Tür kodu: salmon, tilapia, trout, seabass, seabream — feedProteinPercent verilmezse TAN katsayısı için'),
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
      feedProteinPercent: { type: 'number', description: 'Yem protein oranı (%) — TAN = 0.092 × protein% × yem_kg. Verilmezse tür katsayısı kullanılır' },
      speciesCode: { type: 'string', description: 'Tür kodu: salmon, tilapia, trout, seabass, seabream — feedProteinPercent yoksa kullanılır' },
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
// TÜR BAZLI SABİTLER
// ============================================================================

/**
 * TAN Üretim Formülü (Protein Bazlı)
 *
 * BİRİNCİL FORMÜL (feedProteinPercent verilirse):
 *   TAN_kg = 0.092 × (protein% / 100) × feedKg
 *
 *   0.092 katsayısı nereden geliyor:
 *     - Protein → Azot: %16 (aminoasit ortalaması, N/protein = 0.16)
 *     - Sindirim: %~80 sindirilir (sindirilebilirlik katsayısı)
 *     - Metabolizma: Sindirilen proteinin %~72'si TAN olarak atılır
 *     - 0.16 × 0.80 × 0.72 ≈ 0.092
 *
 *   KAYNAK: Timmons & Ebeling (2013), Ebeling et al. (2006)
 *
 *   ÖRNEK: %42 protein yem, 50 kg:
 *     TAN = 0.092 × 0.42 × 50 = 1.932 kg TAN
 *
 * YEDEK FORMÜL (feedProteinPercent verilmezse):
 *   Tür bazlı sabit katsayı kullanılır (aşağıdaki tablo)
 *   Bu katsayılar ~%40 protein yemine göre kalibre edilmiştir
 *
 * BİRİM DÖNÜŞÜMLERİ:
 *   TAN konsantrasyon artışı (mg/L):
 *     1 m³ = 1000 L
 *     1 kg TAN = 1.000.000 mg TAN
 *     Yani: 1 gram TAN / 1 m³ = 1 mg/L artış
 *     Genel: TAN_artış_mgL = TAN_kg × 1000 / tankVolumeM3
 *     (kg → g: ×1000, m³ → m³: /1)
 *     Veya eşdeğer: TAN_kg × 1.000.000 / (tankVolumeM3 × 1000)
 */
const TAN_PROTEIN_COEFFICIENT = 0.092;

/**
 * Tür bazlı yedek TAN katsayıları (kg TAN / kg yem)
 * Sadece feedProteinPercent verilmediğinde kullanılır.
 * ~%40 protein yemine göre kalibre edilmiştir.
 */
const TAN_COEFFICIENTS: Record<string, number> = {
  salmon: 0.028,       // %38-42 protein yem
  trout: 0.028,        // benzer metabolizma
  tilapia: 0.032,      // %32-38 protein, yüksek metabolizma
  seabass: 0.030,      // %42-45 protein yem
  seabream: 0.030,
  catfish: 0.030,
  shrimp: 0.025,       // düşük protein dönüşümü
};

/** Varsayılan TAN katsayısı — tür belirtilmezse */
const DEFAULT_TAN_COEFFICIENT = 0.030;

/**
 * NH3 güvenli sınır değerleri — tür bazında (mg/L NH3-N)
 *
 * NH3 (iyonize olmamış amonyak) balıklar için toksiktir.
 * Kronik maruziyet sınırı türe göre değişir.
 *
 *   - Salmon/Trout: Soğuk su türleri, NH3'e hassas → 0.012 mg/L
 *   - Tilapia: Tropikal tür, NH3'e dayanıklı → 0.05 mg/L
 *   - Seabass/Seabream: Deniz türleri → 0.02 mg/L
 *   - Varsayılan: Koruyucu yaklaşım → 0.02 mg/L
 *
 * KAYNAK: EPA Water Quality Criteria (2013), FAO Technical Paper 600
 */
const NH3_SAFE_LIMITS: Record<string, number> = {
  salmon: 0.012,
  trout: 0.012,
  tilapia: 0.05,
  seabass: 0.02,
  seabream: 0.02,
};

/** Varsayılan NH3 güvenli sınır — tür belirtilmezse */
const DEFAULT_NH3_LIMIT = 0.02;

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
  // ── Girdi Doğrulama ──────────────────────────────────────────
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
  } = input;

  // ── Tür Bazlı Katsayılar ────────────────────────────────────
  const speciesKey = speciesCode?.toLowerCase() ?? '';
  const nh3Limit = NH3_SAFE_LIMITS[speciesKey] ?? DEFAULT_NH3_LIMIT;

  // ════════════════════════════════════════════════════════════════
  // 1. TAN ÜRETİM HESABI
  // ════════════════════════════════════════════════════════════════
  //
  // İKİ HESAPLAMA YOLU:
  //
  // A) Protein bazlı (feedProteinPercent verilirse — DAHA DOĞRU):
  //    TAN_kg = 0.092 × (protein% / 100) × feedKg
  //    Kaynak: 0.092 = 0.16 (N/protein) × 0.80 (sindirim) × 0.72 (atılım)
  //
  //    Birim kontrol:
  //      0.092 × 0.42 × 50 kg = 1.932 kg TAN
  //      1.932 kg TAN / 1 m³ = 1932 g / 1000 L = 1.932 mg/L artış (1 m³'te)
  //
  // B) Tür bazlı sabit katsayı (feedProteinPercent yoksa — YAKLAŞIM):
  //    TAN_kg = feedKg × TAN_katsayısı (tür bazlı, ~%40 protein kalibreli)
  //
  const feedProteinPercent = input.feedProteinPercent;
  let tanCoefficient: number;
  let tanMethod: string;

  if (feedProteinPercent !== undefined && feedProteinPercent > 0) {
    // Protein bazlı hesap: TAN = 0.092 × protein_oran × yem_miktarı
    tanCoefficient = TAN_PROTEIN_COEFFICIENT * (feedProteinPercent / 100);
    tanMethod = `protein_based (0.092 × ${feedProteinPercent}% = ${round(tanCoefficient, 4)})`;
  } else {
    // Tür bazlı sabit katsayı
    tanCoefficient = TAN_COEFFICIENTS[speciesKey] ?? DEFAULT_TAN_COEFFICIENT;
    tanMethod = `species_coefficient (${speciesKey || 'default'} = ${tanCoefficient})`;
  }

  const tanProductionKg = feedKg * tanCoefficient;

  // ── TAN Konsantrasyon Artışı (mg/L) ──────────────────────────
  //
  // FORMÜL: TAN_artış_mgL = (TAN_kg × 1.000.000) / (hacim_m3 × 1000)
  //
  // Birim dönüşümü:
  //   TAN_kg → TAN_mg: × 1.000.000 (1 kg = 10^6 mg)
  //   hacim_m3 → hacim_L: × 1000 (1 m³ = 1000 L)
  //   Sonuç: mg / L = mg/L (ppm)
  //
  // NOT: Bu, hiç TAN giderimi olmadığı varsayımıdır (en kötü senaryo).
  // Gerçekte biyofiltre ve su değişimi TAN'ı azaltır.
  const tankVolumeL = tankVolumeM3 * 1000;
  const tanIncreaseMgL = (tanProductionKg * 1_000_000) / tankVolumeL;

  // ── Zirve TAN Konsantrasyonu ────────────────────────────────
  //
  // Mevcut TAN seviyesi varsa üzerine eklenir.
  // Yoksa sadece yemden kaynaklanan TAN artışı kullanılır.
  // Bu, gün içindeki en yüksek TAN seviyesini temsil eder.
  const peakTANmgL = (currentTANmgL ?? 0) + tanIncreaseMgL;

  // ════════════════════════════════════════════════════════════════
  // 2. AMONYAK (NH3) RİSK DEĞERLENDİRMESİ
  // ════════════════════════════════════════════════════════════════
  //
  // Su içindeki TAN iki formda bulunur:
  //   NH4+ (iyonize) — nispeten zararsız
  //   NH3  (iyonize olmamış) — toksik!
  //
  // NH3 fraksiyonu pH ve sıcaklıkla ARTAR:
  //   - Yüksek pH → daha fazla NH3 (daha toksik)
  //   - Yüksek sıcaklık → daha fazla NH3 (daha toksik)
  //   - Yüksek tuzluluk → biraz daha az NH3 (hafif koruyucu etki)
  //
  // fractionNH3(pHnbs, tempC, S):
  //   Millero (1995) amonyum ayrışma sabiti (KNH4) kullanarak
  //   NH3 fraksiyonunu hesaplar. pH ölçeğini NBS'den Free'ye çevirir.
  //   Formül: f = KNH4 / (KNH4 + [H+])
  const nh3Fraction = fractionNH3(currentPH, temperature, salinity);

  // ── Tahmini NH3 Konsantrasyonu ──────────────────────────────
  //
  // FORMÜL: NH3_mgL = zirveTAN × NH3_fraksiyonu
  //
  // Bu değer, yem verildikten sonra oluşabilecek en yüksek
  // NH3 seviyesini gösterir (pH sabit kalırsa).
  const peakNH3mgL = peakTANmgL * nh3Fraction;

  // ── NH3 Güvenli / Tehlikeli Durumu ──────────────────────────
  const nh3ExceedsLimit = peakNH3mgL > nh3Limit;

  // ── Kritik pH Hesabı ────────────────────────────────────────
  //
  // criticalPHforNH3(tan, nh3Limit, tempC, S):
  //   Verilen TAN konsantrasyonunda NH3'ün toksik limite ulaştığı
  //   pH değerini bisection yöntemiyle bulur.
  //
  //   Mantık: pH arttıkça NH3 fraksiyonu artar.
  //   pH = criticalPH olduğunda: TAN × fraction(pH) = nh3Limit
  //
  //   Bu pH'ın ALTINDA kalmak güvenlidir.
  const criticalPH = criticalPHforNH3(peakTANmgL, nh3Limit, temperature, salinity);

  // ── Güvenlik Marjı ──────────────────────────────────────────
  //
  // safetyMargin = criticalPH - currentPH
  //
  // Pozitif değer → pH hâlâ güvenli bölgede (kritik eşiğin altında)
  // Negatif değer → pH kritik eşiği aşmış (TEHLİKE!)
  // Sıfıra yakın → alarm bölgesi (dikkatli olunmalı)
  //
  // NOT: criticalPH, NaN olabilir (limit hiç aşılamıyorsa — çok düşük TAN)
  const safetyMargin = isNaN(criticalPH) ? null : criticalPH - currentPH;

  // ── UIA Durum Değerlendirmesi ───────────────────────────────
  //
  // uiaStatus(currentPH, criticalPH):
  //   'safe'   → pH kritik eşikten >0.2 uzakta (yeşil)
  //   'alert'  → pH kritik eşiğe 0.2 birim içinde (sarı)
  //   'danger' → pH kritik eşiği aşmış (kırmızı)
  const ammoniaSafetyStatus = uiaStatus(currentPH, criticalPH);

  // ════════════════════════════════════════════════════════════════
  // 3. OKSİJEN TALEBİ HESABI
  // ════════════════════════════════════════════════════════════════
  //
  // Üç ana oksijen tüketim kaynağı vardır:
  //
  const { fishO2: o2FishKg, biofilterO2: o2BiofilterKg, organicO2: o2OrganicKg, totalO2: totalO2DemandKg } =
    calcO2Consumption({ dailyFeedKg: feedKg, tanKg: tanProductionKg, hasBiofilter });

  // ── Saatlik O2 Talebi (mg/L/saat) ──────────────────────────
  //
  // FORMÜL: O2_rate = toplam_O2_kg × 1.000.000 / (24 × hacim_m3 × 1000)
  //
  // Birim dönüşümü:
  //   kg → mg: × 1.000.000
  //   Günlük → Saatlik: / 24
  //   m3 → L: × 1000
  //   Sonuç: mg/L/saat
  //
  // Bu, sabit havalandırma olmadığında DO'nun saatte ne kadar
  // düşeceğini gösterir (en kötü senaryo tahmini).
  const o2DemandMgLPerHour = (totalO2DemandKg * 1_000_000) / (24 * tankVolumeL);

  // ════════════════════════════════════════════════════════════════
  // 4. YEMLEME ORANI DEĞERLENDİRMESİ
  // ════════════════════════════════════════════════════════════════
  //
  // FORMÜL: oran = (yem_kg / biyokütle_kg) × 100
  // BİRİM: % vücut ağırlığı / gün (%BW/gün)
  //
  // Bu oran, balığın vücut ağırlığına oranla ne kadar yem aldığını gösterir.
  // Su ürünleri yetiştiriciliğinde temel bir performans göstergesidir.
  //
  // DEĞERLENDİRME KRİTERLERİ:
  //   < 0.5%  → Düşük (yetersiz beslenme, stres veya hastalık belirtisi)
  //   0.5-3%  → Normal (çoğu tür için optimal aralık)
  //   3-5%    → Yüksek (genç/larva balıklar için normal olabilir)
  //   > 5%    → Aşırı yemleme (su kalitesi bozulma riski!)
  //
  // DİKKAT: Optimum oran türe, yaşa, sıcaklığa ve mevsime göre değişir.
  //   Soğuk su türleri (salmon): %1-2 yetişkin, %3-5 jüvenil
  //   Tropikal türler (tilapia): %2-3 yetişkin, %5-8 yavru
  const feedingRatePercent = (feedKg / biomassKg) * 100;

  let feedingRateStatus: string;
  if (feedingRatePercent < 0.5) {
    feedingRateStatus = 'low';        // Düşük — yetersiz beslenme riski
  } else if (feedingRatePercent <= 3) {
    feedingRateStatus = 'normal';     // Normal — çoğu tür için uygun
  } else if (feedingRatePercent <= 5) {
    feedingRateStatus = 'high';       // Yüksek — su kalitesi izlenmeli
  } else {
    feedingRateStatus = 'overfeeding'; // Aşırı — acil dikkat gerekli!
  }

  // ════════════════════════════════════════════════════════════════
  // 5. SONUÇ YAPISI
  // ════════════════════════════════════════════════════════════════

  const result = {
    // ── TAN Üretimi ─────────────────────────────────────────────
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

    // ── Amonyak Riski ───────────────────────────────────────────
    ammoniaRisk: {
      nh3FractionAtCurrentPH: round(nh3Fraction, 6),
      nh3FractionPercent: round(nh3Fraction * 100, 4),
      peakNH3mgL: round(peakNH3mgL, 6),
      nh3SafeLimitMgL: nh3Limit,
      exceedsLimit: nh3ExceedsLimit,
      criticalPH: isNaN(criticalPH) ? null : round(criticalPH, 4),
      currentPH,
      safetyMarginPH: safetyMargin !== null ? round(safetyMargin, 4) : null,
      status: ammoniaSafetyStatus,
      explanation: isNaN(criticalPH)
        ? `TAN seviyesi (${round(peakTANmgL, 2)} mg/L) yeterince düşük — NH3 limiti herhangi bir pH'da aşılmaz.`
        : `pH ${round(criticalPH, 2)} değerini aşarsa NH3 toksik limite (${nh3Limit} mg/L) ulaşır. ` +
          `Mevcut pH: ${currentPH}, marj: ${round(safetyMargin!, 2)} pH birimi.`,
    },

    // ── Oksijen Talebi ──────────────────────────────────────────
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

    // ── Yemleme Oranı ───────────────────────────────────────────
    feedingRate: {
      feedKg,
      biomassKg,
      ratePercent: round(feedingRatePercent, 2),
      status: feedingRateStatus,
      explanation:
        `Yemleme oranı: ${round(feedingRatePercent, 2)}% BW/gün — ` +
        `${feedingRateStatus === 'low' ? 'düşük (yetersiz beslenme riski)' :
          feedingRateStatus === 'normal' ? 'normal aralıkta' :
          feedingRateStatus === 'high' ? 'yüksek (su kalitesi izlenmeli)' :
          'aşırı yemleme! Su kalitesi bozulma riski yüksek.'}`,
    },
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}


