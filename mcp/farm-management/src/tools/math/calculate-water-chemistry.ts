// ============================================================================
// MCP Farm Intelligence — Su Kimyası Hesaplama Aracı
// ============================================================================
//
// @platform/aquaculture-engines kütüphanesini MCP aracı olarak sarar.
// 6 farklı hesaplama modu sunar:
//
//   1. ammonia_toxicity    → NH3/NH4 dengesi, toksik eşikler, güvenli TAN
//   2. carbonate_chemistry → DIC, karbonat fraksiyonları, tampon kapasitesi
//   3. co2_level           → CO2 konsantrasyonu, kritik pH
//   4. h2s_toxicity        → H2S toksisitesi, kritik pH
//   5. reagent_dosing      → Kimyasal dozlama hesabı (alkalinitede değişim)
//   6. dosing_simulation   → Belirli miktarda kimyasal eklemenin etkisi
//
// TERMODİNAMİK TEMEL:
//   Tüm hesaplamalar Millero (1995, 2010) ayrışma sabitlerini kullanır.
//   pH ölçeği dönüşümleri: NBS → Free (proton aktivite katsayısı ile)
//   Tuzluluk düzeltmeleri: iyonik güç, sülfat, florit, borat katkıları
//
// REFERANSLAR:
//   - Millero (2010) — Karbonat sistemi ayrışma sabitleri
//   - Millero (1995) — NH4 ve H2S ayrışma sabitleri
//   - Weiss (1974) — CO2 çözünürlüğü
//   - Dickson (1990) — Borat ve bisülfat sabitleri
//   - Mucci (1983) — Kalsit/aragonit doygunluk çarpımları
//
// SAF HESAPLAMA — GraphQL çağrısı veya yan etki YOKTUR.
// ============================================================================

import { z } from 'zod';
import { round } from '../../utils/formatters.js';
import {
  fractionNH3,
  calcNH3,
  calcNH4,
  criticalPHforNH3,
  calcSafeTAN,
  uiaStatus,
  fractionH2S,
  calcH2S,
  criticalPHforH2S,
  co2Level,
  criticalPHforCO2,
  calcDicOfAlk,
  calcAlkOfDicPh,
  calcPhForAlkDic,
  REAGENTS,
  alkMgToMeq,
  alkMeqToMg,
  calcForwardDosing,
} from '@platform/aquaculture-engines';

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================
//
// Discriminated union: `calculation` alanına göre `params` farklı yapıda olmalıdır.
// Zod ile esnek bir yapı kullanıyoruz — her mod kendi parametre doğrulamasını yapar.
// ============================================================================

