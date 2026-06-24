// ─── Su Tedavi Planı (Water Treatment Planner) ───────────────────────────
//
// AMAÇ:
//   TAN, H₂S ve CO₂ kısıtlarını birlikte değerlendirerek güvenli pH aralığı
//   hesaplar, biyofiltre alkalinite tüketimini hesaba katar ve otomasyon için
//   önceliklendirilmiş tedavi reçeteleri üretir.
//
// NASIL ÇALIŞIR:
//   1. Güvenli pH aralığı hesaplanır:
//      - NH₃ üst sınırı: pH ↑ → NH₃ ↑ → criticalPH_NH3 (üst limit)
//      - H₂S alt sınırı: pH ↓ → H₂S ↑ → criticalPH_H2S (alt limit)
//      - CO₂ alt sınırı: pH ↓ → CO₂ ↑ → criticalPH_CO2 (alt limit)
//      - Güvenli aralık = max(criticalPH_CO2, criticalPH_H2S) ... criticalPH_NH3
//
//   2. Biyofiltre alkalinite tüketimi (nitrifikasyon):
//      - NH₄⁺ → NO₂⁻ → NO₃⁻ sırasında alkalinite tüketilir
//      - 1 mg NH₄-N oksidasyonu = 7.14 mg CaCO₃ alkalinite kaybı
//      - Günlük kayıp = TAN_üretimi_mg × 7.14
//
//   3. Tedavi reçeteleri (otomasyon önceliğine göre sıralı):
//      a) CO₂ dozlama (en kolay — CO₂ hattı varsa)
//      b) CO₂ degassing bypass (bedava — H₂S riski yoksa)
//      c) NaHCO₃ ekleme (orta zorluk — manuel)
//      d) Ca(OH)₂ / NaOH (etkili ama riskli — pH spike)
//      e) HCl (pH düşürme — nadiren gerekli)
//
//   Her reçete için:
//      - Zorluk derecesi (1-5)
//      - Otomasyon uyumluluğu (otomatik / yarı-otomatik / manuel)
//      - Tahmini sonuç (yeni pH, CO₂, NH₃, H₂S durumu)
//      - Risk değerlendirmesi (H₂S ani ölüm riski, pH spike riski vb.)
//      - Ekipman gereksinimi
//
// OTOMASYON ENTEGRASYONU:
//   Bu tool'un çıktısı doğrudan otomasyon sistemine bağlanabilir:
//   - "CO₂ dozaj hattını aç" → relay komutu
//   - "Degassing bypass'ı kapat" → vana komutu
//   - "X kg NaHCO₃ ekle" → dozaj pompası komutu
//
// EXTENSIBLE: Yeni reçete tipi eklemek için TREATMENT_RECIPES dizisine eleman ekleyin.
//

import { z } from 'zod';
import {
  fractionNH3, calcNH3, criticalPHforNH3, calcSafeTAN, uiaStatus,
  fractionH2S, calcH2S, calcTotalSulfide, criticalPHforH2S,
  co2Level, criticalPHforCO2,
  calcDicOfAlk, calcAlkOfDicPh,
  REAGENTS, alkMgToMeq, alkMeqToMg,
  // Deffeyes diyagramı fonksiyonları
  generateSafeZone, calcOperatingPoint, calcTargetPoint,
  calculateDosingRecipes,
} from '@platform/aquaculture-engines';
import { round } from '../../utils/formatters.js';

// ─── Zod Input Schema ────────────────────────────────────────────────────

export const inputSchema = z.object({
  // Mevcut su parametreleri
  temperature: z.number().min(0).max(45).describe('Su sıcaklığı (°C)'),
  ph: z.number().min(4).max(12).describe('Mevcut pH'),
  salinity: z.number().min(0).default(0).describe('Tuzluluk (ppt)'),
  alkalinity: z.number().min(0).describe('Alkalinite (mg/L CaCO₃)'),

  // Toksin seviyeleri
  tan: z.number().min(0).describe('Toplam amonyak azotu — TAN (mg/L)'),
  // H₂S: İKİ GİRİŞ YOLU — biri verilmeli
  // A) h2sMeasured: Cihazdan okunan H₂S değeri (µg/L) — totalSulfide otomatik hesaplanır
  // B) totalSulfide: Toplam sülfid (µg/L) — doğrudan verilir
  h2sMeasured: z.number().min(0).optional().describe('Ölçülen H₂S değeri (µg/L) — cihaz okuması. Verilirse totalSulfide otomatik hesaplanır'),
  h2sMeasuredAtPH: z.number().min(4).max(12.5).optional().describe('H₂S ölçümünün yapıldığı pH. Verilmezse mevcut pH kullanılır'),
  totalSulfide: z.number().min(0).default(0).describe('Toplam sülfid (µg/L) — h2sMeasured verilmişse kullanılmaz'),

  // Toksin limitleri (opsiyonel — tür bazlı override)
  nh3LimitMgL: z.number().positive().default(0.02).describe('NH₃ güvenli limit (mg/L)'),
  h2sLimitUgL: z.number().positive().default(2).describe('H₂S güvenli limit (µg/L)'),
  co2CriticalMgL: z.number().positive().default(20).describe('CO₂ kritik limit (mg/L)'),

  // Biyofiltre bilgileri
  hasBiofilter: z.boolean().default(false).describe('RAS biyofiltresi var mı?'),
  dailyFeedKg: z.number().min(0).default(0).describe('Günlük yem (kg) — alkalinite tüketim hesabı için'),
  feedProteinPercent: z.number().min(0).max(100).default(42).describe('Yem protein oranı (%). TAN = 0.092 × protein% × yem_kg'),
  tanCoefficientKgPerKgFeed: z.number().min(0).optional().describe('Sabit TAN katsayısı (kg TAN/kg yem) — feedProteinPercent verilmişse kullanılmaz'),

  // Tank bilgileri
  tankVolumeM3: z.number().positive().describe('Tank hacmi (m³)'),

  // Ekipman bilgileri
  hasCO2Line: z.boolean().default(false).describe('CO₂ dozlama hattı var mı?'),
  hasDegassing: z.boolean().default(false).describe('Degassing (CO₂ giderme) ünitesi var mı?'),

  // Tedavi parametreleri
  availableReagents: z.array(z.string()).optional().describe('Kullanılabilir kimyasallar listesi'),
  minAlkalinityMgL: z.number().min(0).optional().describe('Minimum alkalinite hedefi (mg/L CaCO₃)'),

  // Hedef (opsiyonel)
  targetPH: z.number().min(4).max(12).optional().describe('Hedef pH (belirtilmezse güvenli aralığın ortası)'),
});

// ─── Tool Definition (MCP) ──────────────────────────────────────────────