export const inputSchema = z.object({
  calculation: z.enum([
    'ammonia_toxicity',
    'carbonate_chemistry',
    'co2_level',
    'h2s_toxicity',
    'reagent_dosing',
    'dosing_simulation',
  ]).describe('Hesaplama modu'),

  params: z.record(z.string(), z.unknown())
    .describe('Hesaplama moduna özel parametreler'),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'calculate_water_chemistry',
  description:
    'Su kimyası hesaplayıcısı: amonyak toksisitesi, karbonat dengesi, CO2 seviyesi, ' +
    'H2S toksisitesi, kimyasal dozlama ve dozlama simülasyonu. ' +
    '@platform/aquaculture-engines kütüphanesini kullanır.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      calculation: {
        type: 'string',
        enum: [
          'ammonia_toxicity',
          'carbonate_chemistry',
          'co2_level',
          'h2s_toxicity',
          'reagent_dosing',
          'dosing_simulation',
        ],
        description: 'Hesaplama modu',
      },
      params: {
        type: 'object',
        description:
          'Hesaplama moduna özel parametreler. ' +
          'ammonia_toxicity: { tan, ph, temperature, salinity? }. ' +
          'carbonate_chemistry: { alkalinity, ph, temperature, salinity? }. ' +
          'co2_level: { alkalinity, ph, temperature, salinity? }. ' +
          'h2s_toxicity: { totalSulfide, ph, temperature, salinity? }. ' +
          'reagent_dosing: { currentAlk, currentPH, targetAlk, targetPH, volumeM3 }. ' +
          'dosing_simulation: { currentAlk, currentPH, volumeM3, reagentName, doseKg }.',
      },
    },
    required: ['calculation', 'params'],
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

  switch (input.calculation) {
    case 'ammonia_toxicity':
      return handleAmmoniaToxicity(input.params);
    case 'carbonate_chemistry':
      return handleCarbonateChemistry(input.params);
    case 'co2_level':
      return handleCO2Level(input.params);
    case 'h2s_toxicity':
      return handleH2SToxicity(input.params);
    case 'reagent_dosing':
      return handleReagentDosing(input.params);
    case 'dosing_simulation':
      return handleDosingSimulation(input.params);
    default:
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Bilinmeyen hesaplama modu: ${input.calculation}`,
            validModes: [
              'ammonia_toxicity', 'carbonate_chemistry', 'co2_level',
              'h2s_toxicity', 'reagent_dosing', 'dosing_simulation',
            ],
          }),
        }],
      };
  }
}

// ============================================================================
// MOD 1: AMONYAK TOKSİSİTESİ
// ============================================================================
//
// NH4+ ⇌ NH3 + H+ dengesi üzerinden toksik NH3 hesabı.
//
// TEORİ:
//   TAN (Total Ammonia Nitrogen) = NH3-N + NH4+-N
//   NH3 fraksiyonu pH ve sıcaklıkla ARTAR (baz ortamda daha toksik)
//   NH4+ (iyonize form) nispeten zararsızdır
//   NH3 (iyonize olmamış form) hücre zarlarından geçer → toksik
//
// HESAPLAR:
//   - fractionNH3: KNH4 / (KNH4 + [H+]) — Millero sabitleri
//   - calcNH3: TAN × fraction → mg/L cinsinden NH3
//   - calcNH4: TAN × (1 - fraction) → mg/L cinsinden NH4+
//   - criticalPH: TAN × fraction(pH) = limit → pH'ı bul (bisection)
//   - calcSafeTAN: limit / fraction → mevcut koşullarda maksimum güvenli TAN
//   - uiaStatus: pH vs criticalPH → güvenlik durumu
//
// KAYNAK: Emerson et al. (1975), Millero (1995)
// ============================================================================

function handleAmmoniaToxicity(rawParams: Record<string, unknown>): ToolResult {
  // ── Parametre doğrulama ───────────────────────────────────────
  const schema = z.object({
    tan: z.number().min(0).describe('TAN konsantrasyonu (mg/L)'),
    ph: z.number().min(4).max(12).describe('pH (NBS ölçeği)'),
    temperature: z.number().min(0).max(45).describe('Sıcaklık (°C)'),
    salinity: z.number().min(0).max(45).default(0).describe('Tuzluluk (ppt)'),
    nh3Limit: z.number().positive().default(0.02).describe('NH3 güvenli sınır (mg/L)'),
  });

  const p = schema.parse(rawParams);

  // ── NH3 Fraksiyonu ────────────────────────────────────────────
  //
  // fractionNH3(pHnbs, tempC, S):
  //   1. pH'ı NBS'den Free ölçeğine çevirir (proton aktivite katsayısı)
  //   2. KNH4 sabitini SWS ölçeğinden Free'ye çevirir
  //   3. f = KNH4_free / (KNH4_free + [H+]_free)
  //
  // [H+] = 10^(-pH_free)
  //
  // KNH4 (Millero 1995):
  //   ln(KNH4) = -6285.33/T + 0.0001635T - 0.25444
  //            + (0.46532 - 123.7184/T)√S + (-0.01992 + 3.17556/T)S
  //
  const fraction = fractionNH3(p.ph, p.temperature, p.salinity);
  const fractionPercent = fraction * 100;

  // ── NH3 ve NH4+ Konsantrasyonları ─────────────────────────────
  //
  // NH3 = TAN × fraction (toksik form)
  // NH4+ = TAN × (1 - fraction) (iyonize form, zararsız)
  //
  const nh3 = calcNH3(p.tan, p.ph, p.temperature, p.salinity);
  const nh4 = calcNH4(p.tan, p.ph, p.temperature, p.salinity);

  // ── Kritik pH ─────────────────────────────────────────────────
  //
  // criticalPHforNH3(tan, nh3Limit, tempC, S):
  //   Mevcut TAN seviyesinde NH3'ün toksik limite ulaştığı pH değeri.
  //   Bisection yöntemiyle [4, 12] aralığında aranır.
  //
  //   Bu pH'ın ALTINDA kalmak güvenlidir.
  //   Bu pH'ın ÜSTÜNE çıkılırsa NH3 > limit → tehlike!
  //
  const criticalPH = criticalPHforNH3(p.tan, p.nh3Limit, p.temperature, p.salinity);

  // ── Güvenli TAN ───────────────────────────────────────────────
  //
  // calcSafeTAN(pH, nh3Limit, tempC, S):
  //   Mevcut pH/sıcaklık/tuzlulukta NH3'ün limiti aşmaması için
  //   maksimum izin verilen TAN konsantrasyonu.
  //
  //   safeTAN = nh3Limit / fraction
  //
  //   Örnek: pH=7.5, T=20°C, S=0 → fraction ≈ 0.005
  //          safeTAN = 0.02 / 0.005 = 4.0 mg/L
  //
  const safeTAN = calcSafeTAN(p.ph, p.nh3Limit, p.temperature, p.salinity);

  // ── Güvenlik Durumu ───────────────────────────────────────────
  //
  // uiaStatus(currentPH, criticalPH):
  //   'safe'   → pH, kritik pH'dan >0.2 birim uzakta
  //   'alert'  → pH, kritik pH'ya 0.2 birim içinde yaklaşmış
  //   'danger' → pH ≥ criticalPH → NH3 limiti aşılmış
  //
  const status = uiaStatus(p.ph, criticalPH);

  // ── Güvenlik Marjı ────────────────────────────────────────────
  const safetyMarginPH = isNaN(criticalPH) ? null : round(criticalPH - p.ph, 4);

  const result = {
    calculation: 'ammonia_toxicity',
    input: { tan: p.tan, ph: p.ph, temperature: p.temperature, salinity: p.salinity },
    results: {
      nh3MgL: round(nh3, 6),
      nh4MgL: round(nh4, 4),
      nh3FractionPercent: round(fractionPercent, 4),
      nh3Fraction: round(fraction, 8),
      criticalPH: isNaN(criticalPH) ? null : round(criticalPH, 4),
      safetyMarginPH,
      safeTANmgL: isFinite(safeTAN) ? round(safeTAN, 4) : null,
      nh3LimitMgL: p.nh3Limit,
      exceedsLimit: nh3 > p.nh3Limit,
      status,
    },
    explanation:
      `TAN=${p.tan} mg/L, pH=${p.ph}, T=${p.temperature}°C, S=${p.salinity} ppt koşullarında: ` +
      `NH3=${round(nh3, 4)} mg/L (%${round(fractionPercent, 2)} toksik form), ` +
      `NH4+=${round(nh4, 4)} mg/L. ` +
      `${isNaN(criticalPH)
        ? 'TAN seviyesi düşük — kritik pH ulaşılamaz.'
        : `Kritik pH: ${round(criticalPH, 2)} (marj: ${round(safetyMarginPH!, 2)} birim). `}` +
      `Durum: ${status}. Güvenli TAN: ${isFinite(safeTAN) ? round(safeTAN, 2) : '∞'} mg/L.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ============================================================================
// MOD 2: KARBONAT KİMYASI
// ============================================================================
//
// Karbonat sistemi: CO2 ⇌ HCO3- ⇌ CO3²⁻ dengesi.
//
// TEORİ:
//   DIC (Dissolved Inorganic Carbon) = [CO2] + [HCO3-] + [CO3²-]
//   ALK (Alkalinite) ≈ [HCO3-] + 2[CO3²-] + [B(OH)4-] + [OH-] - [H+]
//
//   Deffeyes diyagramında (DIC vs ALK) her pH değeri bir doğruya karşılık gelir.
//   Eğim: alpha1 + 2×alpha2 (karbonat fraksiyonları)
//   Kesişim: [OH-] - [H+] + [B(OH)4-] (borat dahil)
//
// HESAPLAR:
//   - DIC: calcDicOfAlk(alkMeq, pH, T, S) — alkalinite ve pH'dan DIC hesabı
//   - Fraksiyonlar: alpha0 (CO2), alpha1 (HCO3-), alpha2 (CO3²-)
//   - CO2: co2Level(alkMeq, pH, T, S) — mg/L cinsinden CO2
//
// KAYNAK: Millero (2010), Zeebe & Wolf-Gladrow (2001)
// ============================================================================

function handleCarbonateChemistry(rawParams: Record<string, unknown>): ToolResult {
  const schema = z.object({
    alkalinity: z.number().min(0).describe('Alkalinite (mg/L CaCO3)'),
    ph: z.number().min(4).max(12).describe('pH (NBS ölçeği)'),
    temperature: z.number().min(0).max(45).describe('Sıcaklık (°C)'),
    salinity: z.number().min(0).max(45).default(0).describe('Tuzluluk (ppt)'),
  });

  const p = schema.parse(rawParams);

  // ── Birim Dönüşümü ────────────────────────────────────────────
  //
  // Alkalinite girdisi mg/L CaCO3 cinsindendir (endüstri standardı).
  // Termodinamik hesaplar meq/L gerektirir.
  //
  // DÖNÜŞÜM: 1 meq/L = 50.04345 mg/L CaCO3
  //   alkMeq = alkMg / 50.04345
  //
  // CaCO3 eşdeğeri: CaCO3 → Ca²+ + CO3²-
  //   MW(CaCO3) = 100.087 g/mol
  //   2 eşdeğer/mol → eşdeğer ağırlık = 50.04345 g/eq
  //
  const alkMeq = alkMgToMeq(p.alkalinity);

  // ── DIC Hesabı ────────────────────────────────────────────────
  //
  // calcDicOfAlk(alkMeq, pHnbs, tempC, S):
  //   DIC = (ALK - intercept) / slope
  //   slope = alpha1 + 2×alpha2 (Deffeyes diyagramı eğimi)
  //   intercept = [OH-] - [H+] + [B(OH)4-] (meq/L cinsinden)
  //
  //   Alpha fraksiyonları Free pH ölçeğinde hesaplanır.
  //
  const dicMM = calcDicOfAlk(alkMeq, p.ph, p.temperature, p.salinity);

  // ── CO2 Seviyesi ──────────────────────────────────────────────
  //
  // co2Level(alkMeq, pHnbs, tempC, S):
  //   1. DIC'i hesapla (calcDicOfAlk)
  //   2. CO2_mm = DIC × alpha0 (CO2 fraksiyonu)
  //   3. CO2_mg = CO2_mm × 44.0096 (mmol/L → mg/L)
  //
  const co2MgL = co2Level(alkMeq, p.ph, p.temperature, p.salinity);

  // ── HCO3- ve CO3²- Fraksiyonları ─────────────────────────────
  //
  // Karbonat sistemi üç form arasında dağılır:
  //   CO2 (H2CO3) → düşük pH'da baskın (<6.3)
  //   HCO3- → orta pH'da baskın (6.3-10.3)
  //   CO3²- → yüksek pH'da baskın (>10.3)
  //
  // DIC bilindiğinde her formun konsantrasyonu hesaplanabilir.
  // Ama alpha fraksiyonlarını doğrudan hesaplamak yerine
  // DIC'ten geri hesaplıyoruz:
  //   CO2_mm = co2Level / 44.0096 → CO2 fraksiyonu ≈ CO2_mm / DIC
  //
  const co2MM = dicMM > 0 ? co2MgL / 44.0096 : 0;
  const co2Fraction = dicMM > 0 ? co2MM / dicMM : 0;

  // ── Alkaliniteyi DIC ve pH'dan geri doğrulama ─────────────────
  //
  // calcAlkOfDicPh(dicMM, pHnbs, tempC, S):
  //   ALK = DIC × slope + intercept
  //   Bu, hesapladığımız DIC ile orijinal alkaliniteyi geri vermelidir.
  //
  const alkRecalcMeq = calcAlkOfDicPh(dicMM, p.ph, p.temperature, p.salinity);
  const alkRecalcMg = alkMeqToMg(alkRecalcMeq);

  // ── Tampon Kapasitesi Göstergesi ──────────────────────────────
  //
  // Alkalinite ne kadar yüksekse, su pH değişimlerine karşı
  // o kadar dirençlidir (tampon kapasitesi).
  //
  //   < 20 mg/L CaCO3  → çok düşük (pH çok oynak)
  //   20-75 mg/L        → düşük
  //   75-150 mg/L       → orta
  //   150-300 mg/L      → yüksek (iyi tamponlanmış)
  //   > 300 mg/L        → çok yüksek
  //
  let bufferCapacity: string;
  if (p.alkalinity < 20) {
    bufferCapacity = 'very_low';
  } else if (p.alkalinity < 75) {
    bufferCapacity = 'low';
  } else if (p.alkalinity < 150) {
    bufferCapacity = 'moderate';
  } else if (p.alkalinity < 300) {
    bufferCapacity = 'high';
  } else {
    bufferCapacity = 'very_high';
  }

  const result = {
    calculation: 'carbonate_chemistry',
    input: { alkalinityMgL: p.alkalinity, ph: p.ph, temperature: p.temperature, salinity: p.salinity },
    results: {
      alkalinityMeqL: round(alkMeq, 4),
      dicMmolL: round(dicMM, 4),
      co2MgL: round(co2MgL, 2),
      co2FractionPercent: round(co2Fraction * 100, 2),
      hco3FractionPercent: round((1 - co2Fraction - (dicMM > 0 ? 0 : 0)) * 100, 2), // basitleştirilmiş
      bufferCapacity,
      alkalinityRecalcMgL: round(alkRecalcMg, 2),
    },
    explanation:
      `Alk=${p.alkalinity} mg/L (${round(alkMeq, 3)} meq/L), pH=${p.ph}: ` +
      `DIC=${round(dicMM, 3)} mmol/L, CO2=${round(co2MgL, 2)} mg/L. ` +
      `Tampon kapasitesi: ${bufferCapacity}.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ============================================================================
// MOD 3: CO2 SEVİYESİ
// ============================================================================
//
// Suda çözünmüş CO2 konsantrasyonunu ve kritik pH eşiğini hesaplar.
//
// TEORİ:
//   CO2, suda karbonik asit (H2CO3) olarak çözünür.
//   Düşük pH → daha fazla CO2 (balıklar için zararlı)
//   Yüksek pH → daha az CO2 ama daha fazla NH3 (dengeli yönetim gerekli)
//
//   CO2 > 20-30 mg/L → çoğu balık türü için stres
//   CO2 > 60 mg/L → ciddi toksisite riski
//
// HESAPLAR:
//   - co2Level: alkalinite + pH → CO2 (mg/L)
//   - criticalPHforCO2: CO2'nin toksik limite ulaştığı pH (bisection)
//
// KAYNAK: Fivelstad et al. (2003), "Effects of carbon dioxide on Atlantic salmon"
// ============================================================================

function handleCO2Level(rawParams: Record<string, unknown>): ToolResult {
  const schema = z.object({
    alkalinity: z.number().min(0).describe('Alkalinite (mg/L CaCO3)'),
    ph: z.number().min(4).max(12).describe('pH (NBS ölçeği)'),
    temperature: z.number().min(0).max(45).describe('Sıcaklık (°C)'),
    salinity: z.number().min(0).max(45).default(0).describe('Tuzluluk (ppt)'),
    co2CriticalMgL: z.number().positive().default(20).describe('Kritik CO2 seviyesi (mg/L)'),
  });

  const p = schema.parse(rawParams);
  const alkMeq = alkMgToMeq(p.alkalinity);

  // ── CO2 Seviyesi ──────────────────────────────────────────────
  //
  // co2Level(alkMeq, pHnbs, tempC, S):
  //   DIC hesapla → CO2 = DIC × alpha0 → mg/L'ye çevir
  //
  const co2MgL = co2Level(alkMeq, p.ph, p.temperature, p.salinity);

  // ── Kritik pH ─────────────────────────────────────────────────
  //
  // criticalPHforCO2(alkMeq, co2CritMg, tempC, S):
  //   Sabit alkalinite boyunca pH düştükçe CO2 artar.
  //   Bisection ile CO2 = criticalLevel olan pH bulunur.
  //
  //   Bu pH'ın ÜSTÜNDE kalmak güvenlidir (CO2 < limit).
  //   Bu pH'ın ALTINA düşülürse CO2 > limit → tehlike!
  //
  //   NOT: NH3'ün tersi — CO2 düşük pH'da tehlikeli, NH3 yüksek pH'da.
  //
  const critPH = criticalPHforCO2(alkMeq, p.co2CriticalMgL, p.temperature, p.salinity);

  // ── Durum Değerlendirmesi ─────────────────────────────────────
  let co2Status: string;
  if (co2MgL < p.co2CriticalMgL * 0.5) {
    co2Status = 'safe';       // Güvenli — limitin yarısından az
  } else if (co2MgL < p.co2CriticalMgL) {
    co2Status = 'alert';      // Dikkat — limite yaklaşıyor
  } else {
    co2Status = 'danger';     // Tehlikeli — limit aşılmış
  }

  // ── pH Güvenlik Marjı ─────────────────────────────────────────
  // CO2 için: currentPH - criticalPH > 0 ise güvenli
  // (pH ne kadar yüksekse CO2 o kadar düşük)
  const safetyMarginPH = isNaN(critPH) ? null : round(p.ph - critPH, 4);

  const result = {
    calculation: 'co2_level',
    input: { alkalinityMgL: p.alkalinity, ph: p.ph, temperature: p.temperature, salinity: p.salinity },
    results: {
      co2MgL: round(co2MgL, 2),
      co2CriticalMgL: p.co2CriticalMgL,
      exceedsLimit: co2MgL > p.co2CriticalMgL,
      criticalPH: isNaN(critPH) ? null : round(critPH, 4),
      safetyMarginPH,
      status: co2Status,
    },
    explanation:
      `Alk=${p.alkalinity} mg/L, pH=${p.ph}: CO2=${round(co2MgL, 2)} mg/L ` +
      `(limit: ${p.co2CriticalMgL} mg/L). ` +
      `${isNaN(critPH)
        ? 'Kritik pH hesaplanamadı.'
        : `pH ${round(critPH, 2)} altına düşerse CO2 limiti aşılır (marj: ${round(safetyMarginPH!, 2)} birim).`} ` +
      `Durum: ${co2Status}.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ============================================================================
// MOD 4: H2S TOKSİSİTESİ
// ============================================================================
//
// Hidrojen sülfür (H2S) toksisitesi ve kritik pH hesabı.
//
// TEORİ:
//   H2S ⇌ HS- + H+
//   H2S (iyonize olmamış form) → toksik (hücre zarlarından geçer)
//   HS- (iyonize form) → nispeten zararsız
//
//   NH3'ün TERSİ: H2S düşük pH'da daha toksik (NH3 yüksek pH'da)
//   pH düştükçe H2S fraksiyonu ARTAR
//
//   H2S > 2 µg/L → kronik toksisite başlangıcı (hassas türler)
//   H2S > 50 µg/L → ciddi toksisite (çoğu tür)
//
// KAYNAK: Millero (1995) — H2S ayrışma sabitleri
// ============================================================================

function handleH2SToxicity(rawParams: Record<string, unknown>): ToolResult {
  const schema = z.object({
    totalSulfide: z.number().min(0).describe('Toplam sülfid (µg/L)'),
    ph: z.number().min(4).max(12).describe('pH (NBS ölçeği)'),
    temperature: z.number().min(0).max(45).describe('Sıcaklık (°C)'),
    salinity: z.number().min(0).max(45).default(0).describe('Tuzluluk (ppt)'),
    h2sLimitUgL: z.number().positive().default(2).describe('H2S güvenli sınır (µg/L)'),
  });

  const p = schema.parse(rawParams);

  // ── H2S Fraksiyonu ────────────────────────────────────────────
  //
  // fractionH2S(pHnbs, tempC, S):
  //   KH2S sabitini Total ölçeğinden Free'ye çevirir
  //   f = [H+] / (KH2S + [H+])
  //
  //   Düşük pH → yüksek [H+] → yüksek H2S fraksiyonu
  //   Yüksek pH → düşük [H+] → düşük H2S fraksiyonu
  //
  const h2sFraction = fractionH2S(p.ph, p.temperature, p.salinity);

  // ── H2S Konsantrasyonu ────────────────────────────────────────
  //
  // calcH2S(totalSulfide, pHnbs, tempC, S):
  //   H2S = totalSulfide × fractionH2S
  //   Birim: µg/L (mikrogram / litre)
  //
  const h2sUgL = calcH2S(p.totalSulfide, p.ph, p.temperature, p.salinity);

  // ── Kritik pH ─────────────────────────────────────────────────
  //
  // criticalPHforH2S(h2sMeasured, h2sMeasuredAtPH, h2sLimit, tempC, S):
  //   1. Ölçülen H2S ve ölçüm pH'ından toplam sülfidi hesaplar
  //   2. Hedef fraksiyonu bulur: h2sLimit / totalSulfide
  //   3. Bisection ile pH bulur
  //
  //   Bu pH'ın ÜSTÜNDE kalmak güvenlidir.
  //   Bu pH'ın ALTINA düşülürse H2S > limit → tehlike!
  //
  const critPH = criticalPHforH2S(h2sUgL, p.ph, p.h2sLimitUgL, p.temperature, p.salinity);

  // ── Durum ─────────────────────────────────────────────────────
  let h2sStatusValue: string;
  if (isNaN(critPH)) {
    h2sStatusValue = 'safe';
  } else if (p.ph <= critPH) {
    h2sStatusValue = 'danger';
  } else if (p.ph <= critPH + 0.2) {
    h2sStatusValue = 'alert';
  } else {
    h2sStatusValue = 'safe';
  }

  const safetyMarginPH = isNaN(critPH) ? null : round(p.ph - critPH, 4);

  const result = {
    calculation: 'h2s_toxicity',
    input: { totalSulfideUgL: p.totalSulfide, ph: p.ph, temperature: p.temperature, salinity: p.salinity },
    results: {
      h2sUgL: round(h2sUgL, 4),
      h2sFractionPercent: round(h2sFraction * 100, 4),
      h2sLimitUgL: p.h2sLimitUgL,
      exceedsLimit: h2sUgL > p.h2sLimitUgL,
      criticalPH: isNaN(critPH) ? null : round(critPH, 4),
      safetyMarginPH,
      status: h2sStatusValue,
    },
    explanation:
      `Toplam sülfid=${p.totalSulfide} µg/L, pH=${p.ph}: ` +
      `H2S=${round(h2sUgL, 2)} µg/L (%${round(h2sFraction * 100, 2)} toksik form). ` +
      `${isNaN(critPH)
        ? 'Kritik pH hesaplanamadı (limit aşılamıyor).'
        : `pH ${round(critPH, 2)} altına düşerse H2S limiti (${p.h2sLimitUgL} µg/L) aşılır.`} ` +
      `Durum: ${h2sStatusValue}.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ============================================================================
// MOD 5: KİMYASAL DOZLAMA HESABI
// ============================================================================
//
// Mevcut su koşullarından hedef alkaliniteye ulaşmak için
// hangi kimyasaldan ne kadar gerektiğini hesaplar.
//
// BASİTLEŞTİRİLMİŞ YAKLAŞIM:
//   Tam Deffeyes diyagramı iki boyutlu (DIC + ALK) dosing gerektirir
//   ve iki kimyasal kombinasyonu ile çözülür (reagents.ts'deki algoritma).
//
//   Bu araçta basitleştirilmiş tek boyutlu (sadece ALK değişimi) hesap yaparız:
//     delta_alk = (hedefAlk - mevcutAlk) in meq/L
//     gerekli_mol = delta_alk × hacim_L / reagent.meqPerMol
//     gerekli_kg = gerekli_mol × reagent.mw / 1000
//
// MEVCUT KİMYASALLAR (REAGENTS dizisinden):
//   - Sodium Bicarbonate (NaHCO₃): 84.007 g/mol, 1 meq/mol
//   - Sodium Carbonate (Na₂CO₃): 105.988 g/mol, 2 meq/mol
//   - Sodium Hydroxide (NaOH): 39.997 g/mol, 1 meq/mol
//   - Calcium Carbonate (CaCO₃): 100.087 g/mol, 2 meq/mol
//   - Calcium Hydroxide (Ca(OH)₂): 74.093 g/mol, 2 meq/mol
//   - Calcium Oxide (CaO): 56.077 g/mol, 2 meq/mol
//   - Muriatic Acid (HCl): 36.461 g/mol, 1 meq/mol (alkalinite düşürme)
// ============================================================================

function handleReagentDosing(rawParams: Record<string, unknown>): ToolResult {
  const schema = z.object({
    currentAlk: z.number().min(0).describe('Mevcut alkalinite (mg/L CaCO3)'),
    currentPH: z.number().min(4).max(12).describe('Mevcut pH'),
    targetAlk: z.number().min(0).describe('Hedef alkalinite (mg/L CaCO3)'),
    targetPH: z.number().min(4).max(12).describe('Hedef pH'),
    volumeM3: z.number().positive().describe('Sistem hacmi (m³)'),
  });

  const p = schema.parse(rawParams);

  const currentAlkMeq = alkMgToMeq(p.currentAlk);
  const targetAlkMeq = alkMgToMeq(p.targetAlk);
  const deltaAlkMeq = targetAlkMeq - currentAlkMeq;
  const volumeL = p.volumeM3 * 1000;

  // ── Mevcut Kimyasallar Listesi ────────────────────────────────
  //
  // REAGENTS dizisinden alkalinite değiştirme kapasitesi olan
  // kimyasalları listeliyoruz. CO2 ekleme/çıkarma hariç
  // (onlar DIC değiştirir, ALK değil — slope=0).
  //
  const dosingOptions = REAGENTS
    .filter(r => r.meqPerMol > 0) // CO2/De-gas CO2 hariç (meqPerMol=0)
    .map(reagent => {
      // ── Her Kimyasal İçin Dozlama Hesabı ────────────────────
      //
      // FORMÜL:
      //   delta_alk (meq/L) → toplam gerekli meq = delta_alk × hacim_L
      //   gerekli_mol = toplam_meq / reagent.meqPerMol
      //   gerekli_gram = gerekli_mol × reagent.mw
      //   gerekli_kg = gerekli_gram / 1000
      //
      // NOT: Asit (HCl) alkalinite DÜŞÜRÜR → delta_alk negatif olmalıdır.
      //      Bazlar alkalinite ARTIRIR → delta_alk pozitif olmalıdır.
      //
      // HCl'nin radians'ı 3π/2 (aşağı yönlü) olduğundan,
      // negatif delta_alk için HCl uygun, pozitif için bazlar uygun.
      //
      const isAcid = reagent.radians > Math.PI; // HCl: 3π/2
      const applicableDirection = isAcid ? deltaAlkMeq < 0 : deltaAlkMeq > 0;

      if (!applicableDirection && Math.abs(deltaAlkMeq) > 0.001) {
        return null; // Bu kimyasal yanlış yöne gider
      }

      // totalMeqNeeded: mili-eşdeğer (meq) — meq/L × L = meq
      const totalMeqNeeded = Math.abs(deltaAlkMeq) * volumeL;
      // meq → mol dönüşümü: 1 meq = 0.001 eq, ve meqPerMol eq/mol
      // molesNeeded = totalMeqNeeded / (meqPerMol × 1000)
      // ÖRN: 69950 meq NaHCO₃ (1 meq/mmol) = 69950 mmol = 69.95 mol
      const molesNeeded = totalMeqNeeded / (reagent.meqPerMol * 1000);
      const gramsNeeded = molesNeeded * reagent.mw;
      const kgNeeded = gramsNeeded / 1000;

      return {
        reagentName: reagent.name,
        formula: reagent.formula,
        molecularWeight: reagent.mw,
        meqPerMol: reagent.meqPerMol,
        amountGrams: round(gramsNeeded, 2),
        amountKg: round(kgNeeded, 4),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const result = {
    calculation: 'reagent_dosing',
    input: {
      currentAlkMgL: p.currentAlk,
      targetAlkMgL: p.targetAlk,
      currentPH: p.currentPH,
      targetPH: p.targetPH,
      volumeM3: p.volumeM3,
    },
    deltaAlkalinity: {
      meqL: round(deltaAlkMeq, 4),
      mgLCaCO3: round(p.targetAlk - p.currentAlk, 2),
      direction: deltaAlkMeq > 0 ? 'increase' : deltaAlkMeq < 0 ? 'decrease' : 'no_change',
    },
    dosingOptions,
    note:
      'Bu hesaplar basitleştirilmiştir (sadece alkalinite değişimi). ' +
      'Tam karbonat sistemi dozlaması için Deffeyes diyagramı yaklaşımı gerekir. ' +
      'pH değişimi alkalinite değişiminin dolaylı bir sonucudur ve burada doğrudan hesaplanmamıştır.',
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ============================================================================
// MOD 6: DOZLAMA SİMÜLASYONU
// ============================================================================
//
// Belirli miktarda kimyasal eklemenin su parametreleri üzerindeki etkisini
// simüle eder: yeni alkalinite, tahmini pH değişimi, CO2 seviyesi.
//
// BASİTLEŞTİRİLMİŞ MODEL:
//   1. Kimyasalın alkalinite katkısını hesapla
//   2. Yeni alkaliniteyi bul
//   3. DIC değişimini hesapla (kimyasalın slope'una göre)
//   4. Yeni DIC ve ALK ile yeni pH'ı tahmin et
//   5. Yeni CO2 seviyesini hesapla
//
// FORMÜL (alkalinite değişimi):
//   delta_alk_meq = (doz_kg × 1000 / MW) × meqPerMol / hacim_L
//   yeni_alk_meq = mevcut_alk_meq + delta_alk_meq
//
// DIC DEĞİŞİMİ (kimyasal tipine göre):
//   Diagonal kimyasallar (NaHCO₃, Na₂CO₃, CaCO₃):
//     delta_DIC = delta_alk / slope (mmol/L)
//   Dikey kimyasallar (NaOH, Ca(OH)₂, CaO, HCl):
//     delta_DIC = 0 (DIC değişmez)
//   Yatay kimyasallar (CO₂):
//     delta_ALK = 0 (alkalinite değişmez)
// ============================================================================

function handleDosingSimulation(rawParams: Record<string, unknown>): ToolResult {
  // ── İKİ KULLANIM MODU ──────────────────────────────────────────
  //
  // A) Tek kimyasal: reagentName + doseKg → ana uygulamadaki gibi tek adım
  // B) Çoklu adım: steps: [{reagentName, doseKg}, ...] → sıralı simülasyon
  //
  // Her iki mod da kütüphanedeki calcForwardDosing() fonksiyonunu kullanır.
  // Bu, ana uygulamadaki (Water Chemistry > Simulation) ile AYNI hesaptır.
  //
  const schema = z.object({
    currentAlk: z.number().min(0).describe('Mevcut alkalinite (mg/L CaCO3)'),
    currentPH: z.number().min(4).max(12).describe('Mevcut pH'),
    volumeM3: z.number().positive().describe('Sistem hacmi (m³)'),
    temperature: z.number().min(0).max(45).default(20).describe('Sıcaklık (°C)'),
    salinity: z.number().min(0).max(45).default(0).describe('Tuzluluk (ppt)'),
    // Tek kimyasal modu
    reagentName: z.string().optional().describe('Kimyasal adı (tek adım için)'),
    doseKg: z.number().positive().optional().describe('Dozaj miktarı kg (tek adım için)'),
    // Çoklu adım modu
    steps: z.array(z.object({
      reagentName: z.string(),
      doseKg: z.number().positive(),
    })).optional().describe('Sıralı kimyasal ekleme adımları [{reagentName, doseKg}, ...]'),
  });

  const p = schema.parse(rawParams);

  const currentAlkMeq = alkMgToMeq(p.currentAlk);
  const currentDIC = calcDicOfAlk(currentAlkMeq, p.currentPH, p.temperature, p.salinity);

  // ── Adımları oluştur ───────────────────────────────────────────
  // Tek kimyasal modu → steps dizisine dönüştür
  type DosingStep = { reagentKey: string; amountGrams: number };
  let dosingSteps: DosingStep[];

  if (p.steps && p.steps.length > 0) {
    // Çoklu adım modu
    dosingSteps = p.steps.map(s => {
      const reagent = REAGENTS.find(r =>
        r.name.toLowerCase() === s.reagentName.toLowerCase() ||
        r.formula === s.reagentName
      );
      if (!reagent) throw new Error(`Kimyasal bulunamadi: ${s.reagentName}`);
      return { reagentKey: reagent.name, amountGrams: s.doseKg * 1000 };
    });
  } else if (p.reagentName && p.doseKg) {
    // Tek kimyasal modu
    const reagent = REAGENTS.find(r =>
      r.name.toLowerCase() === p.reagentName!.toLowerCase() ||
      r.formula === p.reagentName
    );
    if (!reagent) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Kimyasal bulunamadi: ${p.reagentName}`,
            availableReagents: REAGENTS.map(r => ({ name: r.name, formula: r.formula })),
          }),
        }],
      };
    }
    dosingSteps = [{ reagentKey: reagent.name, amountGrams: p.doseKg * 1000 }];
  } else {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'reagentName + doseKg (tek adim) veya steps dizisi (coklu adim) gerekli',
        }),
      }],
    };
  }

  // ── calcForwardDosing — ana uygulamadaki simülasyonla AYNI hesap ──
  //
  // Kütüphane fonksiyonu her adımda:
  //   1. Kimyasalın slope/radians'ına göre DIC ve ALK değişimi hesaplar
  //   2. Yeni DIC ve ALK ile pH bulur (calcPhForAlkDic — bisection)
  //   3. Yeni CO₂ hesaplar
  //   4. Sonucu döner: { label, dic, alk, ph, co2, amountKg }
  //
  const simResult = calcForwardDosing(
    { dic: currentDIC, alk: currentAlkMeq, tempC: p.temperature, salinity: p.salinity },
    p.volumeM3,
    dosingSteps,
  );

  // ── Sonuçları formatla ─────────────────────────────────────────
  const before = simResult[0]!; // "Start" adımı
  const after = simResult[simResult.length - 1]!; // "Final" adımı

  const result = {
    calculation: 'dosing_simulation',
    input: {
      steps: dosingSteps.map(s => ({ reagentName: s.reagentKey, doseKg: s.amountGrams / 1000 })),
      volumeM3: p.volumeM3,
      currentAlkMgL: p.currentAlk,
      currentPH: p.currentPH,
    },
    before: {
      alkalinityMgL: round(p.currentAlk, 2),
      alkalinityMeqL: round(before.alk, 4),
      dicMmolL: round(before.dic, 4),
      ph: round(before.ph, 4),
      co2MgL: round(before.co2, 2),
    },
    // Her adım (intermediate state'ler dahil)
    simulationSteps: simResult.map(step => ({
      label: step.label,
      alkalinityMeqL: round(step.alk, 4),
      alkalinityMgL: round(alkMeqToMg(step.alk), 1),
      dicMmolL: round(step.dic, 4),
      ph: round(step.ph, 4),
      co2MgL: round(step.co2, 2),
      amountKg: round(step.amountKg, 3),
    })),
    after: {
      alkalinityMgL: round(alkMeqToMg(after.alk), 2),
      alkalinityMeqL: round(after.alk, 4),
      dicMmolL: round(after.dic, 4),
      ph: round(after.ph, 4),
      co2MgL: round(after.co2, 2),
    },
    explanation:
      dosingSteps.map(s => `${s.amountGrams / 1000} kg ${s.reagentKey}`).join(' + ') +
      ` eklenmesi: ` +
      `ALK: ${round(alkMeqToMg(before.alk), 1)} → ${round(alkMeqToMg(after.alk), 1)} mg/L, ` +
      `pH: ${round(before.ph, 2)} → ${round(after.ph, 2)}, ` +
      `CO2: ${round(before.co2, 1)} → ${round(after.co2, 1)} mg/L.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ============================================================================
// YARDIMCI FONKSİYONLAR
// ============================================================================