export const definition = {
  name: 'plan_water_treatment',
  description:
    'Su tedavi planı: TAN/H₂S/CO₂ kısıtlarını birlikte değerlendirerek güvenli pH aralığı hesaplar, ' +
    'biyofiltre alkalinite tüketimini hesaba katar ve otomasyon-uyumlu önceliklendirilmiş tedavi reçeteleri üretir. ' +
    'Her reçete zorluk derecesi, ekipman gereksinimi, tahmini sonuç ve risk değerlendirmesi içerir.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      temperature: { type: 'number', description: 'Su sıcaklığı (°C)' },
      ph: { type: 'number', description: 'Mevcut pH' },
      salinity: { type: 'number', description: 'Tuzluluk (ppt)', default: 0 },
      alkalinity: { type: 'number', description: 'Alkalinite (mg/L CaCO₃)' },
      tan: { type: 'number', description: 'TAN (mg/L)' },
      h2sMeasured: { type: 'number', description: 'Cihazdan okunan H₂S (µg/L) — verilirse totalSulfide otomatik hesaplanır' },
      totalSulfide: { type: 'number', description: 'Toplam sülfid (µg/L) — h2sMeasured verilmişse kullanılmaz', default: 0 },
      nh3LimitMgL: { type: 'number', description: 'NH₃ limit (mg/L)', default: 0.02 },
      h2sLimitUgL: { type: 'number', description: 'H₂S limit (µg/L)', default: 2 },
      co2CriticalMgL: { type: 'number', description: 'CO₂ limit (mg/L)', default: 20 },
      hasBiofilter: { type: 'boolean', description: 'Biyofiltre var mı?', default: false },
      dailyFeedKg: { type: 'number', description: 'Günlük yem (kg)', default: 0 },
      tanCoefficientKgPerKgFeed: { type: 'number', description: 'TAN katsayısı', default: 0.03 },
      tankVolumeM3: { type: 'number', description: 'Tank hacmi (m³)' },
      hasCO2Line: { type: 'boolean', description: 'CO₂ hattı var mı?', default: false },
      hasDegassing: { type: 'boolean', description: 'Degassing ünitesi var mı?', default: false },
      targetPH: { type: 'number', description: 'Hedef pH (opsiyonel)' },
    },
    required: ['temperature', 'ph', 'alkalinity', 'tan', 'tankVolumeM3'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ─── Reçete Tipleri ──────────────────────────────────────────────────────

interface TreatmentRecipe {
  id: string;
  name: string;
  description: string;
  difficulty: 1 | 2 | 3 | 4 | 5;    // 1=en kolay, 5=en zor
  automationLevel: 'automatic' | 'semi-automatic' | 'manual';
  equipmentRequired: string[];
  action: string;                      // Otomasyon komutu açıklaması
  predictedOutcome: {
    newPH: number;
    newCO2MgL: number;
    newNH3MgL: number;
    nh3Status: string;
    newH2SMgL: number | null;
    h2sStatus: string | null;
    newAlkMgL: number;
  };
  risks: string[];
  applicable: boolean;                // Bu reçete uygulanabilir mi?
  notApplicableReason?: string;        // Neden uygulanamaz
  insight: string;                     // Türkçe özet
}

interface DeffeyesDosingRecipe {
  steps: Array<{ reagentName: string; formula: string; amountKg: number }>;
  finalPH: number;
  finalCO2mgL: number;
  feasible: boolean;
}

interface DeffeyesAnalysis {
  currentPoint: { DIC: number; ALK: number };
  safeZone: { topLeft: { DIC: number; ALK: number }; topRight: { DIC: number; ALK: number }; bottomLeft: { DIC: number; ALK: number }; bottomRight: { DIC: number; ALK: number } } | null;
  targetPoint: { DIC: number; ALK: number } | null;
  isInsideSafeZone: boolean;
  dosingRecipes: DeffeyesDosingRecipe[];
  insight: string;
}

// ─── Sabiterler ──────────────────────────────────────────────────────────

// Nitrifikasyon alkalinite tüketimi:
// NH₄⁺ + 2O₂ → NO₃⁻ + 2H⁺ + H₂O
// Her 1 mg NH₄-N oksidasyonu 7.14 mg CaCO₃ alkalinite tüketir
// Kaynak: Timmons & Ebeling (2013), Tablo 5.2
const ALKALINITY_PER_MG_TAN = 7.14; // mg CaCO₃ / mg TAN

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

// ─── Handler ─────────────────────────────────────────────────────────────

export async function handler(params: unknown): Promise<ToolResult> {
  const input = inputSchema.parse(params);
  const { temperature: T, ph, salinity: S, alkalinity, tan } = input;

  // ── H₂S: Ölçüm → Toplam Sülfid Dönüşümü ─────────────────────
  // Kullanıcı H₂S cihaz okuması verirse (h2sMeasured), totalSulfide'ı
  // ters hesapla: totalSulfide = h2sMeasured / fractionH2S(measurementPH, T, S)
  // Çünkü cihaz sadece toksik H₂S formunu ölçer, ama toplam sülfid
  // (H₂S + HS⁻ + S²⁻) pH'a göre değişir.
  let totalSulfide: number;
  if (input.h2sMeasured !== undefined && input.h2sMeasured > 0) {
    // Ters hesap: H₂S ölçümünden toplam sülfid bul
    totalSulfide = calcTotalSulfide(input.h2sMeasured, input.h2sMeasuredAtPH ?? ph, T, S);
  } else {
    totalSulfide = input.totalSulfide ?? 0;
  }
  const { nh3LimitMgL, h2sLimitUgL, co2CriticalMgL } = input;
  const { hasBiofilter, dailyFeedKg, feedProteinPercent, tanCoefficientKgPerKgFeed, tankVolumeM3, minAlkalinityMgL } = input;

  // TAN katsayısı: protein bazlı (öncelikli) veya sabit katsayı
  // Formül: TAN = 0.092 × (protein% / 100) × yem_kg
  const effectiveTanCoeff = feedProteinPercent > 0
    ? 0.092 * (feedProteinPercent / 100)
    : (tanCoefficientKgPerKgFeed ?? 0.03);
  const hasCO2Line = input.hasCO2Line ?? false;
  const hasDegassing = input.hasDegassing ?? false;
  const availableReagents = input.availableReagents ?? ['Sodium Bicarbonate'];
  const minAlkalinityMgL2 = input.minAlkalinityMgL ?? 40;
  const volumeL = tankVolumeM3 * 1000;

  // ──────────────────────────────────────────────────────────────────────
  // 1. MEVCUT DURUM ANALİZİ
  // ──────────────────────────────────────────────────────────────────────

  // NH₃ mevcut durum
  const currentNH3 = calcNH3(tan, ph, T, S);
  const nh3Fraction = fractionNH3(ph, T, S);
  const nh3Exceeds = currentNH3 > nh3LimitMgL;

  // H₂S mevcut durum (totalSulfide > 0 ise)
  const hasH2SRisk = totalSulfide > 0;
  const currentH2S = hasH2SRisk ? calcH2S(totalSulfide, ph, T, S) : 0;
  const h2sFraction = hasH2SRisk ? fractionH2S(ph, T, S) : 0;
  const h2sExceeds = hasH2SRisk ? currentH2S > h2sLimitUgL : false;

  // CO₂ mevcut durum
  const alkMeq = alkMgToMeq(alkalinity);
  const currentCO2 = co2Level(alkMeq, ph, T, S);
  const co2Exceeds = currentCO2 > co2CriticalMgL;

  // ──────────────────────────────────────────────────────────────────────
  // 2. GÜVENLİ pH ARALIĞI HESABI
  //
  // Üç toksin kısıtının kesişimi:
  //   pH ↑ → NH₃ ↑ (üst sınır)
  //   pH ↓ → H₂S ↑ (alt sınır, sülfid varsa)
  //   pH ↓ → CO₂ ↑ (alt sınır)
  //
  // Güvenli aralık = [max(pH_CO₂, pH_H₂S), pH_NH₃]
  // ──────────────────────────────────────────────────────────────────────

  // NH₃ üst sınır: pH bu değerin üstüne çıkarsa NH₃ > limit
  let upperLimitPH: number;
  try {
    upperLimitPH = criticalPHforNH3(tan, nh3LimitMgL, T, S);
  } catch {
    // TAN çok düşükse limit hiç aşılmaz
    upperLimitPH = 14;
  }

  // CO₂ alt sınır: pH bu değerin altına düşerse CO₂ > limit
  let lowerLimitCO2: number;
  try {
    lowerLimitCO2 = criticalPHforCO2(alkMeq, co2CriticalMgL, T, S);
  } catch {
    lowerLimitCO2 = 0;
  }

  // H₂S alt sınır: pH bu değerin altına düşerse H₂S > limit
  let lowerLimitH2S = 0;
  if (hasH2SRisk) {
    try {
      lowerLimitH2S = criticalPHforH2S(currentH2S, ph, h2sLimitUgL, T, S);
    } catch {
      lowerLimitH2S = 0;
    }
  }

  // Güvenli aralık
  const safePHLower = round(Math.max(lowerLimitCO2, lowerLimitH2S), 2);
  const safePHUpper = round(upperLimitPH, 2);
  const safePHRange = safePHUpper > safePHLower
    ? { min: safePHLower, max: safePHUpper, width: round(safePHUpper - safePHLower, 2) }
    : null; // Güvenli aralık yok — çelişkili kısıtlar

  const limitingFactors: string[] = [];
  if (safePHLower === lowerLimitH2S && hasH2SRisk) limitingFactors.push('H₂S (alt sınır)');
  if (safePHLower === lowerLimitCO2) limitingFactors.push('CO₂ (alt sınır)');
  limitingFactors.push('NH₃ (üst sınır)');

  // Hedef pH belirleme
  const targetPH = input.targetPH ?? (safePHRange
    ? round((safePHRange.min + safePHRange.max) / 2, 2)
    : ph); // Güvenli aralık yoksa mevcut pH degeri koru

  // ──────────────────────────────────────────────────────────────────────
  // 3. BİYOFİLTRE ALKALİNİTE TÜKETİMİ
  //
  // Nitrifikasyon: NH₄⁺ → NO₃⁻
  //   - Her 1 mg TAN-N oksidasyonu 7.14 mg CaCO₃ tüketir
  //   - Günlük TAN üretimi = dailyFeedKg × tanCoefficient × 1000 (g→mg dönüşümü)
  //     Ama TAN mg olarak: feed_kg × coeff × 10⁶ / volumeL ile mg/L hesaplanır
  //   - Alkalinite kaybı = TAN_üretim_mg × 7.14
  //
  // Kaynak: Timmons & Ebeling (2013), Ebeling et al. (2006)
  // ──────────────────────────────────────────────────────────────────────

  let biofilterAlkConsumption = null;
  if (hasBiofilter && dailyFeedKg > 0) {
    // Günlük TAN üretimi (kg → mg)
    const dailyTANkg = dailyFeedKg * effectiveTanCoeff;
    const dailyTANmg = dailyTANkg * 1_000_000; // kg → mg

    // Biyofiltre nitrifikasyonuyla tüketilen alkalinite (mg CaCO₃)
    const alkConsumptionMg = dailyTANmg * ALKALINITY_PER_MG_TAN;

    // Konsantrasyon olarak alkalinite kaybı (mg/L CaCO₃)
    const alkConsumptionMgL = alkConsumptionMg / volumeL;

    // Kaç günde alkalinite sıfırlanır?
    const daysToDepletion = alkalinity > 0 ? round(alkalinity / alkConsumptionMgL, 1) : 0;

    // Günlük NaHCO₃ ihtiyacı (alkalinite telafisi)
    // NaHCO₃: 84.007 g/mol, 1 meq/mol
    // alkConsumptionMgL → meq/L → mol → gram
    const alkConsumptionMeqL = alkMgToMeq(alkConsumptionMgL);
    const dailyNaHCO3mol = (alkConsumptionMeqL * volumeL) / 1000; // meq → mol
    const dailyNaHCO3grams = dailyNaHCO3mol * 84.007;

    biofilterAlkConsumption = {
      dailyTANproductionMg: round(dailyTANmg, 0),
      dailyAlkConsumptionMgL: round(alkConsumptionMgL, 2),
      dailyAlkConsumptionTotalMg: round(alkConsumptionMg, 0),
      daysToAlkDepletion: daysToDepletion,
      dailyNaHCO3compensationKg: round(dailyNaHCO3grams / 1000, 3),
      insight: `Biyofiltre günde ${round(alkConsumptionMgL, 1)} mg/L CaCO₃ alkalinite tüketiyor. ` +
        `Mevcut alkalinite (${alkalinity} mg/L) ${daysToDepletion} günde tükenecek. ` +
        `Telafi için günde ${round(dailyNaHCO3grams / 1000, 2)} kg NaHCO₃ gerekli.`,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // 4. TEDAVİ REÇETELERİ
  //
  // ÖNCELİK SIRASI (otomasyon kolaylığına göre):
  //   1. CO₂ dozlama — en kolay, otomatik, pH düşürür
  //   2. CO₂ degassing — bedava, otomatik, pH yükseltir
  //   3. NaHCO₃ ekleme — orta zorluk, alkalinite + pH yükseltir
  //   4. Na₂CO₃ ekleme — benzer ama daha etkili
  //   5. Ca(OH)₂ / NaOH — pH yükseltir ama spike riski
  //   6. HCl — pH düşürür ama tehlikeli
  //
  // KURAL: CO₂ bazlı reçeteler HER ZAMAN önce gelir çünkü:
  //   - En düşük maliyetli
  //   - Otomasyon en kolay
  //   - Balıklar doğal olarak CO₂ üretir (degassing bypass = bedava)
  //   - Kimyasal riski yok
  //
  // DİKKAT: pH düşüren reçetelerde H₂S kontrolü ZORUNLU
  //   - pH ↓ → H₂S fraksiyonu ↑ → ani ölüm riski
  //   - H₂S riski varsa pH düşüren reçeteler UYARIYLA işaretlenir
  // ──────────────────────────────────────────────────────────────────────

  const recipes: TreatmentRecipe[] = [];
  const phDelta = targetPH - ph;
  const needsLowerPH = phDelta < -0.05;
  const needsHigherPH = phDelta > 0.05;
  const phOK = Math.abs(phDelta) <= 0.05;

  // Yardımcı: Belirli pH'ta tüm toksik durumları hesapla
  function assessAtPH(newPH: number, newAlkMgL?: number): TreatmentRecipe['predictedOutcome'] {
    const effAlk = newAlkMgL ?? alkalinity;
    const effAlkMeq = alkMgToMeq(effAlk);
    const newCO2 = co2Level(effAlkMeq, newPH, T, S);
    const newNH3 = calcNH3(tan, newPH, T, S);
    const newH2S = hasH2SRisk ? calcH2S(totalSulfide, newPH, T, S) : 0;

    return {
      newPH: round(newPH, 2),
      newCO2MgL: round(newCO2, 2),
      newNH3MgL: round(newNH3, 4),
      nh3Status: newNH3 > nh3LimitMgL ? 'DANGER' : newNH3 > nh3LimitMgL * 0.8 ? 'WARNING' : 'SAFE',
      newH2SMgL: hasH2SRisk ? round(newH2S, 4) : null,
      h2sStatus: hasH2SRisk ? (newH2S > h2sLimitUgL ? 'DANGER — ANİ ÖLÜM RİSKİ' : 'SAFE') : null,
      newAlkMgL: round(effAlk, 1),
    };
  }

  // ── Reçete 1: CO₂ Dozlama (pH düşürme) ────────────────────────────
  {
    const co2TargetPH = needsLowerPH ? targetPH : ph - 0.3; // pH degeri 0.3 düşür
    const outcome = assessAtPH(co2TargetPH);
    const h2sRisk = hasH2SRisk && outcome.h2sStatus?.includes('DANGER');

    recipes.push({
      id: 'co2_dosing',
      name: 'CO₂ Dozlama',
      description: 'CO₂ enjeksiyonu ile pH düşürme — en düşük maliyetli ve otomatik çözüm.',
      difficulty: 1,
      automationLevel: 'automatic',
      equipmentRequired: ['CO₂ tüpü', 'CO₂ dozlama hattı', 'pH kontrol sensörü'],
      action: `CO₂ dozaj hattını aç, hedef pH: ${co2TargetPH}. pH sensörü hedefe ulaşınca dozajı durdur.`,
      predictedOutcome: outcome,
      risks: [
        ...(h2sRisk ? ['H₂S riski VAR — pH düşerse H₂S toksik seviyeye çıkabilir, ANİ ÖLÜM RİSKİ!'] : []),
        'CO₂ > 20 mg/L olursa balıklarda solunum güçlüğü',
        outcome.newCO2MgL > co2CriticalMgL ? `CO₂ ${outcome.newCO2MgL} mg/L — kritik seviye aşılıyor!` : '',
      ].filter(r => r.length > 0),
      applicable: hasCO2Line && (needsLowerPH || ph > safePHUpper),
      notApplicableReason: !hasCO2Line
        ? 'CO₂ dozlama hattı yok'
        : (!needsLowerPH && ph <= safePHUpper)
          ? 'pH zaten güvenli aralıkta veya düşürmeye gerek yok'
          : undefined,
      insight: hasCO2Line
        ? `CO₂ dozlama: pH ${ph} → ${co2TargetPH}. ${h2sRisk ? '⚠️ H₂S ANİ ÖLÜM RİSKİ — bu reçeteyi KULLANMAYIN!' : 'En kolay ve ucuz çözüm.'}`
        : 'CO₂ dozlama hattı yok — bu reçete kullanılamaz.',
    });
  }

  // ── Reçete 2: Degassing Bypass (pH yükseltme — CO₂ giderme) ──────
  {
    // Degassing ile CO₂ giderilirse pH yükselir
    // Basit tahmin: CO₂'nin yarısı giderilirse yeni pH hesapla
    const currentDIC = calcDicOfAlk(alkMeq, ph, T, S);
    const reducedCO2 = currentCO2 * 0.3; // Degassing ile CO₂ %70 azalır
    // Yeni pH degeri bulmak için: azaltılmış CO₂'ye karşılık gelen pH
    // Basit iterasyon
    let degasPH = ph;
    for (let testPH = ph; testPH <= ph + 1.5; testPH += 0.05) {
      const testCO2 = co2Level(alkMeq, testPH, T, S);
      if (testCO2 <= reducedCO2) {
        degasPH = testPH;
        break;
      }
    }
    degasPH = round(degasPH, 2);
    const outcome = assessAtPH(degasPH);

    recipes.push({
      id: 'degassing_bypass',
      name: 'Degassing — CO₂ Giderme',
      description: 'CO₂ giderme ünitesini bypass etmeden çalıştırarak pH yükseltme. ' +
        'Balıklar doğal olarak CO₂ üretir — degassing bu CO₂\'yi atmosfere verir ve pH yükselir.',
      difficulty: 1,
      automationLevel: 'automatic',
      equipmentRequired: ['Degassing ünitesi (kolon/splash)', 'Havalandırma'],
      action: `Degassing ünitesini aktive et. pH ${ph} → ~${degasPH} yükselmesi beklenir.`,
      predictedOutcome: outcome,
      risks: [
        outcome.nh3Status === 'DANGER' ? `NH₃ riski — pH yükselince NH₃ ${outcome.newNH3MgL} mg/L olacak!` : '',
        'Aşırı degassing alkaliniteyi etkilemez ama pH degeri çok yükseltebilir',
      ].filter(r => r.length > 0),
      applicable: hasDegassing && (needsHigherPH || currentCO2 > co2CriticalMgL * 0.5),
      notApplicableReason: !hasDegassing
        ? 'Degassing ünitesi yok'
        : (!needsHigherPH && currentCO2 <= co2CriticalMgL * 0.5)
          ? 'pH yükseltmeye veya CO₂ gidermeye gerek yok'
          : undefined,
      insight: hasDegassing
        ? `Degassing: CO₂ ${round(currentCO2, 1)} → ~${outcome.newCO2MgL} mg/L, pH ${ph} → ~${degasPH}. ` +
          `${outcome.nh3Status === 'DANGER' ? '⚠️ NH₃ tehlikeli seviyeye çıkabilir!' : 'Bedava ve güvenli çözüm.'}`
        : 'Degassing ünitesi yok — balıkların ürettiği CO₂ giderilemiyor.',
    });
  }

  // ── Reçete 3: Degassing Bypass Kapatma (pH düşürme — CO₂ biriktir) ─
  if (hasDegassing && (needsLowerPH || ph > safePHUpper)) {
    // Degassing kapatılırsa balıkların ürettiği CO₂ suda birikir → pH düşer
    const outcome = assessAtPH(ph - 0.2); // ~0.2 pH düşüş tahmini

    recipes.push({
      id: 'degassing_off',
      name: 'Degassing Kapatma — CO₂ Biriktirme',
      description: 'Degassing ünitesini kapatarak balıkların ürettiği CO₂\'nin suda birikmesini sağla. ' +
        'Bedava ve doğal pH düşürme. CO₂ hattı yoksa en iyi alternatif.',
      difficulty: 1,
      automationLevel: 'automatic',
      equipmentRequired: ['Degassing ünitesi (kapatılacak)'],
      action: `Degassing bypass vanasını kapat. CO₂ birikecek, pH ~0.2-0.5 düşmesi beklenir.`,
      predictedOutcome: outcome,
      risks: [
        ...(hasH2SRisk && outcome.h2sStatus?.includes('DANGER')
          ? ['H₂S riski VAR — pH düşerse H₂S toksik olabilir, ANİ ÖLÜM RİSKİ!']
          : []),
        'CO₂ çok birikirse (>20 mg/L) solunum güçlüğü',
        'Yavaş etki — saatler sürebilir',
      ],
      applicable: !hasH2SRisk || currentH2S < h2sLimitUgL * 0.5,
      notApplicableReason: hasH2SRisk && currentH2S >= h2sLimitUgL * 0.5
        ? 'H₂S riski nedeniyle pH düşürmek tehlikeli'
        : undefined,
      insight: `Degassing kapat: balıkların CO₂'si biriktir, pH doğal olarak düşer. ` +
        `${hasH2SRisk ? '⚠️ H₂S kontrol edilmeli!' : 'H₂S riski yok — güvenle uygulanabilir.'}`,
    });
  }

  // ── Reçete 4: NaHCO₃ (Sodyum Bikarbonat) ──────────────────────────
  {
    const targetAlk = alkalinity + 30; // 30 mg/L alkalinite artışı
    const targetAlkMeq = alkMgToMeq(targetAlk);
    const deltaAlkMeq = targetAlkMeq - alkMeq;
    const molesNeeded = (deltaAlkMeq * volumeL) / 1000; // meq → mol
    const kgNeeded = round((molesNeeded * 84.007) / 1000, 2);

    // NaHCO₃ eklenince pH hafif yükselir
    const newDIC = calcDicOfAlk(alkMeq, ph, T, S) + molesNeeded / volumeL * 1000;
    let newPH = ph;
    try {
      // Yeni alkalinite ve DIC ile pH hesapla (iterasyon)
      for (let testPH = ph; testPH <= ph + 0.5; testPH += 0.02) {
        const testAlk = calcAlkOfDicPh(newDIC, testPH, T, S);
        if (Math.abs(testAlk - targetAlkMeq) < 0.01) {
          newPH = testPH;
          break;
        }
      }
    } catch {
      newPH = ph + 0.15; // Basit tahmin
    }

    const outcome = assessAtPH(round(newPH, 2), targetAlk);

    recipes.push({
      id: 'nahco3',
      name: 'Sodyum Bikarbonat (NaHCO₃)',
      description: 'Alkalinite ve pH artırır. Biyofiltre alkalinite tüketimini telafi eder. Güvenli ve yaygın.',
      difficulty: 2,
      automationLevel: 'semi-automatic',
      equipmentRequired: ['NaHCO₃ stoku', 'Dozaj pompası (opsiyonel)', 'Tartı'],
      action: `${kgNeeded} kg NaHCO₃ ekle (alkalinite ${alkalinity} → ${targetAlk} mg/L).`,
      predictedOutcome: outcome,
      risks: [
        'Aşırı dozda pH spike riski (yavaş ekleyin)',
        outcome.nh3Status !== 'SAFE' ? `pH artışı NH₃ toksisitesini artırabilir (${outcome.newNH3MgL} mg/L)` : '',
      ].filter(r => r.length > 0),
      applicable: true,
      insight: `NaHCO₃: ${kgNeeded} kg ekle → ALK ${alkalinity}→${targetAlk}, pH ${ph}→~${outcome.newPH}. ` +
        `${hasBiofilter ? 'Biyofiltre alkalinite telafisi için düzenli eklenmeli.' : ''}`,
    });
  }

  // ── Reçete 5: Ca(OH)₂ (Kalsiyum Hidroksit / Kireç) ────────────────
  {
    const targetAlk = alkalinity + 50;
    const targetAlkMeq = alkMgToMeq(targetAlk);
    const deltaAlkMeq = targetAlkMeq - alkMeq;
    const molesNeeded = (deltaAlkMeq * volumeL) / (2 * 1000); // 2 meq/mol
    const kgNeeded = round((molesNeeded * 74.093) / 1000, 2);
    const newPH = ph + 0.4; // Ca(OH)₂ pH degeri agresif yükseltir
    const outcome = assessAtPH(round(newPH, 2), targetAlk);

    recipes.push({
      id: 'caoh2',
      name: 'Kalsiyum Hidroksit — Ca(OH)₂',
      description: 'Güçlü baz — alkalinite ve pH agresif yükseltir. Ucuz ama pH spike riski yüksek.',
      difficulty: 4,
      automationLevel: 'manual',
      equipmentRequired: ['Ca(OH)₂ stoku', 'Koruyucu ekipman (eldiven, gözlük)', 'Yavaş karıştırıcı'],
      action: `${kgNeeded} kg Ca(OH)₂ YAVAŞÇA ekle. pH degeri sürekli izle — hedef: ${round(newPH, 1)}.`,
      predictedOutcome: outcome,
      risks: [
        'pH spike riski YÜKSEK — çok hızlı eklenirse balık stresi/ölümü',
        outcome.nh3Status === 'DANGER' ? '⚠️ pH artışı NH₃ toksisitesi yaratacak!' : '',
        'Cilde ve göze temas tehlikeli',
        'Çözünmeyen partiküller filtreleri tıkayabilir',
      ].filter(r => r.length > 0),
      applicable: true,
      insight: `Ca(OH)₂: ${kgNeeded} kg — güçlü etki ama RİSKLİ. ` +
        `pH spike'ı NH₃ toksisitesine yol açabilir. Sadece acil durumlarda tercih edin.`,
    });
  }

  // ── Reçete 6: HCl (Hidroklorik Asit) ──────────────────────────────
  {
    const newPH = ph - 0.3;
    const outcome = assessAtPH(round(newPH, 2));
    const h2sRisk = hasH2SRisk && outcome.h2sStatus?.includes('DANGER');

    recipes.push({
      id: 'hcl',
      name: 'Hidroklorik Asit (HCl)',
      description: 'pH düşürme — etkili ama TEHLİKELİ. Alkalinite de düşer. Son çare olarak kullanılır.',
      difficulty: 5,
      automationLevel: 'manual',
      equipmentRequired: ['HCl çözeltisi', 'Asit dayanımlı eldiven/gözlük', 'pH metre', 'Nötralizasyon malzemesi'],
      action: `HCl ile pH degeri ${round(newPH, 1)}'e düşür. YAVAŞ ekle, sürekli pH izle.`,
      predictedOutcome: outcome,
      risks: [
        ...(h2sRisk ? ['⚠️ KRİTİK: pH düşürme H₂S seviyesini artırır — ANİ ÖLÜM RİSKİ!'] : []),
        'Asit yanığı tehlikesi — koruyucu ekipman ZORUNLU',
        'Alkaliniteyi düşürür — tampon kapasitesi azalır',
        'Aşırı dozda pH çöküşü',
      ],
      applicable: needsLowerPH && !h2sRisk,
      notApplicableReason: h2sRisk
        ? 'H₂S riski nedeniyle pH düşürmek ANİ ÖLÜM RİSKİ yaratır'
        : !needsLowerPH
          ? 'pH düşürmeye gerek yok'
          : undefined,
      insight: h2sRisk
        ? '⛔ HCl KULLANILMAMALI — pH düşüşü H₂S toksisitesini artırır, ANİ ÖLÜM RİSKİ!'
        : `HCl: pH ${ph} → ~${round(newPH, 1)}. Son çare — sadece başka seçenek yoksa.`,
    });
  }

  // ── Reçeteleri sırala: zorluk + uygulanabilirlik ───────────────────
  recipes.sort((a, b) => {
    // Önce uygulanabilir olanlar
    if (a.applicable && !b.applicable) return -1;
    if (!a.applicable && b.applicable) return 1;
    // Sonra zorluk derecesi
    return a.difficulty - b.difficulty;
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. GENEL İÇGÖRÜ (INSIGHT)
  // ──────────────────────────────────────────────────────────────────────

  const insightParts: string[] = [];

  // Mevcut durum özeti
  const statusIcons = [];
  if (nh3Exceeds) statusIcons.push('NH₃ ⚠️');
  if (h2sExceeds) statusIcons.push('H₂S ⛔');
  if (co2Exceeds) statusIcons.push('CO₂ ⚠️');
  if (statusIcons.length === 0) statusIcons.push('✅ Tüm parametreler güvenli');
  insightParts.push(`Mevcut durum: ${statusIcons.join(', ')}.`);

  // Güvenli pH aralığı
  if (safePHRange) {
    insightParts.push(`Güvenli pH aralığı: ${safePHRange.min} — ${safePHRange.max} (genişlik: ${safePHRange.width}).`);
    if (ph < safePHRange.min || ph > safePHRange.max) {
      insightParts.push(`Mevcut pH (${ph}) güvenli aralığın DIŞINDA!`);
    }
  } else {
    insightParts.push('GÜVENLİ pH ARALIĞI YOK — TAN veya sülfid seviyesi çok yüksek, kısıtlar çelişiyor!');
  }

  // Biyofiltre
  if (biofilterAlkConsumption) {
    insightParts.push(biofilterAlkConsumption.insight);
  }

  // Önerilen ilk reçete
  const bestRecipe = recipes.find(r => r.applicable);
  if (bestRecipe) {
    insightParts.push(`Önerilen: ${bestRecipe.name} (zorluk: ${bestRecipe.difficulty}/5). ${bestRecipe.action}`);
  }

  // H₂S uyarısı
  if (hasH2SRisk) {
    insightParts.push('DİKKAT: Sülfid mevcut — pH düşüren işlemler H₂S toksisitesini artırır. ANİ ÖLÜM RİSKİ!');
  }

  const insight = insightParts.join(' ');

  // ──────────────────────────────────────────────────────────────────────
  // 6. ÇIKTI
  // ──────────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────────
  // 6. DEFFEYES DİYAGRAMI — GÜVENLİ BÖLGE + OTOMATİK REÇETE
  //
  // Deffeyes diyagramı ALK (meq/L) vs DIC (mmol/L) 2D uzayında çalışır.
  // Her pH değeri bir doğru (isoline) oluşturur.
  // Toksik bölgeler (NH₃, CO₂) bu uzayda sınırlar çizer.
  // Güvenli bölge = tüm kısıtların kesişim alanı.
  //
  // Mevcut konum → hedef nokta (güvenli bölgenin merkezi)
  // calculateDosingRecipes() fonksiyonu mevcut reagentlerle
  // hedefe ulaşmak için 2-reagent kombinasyonları hesaplar.
  //
  // Bu, tam Deffeyes geometrik hesabıdır — R CarbCalc portudur.
  // ──────────────────────────────────────────────────────────────────────

  let deffeyesAnalysis: DeffeyesAnalysis | null = null;

  try {
    // Mevcut reagentleri REAGENTS listesinden bul
    const validReagents = REAGENTS.filter(r =>
      availableReagents.some(name =>
        r.name.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(r.name.toLowerCase())
      )
    );
    const alkIncreasingReagents = validReagents.filter(r =>
      r.meqPerMol > 0 && r.radians > 0 && r.radians < Math.PI
    );

    // Mevcut konum Deffeyes uzayında: (DIC mmol/L, ALK meq/L)
    const currentPoint = calcOperatingPoint(ph, alkMeq, T, S);

    // Güvenli bölge hesabı — NH₃ ve CO₂ kısıtlarının kesişimi
    const alkMinMeq = alkMgToMeq(minAlkalinityMgL2 || 40);
    const alkMaxMeq = alkMgToMeq(200);
    const safeZone = generateSafeZone(T, S, tan, nh3LimitMgL, co2CriticalMgL, alkMinMeq, alkMaxMeq);

    // Mevcut konum güvenli bölge içinde mi?
    let isInsideSafeZone = false;
    let targetPointResult: { DIC: number; ALK: number } | null = null;

    if (safeZone) {
      // Basit sınır kontrolü: ALK ve DIC güvenli bölge köşeleri arasında mı?
      const minALK = Math.min(safeZone.bottomLeft.ALK, safeZone.bottomRight.ALK);
      const maxALK = Math.max(safeZone.topLeft.ALK, safeZone.topRight.ALK);
      const minDIC = Math.min(safeZone.topLeft.DIC, safeZone.bottomLeft.DIC);
      const maxDIC = Math.max(safeZone.topRight.DIC, safeZone.bottomRight.DIC);

      isInsideSafeZone = currentPoint.ALK >= minALK && currentPoint.ALK <= maxALK
        && currentPoint.DIC >= minDIC && currentPoint.DIC <= maxDIC;

      if (!isInsideSafeZone) {
        // Hedef nokta: güvenli bölgenin merkezi
        const targetAlkMeq = (minALK + maxALK) / 2;
        const targetDIC = (minDIC + maxDIC) / 2;
        // Hedef pH'ı bul
        let targetPHcalc = targetPH;
        try {
          // DIC ve ALK'dan pH hesapla (iterasyon)
          for (let testPH = 6.0; testPH <= 9.0; testPH += 0.01) {
            const testAlk = calcAlkOfDicPh(targetDIC, testPH, T, S);
            if (Math.abs(testAlk - targetAlkMeq) < 0.01) {
              targetPHcalc = round(testPH, 2);
              break;
            }
          }
        } catch { /* pH tahmini başarısız — varsayılan hedef kullan */ }
        targetPointResult = calcTargetPoint(targetPHcalc, targetAlkMeq, T, S);
      }
    }

    // Otomatik reçete hesabı — mevcut reagentlerle hedefe ulaşma
    const dosingRecipes: DeffeyesDosingRecipe[] = [];

    if (targetPointResult && !isInsideSafeZone) {
      // Mevcut reagent isimlerini bul
      const reagentNames = validReagents.length > 0
        ? validReagents.map(r => r.name)
        : ['Sodium Bicarbonate']; // Varsayılan

      // CO₂ hattı varsa CO₂ reagent'ı ekle
      if (hasCO2Line && !reagentNames.includes('Add CO₂')) {
        reagentNames.push('Add CO₂');
      }
      // Degassing varsa De-gas CO₂ ekle
      if (hasDegassing && !reagentNames.includes('De-gas CO₂')) {
        reagentNames.push('De-gas CO₂');
      }

      // ── İnline Deffeyes reçete hesabı ──────────────────────────
      // Her reagent, Deffeyes diyagramında belirli bir vektör yönünde hareket eder:
      //   NaHCO₃: slope=1 (DIC ve ALK eşit artar, 45°)
      //   Na₂CO₃: slope=2 (ALK, DIC'in 2 katı artar)
      //   NaOH/Ca(OH)₂: dikey (sadece ALK artar, DIC sabit)
      //   CO₂: yatay (sadece DIC artar, ALK sabit)
      //   De-gas CO₂: yatay ters (DIC azalır, ALK sabit)
      //   HCl: dikey aşağı (ALK azalır, DIC sabit)
      //
      // Tek-reagent çözüm: mevcut→hedef vektörü reagent vektörüne yansıt
      const deltaALK = targetPointResult.ALK - currentPoint.ALK;
      const deltaDIC = targetPointResult.DIC - currentPoint.DIC;

      for (const reagent of validReagents) {
        // Bu reagent ile hedefe ulaşılabilir mi?
        let neededMmol = 0; // mmol/L birim
        let feasible = true;

        if (!isFinite(reagent.slope)) {
          // Dikey reagent (NaOH, Ca(OH)₂, HCl) — sadece ALK değiştirir
          if (Math.abs(deltaDIC) > 0.1) {
            feasible = false; // DIC değişimi gerekli ama bu reagent yapamaz
          } else {
            neededMmol = deltaALK / reagent.meqPerMol; // meq/L / (meq/mmol) = mmol/L
          }
        } else if (reagent.slope === 0) {
          // Yatay reagent (CO₂, De-gas) — sadece DIC değiştirir
          if (Math.abs(deltaALK) > 0.05) {
            feasible = false;
          } else {
            neededMmol = deltaDIC; // mmol/L
            if (reagent.radians > Math.PI / 2) neededMmol = -neededMmol; // De-gas: DIC azaltır
          }
        } else {
          // Diagonal (NaHCO₃, Na₂CO₃) — hem DIC hem ALK değiştirir
          // DIC değişimi = neededMmol, ALK değişimi = neededMmol × slope
          neededMmol = deltaDIC; // DIC bazlı
          const expectedALK = neededMmol * reagent.slope;
          // ALK uyumu kontrolü — %20 tolerans
          if (Math.abs(deltaALK) > 0.01 && Math.abs(expectedALK - deltaALK) / Math.abs(deltaALK) > 0.3) {
            feasible = false; // Tek reagent yetmez, 2-reagent kombinasyonu gerekli
          }
        }

        if (neededMmol < 0) feasible = false; // Negatif miktar — bu reagent ters yöne gider

        if (feasible || Math.abs(neededMmol) > 0.001) {
          // mmol/L → kg dönüşümü
          const totalMmol = neededMmol * tankVolumeM3 * 1000; // mmol/L × L
          const totalMol = totalMmol / 1000;
          const kgNeeded = Math.abs(totalMol * reagent.mw / 1000);

          // Sonuç pH ve CO₂ tahmini
          const newAlkMeq = currentPoint.ALK + (isFinite(reagent.slope) && reagent.slope !== 0
            ? neededMmol * reagent.slope
            : (reagent.radians === Math.PI / 2 ? neededMmol * reagent.meqPerMol : 0));
          const newDIC = currentPoint.DIC + (reagent.slope === 0 || !isFinite(reagent.slope)
            ? (reagent.slope === 0 ? (reagent.radians < Math.PI / 2 ? neededMmol : -neededMmol) : 0)
            : neededMmol);

          let finalPH = ph;
          let finalCO2 = 0;
          try {
            for (let testPH = 5.0; testPH <= 10.0; testPH += 0.01) {
              const testAlk = calcAlkOfDicPh(Math.max(0.01, newDIC), testPH, T, S);
              if (Math.abs(testAlk - Math.max(0, newAlkMeq)) < 0.01) {
                finalPH = round(testPH, 2);
                break;
              }
            }
            finalCO2 = co2Level(Math.max(0, newAlkMeq), finalPH, T, S);
          } catch { /* fallback */ }

          dosingRecipes.push({
            steps: [{
              reagentName: reagent.name,
              formula: reagent.formula,
              amountKg: round(kgNeeded, 3),
            }],
            finalPH,
            finalCO2mgL: round(finalCO2, 2),
            feasible: feasible && kgNeeded > 0,
          });
        }
      }

      // CO₂ + NaHCO₃ kombinasyonu (en yaygın 2-reagent çözüm)
      if (hasCO2Line && alkIncreasingReagents.length > 0) {
        const baseReagent = alkIncreasingReagents[0]!;
        // Adım 1: NaHCO₃ ile ALK artır (DIC de artar)
        // Adım 2: CO₂ ile DIC'i hedefe ayarla
        const alkNeededMeq = deltaALK;
        const step1Mmol = baseReagent.slope > 0 ? alkNeededMeq / baseReagent.slope : alkNeededMeq / baseReagent.meqPerMol;
        const step1DICchange = baseReagent.slope > 0 && isFinite(baseReagent.slope) ? step1Mmol : 0;
        const remainingDIC = deltaDIC - step1DICchange;

        if (step1Mmol > 0) {
          const step1Kg = round(Math.abs(step1Mmol * tankVolumeM3) * baseReagent.mw / 1000, 3);
          const step2Kg = round(Math.abs(remainingDIC * tankVolumeM3) * 44.010 / 1000, 3);

          let finalPH = ph;
          let finalCO2 = 0;
          try {
            const newAlk = currentPoint.ALK + alkNeededMeq;
            const newDIC = currentPoint.DIC + deltaDIC;
            for (let testPH = 5.0; testPH <= 10.0; testPH += 0.01) {
              const testAlk = calcAlkOfDicPh(Math.max(0.01, newDIC), testPH, T, S);
              if (Math.abs(testAlk - Math.max(0, newAlk)) < 0.01) {
                finalPH = round(testPH, 2);
                break;
              }
            }
            finalCO2 = co2Level(Math.max(0, newAlk), finalPH, T, S);
          } catch { /* fallback */ }

          dosingRecipes.push({
            steps: [
              { reagentName: baseReagent.name, formula: baseReagent.formula, amountKg: step1Kg },
              ...(remainingDIC > 0.01 ? [{ reagentName: 'CO₂ Dozlama', formula: 'CO₂', amountKg: step2Kg }] : []),
              ...(remainingDIC < -0.01 ? [{ reagentName: 'Degassing', formula: '-CO₂', amountKg: round(Math.abs(remainingDIC * tankVolumeM3) * 44.010 / 1000, 3) }] : []),
            ],
            finalPH,
            finalCO2mgL: round(finalCO2, 2),
            feasible: true,
          });
        }
      }
    }

    // Deffeyes insight
    const deffeyesInsightParts: string[] = [];
    deffeyesInsightParts.push(`Deffeyes: mevcut konum DIC=${round(currentPoint.DIC, 2)} mmol/L, ALK=${round(currentPoint.ALK, 2)} meq/L.`);
    if (safeZone) {
      deffeyesInsightParts.push(`Guvenli bolge: ALK ${round(safeZone.bottomLeft.ALK, 2)}–${round(safeZone.topLeft.ALK, 2)} meq/L.`);
      deffeyesInsightParts.push(isInsideSafeZone ? 'Mevcut konum guvenli bolgede.' : 'Mevcut konum guvenli bolge DISINDA!');
    } else {
      deffeyesInsightParts.push('Guvenli bolge hesaplanamadi — TAN veya CO₂ kisitlari celiski yaratıyor.');
    }
    if (dosingRecipes.length > 0) {
      const best = dosingRecipes.find(r => r.feasible);
      if (best) {
        const stepsDesc = best.steps.map(s => `${s.amountKg} kg ${s.formula}`).join(' + ');
        deffeyesInsightParts.push(`Onerilen recete: ${stepsDesc} → pH ${best.finalPH}, CO₂ ${best.finalCO2mgL} mg/L.`);
      }
    }

    deffeyesAnalysis = {
      currentPoint: { DIC: round(currentPoint.DIC, 4), ALK: round(currentPoint.ALK, 4) },
      safeZone: safeZone ? {
        topLeft: { DIC: round(safeZone.topLeft.DIC, 4), ALK: round(safeZone.topLeft.ALK, 4) },
        topRight: { DIC: round(safeZone.topRight.DIC, 4), ALK: round(safeZone.topRight.ALK, 4) },
        bottomLeft: { DIC: round(safeZone.bottomLeft.DIC, 4), ALK: round(safeZone.bottomLeft.ALK, 4) },
        bottomRight: { DIC: round(safeZone.bottomRight.DIC, 4), ALK: round(safeZone.bottomRight.ALK, 4) },
      } : null,
      targetPoint: targetPointResult ? { DIC: round(targetPointResult.DIC, 4), ALK: round(targetPointResult.ALK, 4) } : null,
      isInsideSafeZone,
      dosingRecipes,
      insight: deffeyesInsightParts.join(' '),
    };

    // Ana insight'a Deffeyes bilgisini ekle
    if (!isInsideSafeZone && dosingRecipes.length > 0) {
      const best = dosingRecipes.find(r => r.feasible);
      if (best) {
        const stepsDesc = best.steps.map(s => `${s.amountKg} kg ${s.formula}`).join(' + ');
        insightParts.push(`Deffeyes recete: ${stepsDesc} → pH ${best.finalPH}.`);
      }
    }
  } catch (deffeyesError) {
    // Deffeyes hesabı başarısız — hatayı loglayıp devam et
    const errMsg = deffeyesError instanceof Error ? deffeyesError.message : String(deffeyesError);
    insightParts.push(`Deffeyes hesabi basarisiz: ${errMsg}`);
    deffeyesAnalysis = null;
  }

  // ──────────────────────────────────────────────────────────────────────
  // 7. ÇIKTI
  // ──────────────────────────────────────────────────────────────────────

  const result = {
    insight: insightParts.join(' '),
    currentStatus: {
      ph,
      temperature: T,
      salinity: S,
      alkalinityMgL: alkalinity,
      tanMgL: tan,
      nh3MgL: round(currentNH3, 4),
      nh3Status: nh3Exceeds ? 'DANGER' : 'SAFE',
      h2sMeasuredUgL: input.h2sMeasured ?? null,
      totalSulfideUgL: hasH2SRisk ? round(totalSulfide, 2) : null,
      h2sUgL: hasH2SRisk ? round(currentH2S, 4) : null,
      h2sStatus: hasH2SRisk ? (h2sExceeds ? 'DANGER' : 'SAFE') : null,
      co2MgL: round(currentCO2, 2),
      co2Status: co2Exceeds ? 'DANGER' : 'SAFE',
    },
    safePHRange: safePHRange ?? {
      min: null,
      max: null,
      width: 0,
      warning: 'Güvenli pH aralığı hesaplanamadı — kısıtlar çelişiyor',
    },
    limitingFactors,
    targetPH,
    biofilterAlkConsumption,
    recipes: recipes.map(r => ({
      ...r,
      riskLevel: r.risks.some(risk => risk.includes('ANI OLUM'))
        ? 'CRITICAL'
        : r.risks.some(risk => risk.includes('DANGER') || risk.includes('spike'))
          ? 'HIGH'
          : r.risks.length > 0 ? 'MEDIUM' : 'LOW',
    })),
    deffeyesAnalysis,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}
