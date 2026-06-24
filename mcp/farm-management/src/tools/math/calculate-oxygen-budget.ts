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

import { z } from 'zod';
import { round } from '../../utils/formatters.js';
import { calcDOSaturation, calcO2Consumption } from '../../utils/formulas.js';

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
  temperature: z.number().min(0).max(45)
    .describe('Su sıcaklığı (°C)'),
  salinity: z.number().min(0).max(45).default(0)
    .describe('Tuzluluk (ppt) — tatlı su için 0'),
  biomassKg: z.number().positive()
    .describe('Tank biyokütlesi (kg)'),
  dailyFeedKg: z.number().positive()
    .describe('Günlük yem miktarı (kg)'),
  tankVolumeM3: z.number().positive()
    .describe('Tank hacmi (m³)'),
  currentDO: z.number().min(0)
    .describe('Mevcut çözünmüş oksijen (mg/L)'),
  hasBiofilter: z.boolean().default(false)
    .describe('Biyofiltre (RAS) sistemi mevcut mu?'),
  waterFlowM3h: z.number().min(0).optional()
    .describe('Su değişim debisi (m³/saat) — opsiyonel'),
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
// SABİTLER
// ============================================================================

/**
 * Minimum güvenli çözünmüş oksijen seviyesi (mg/L)
 *
 * 5 mg/L, çoğu su ürünleri türü için kabul edilen alt sınırdır.
 * Bu değerin altında balıklar stres belirtileri gösterir:
 *   - Yüzeyde solunma
 *   - İştah kaybı
 *   - Büyüme yavaşlaması
 *   - Bağışıklık sistemi zayıflaması
 *
 * KAYNAK: Boyd & Tucker (1998), FAO Technical Paper 600
 */
const MIN_SAFE_DO = 5.0;

// ============================================================================
// ARAÇ İŞLEYİCİSİ (Handler)
// ============================================================================

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

/**
 * Oksijen bütçesi hesaplama işleyicisi.
 *
 * HESAPLAMA AKIŞI:
 *   1. DO doygunluk (Weiss 1970)
 *   2. Doygunluk yüzdesi ve durumu
 *   3. O2 tüketim hesabı
 *   4. Kritik süre tahmini
 *   5. Sıcaklık etkisi analizi
 *   6. Denge durumu değerlendirmesi
 */
export async function handler(params: unknown): Promise<ToolResult> {
  const input = inputSchema.parse(params);

  const {
    temperature,
    salinity,
    biomassKg,
    dailyFeedKg,
    tankVolumeM3,
    currentDO,
    hasBiofilter,
    waterFlowM3h,
  } = input;

  const tankVolumeL = tankVolumeM3 * 1000;

  // ════════════════════════════════════════════════════════════════
  // 1. DO DOYGUNLUK HESABI — Weiss (1970)
  // ════════════════════════════════════════════════════════════════
  //
  // Weiss (1970) denklemi, su sıcaklığı ve tuzluluğa bağlı olarak
  // suyun maksimum tutabileceği çözünmüş oksijen miktarını verir.
  //
  // FORMÜL:
  //   T = sıcaklık Kelvin cinsinden (°C + 273.15)
  //   S = tuzluluk (ppt)
  //
  //   ln(DO_sat) = A1 + A2×(100/T) + A3×ln(T/100) + A4×(T/100)
  //              + S × [B1 + B2×(T/100) + B3×(T/100)²]
  //
  //   Katsayılar (Weiss 1970, Tablo 1):
  //     A1 = -173.4292
  //     A2 =  249.6339
  //     A3 =  143.3483
  //     A4 =  -21.8492
  //     B1 =   -0.033096
  //     B2 =    0.014259
  //     B3 =   -0.001700
  //
  // FİZİKSEL YORUM:
  //   - Sıcaklık arttıkça DO doygunluğu AZALIR
  //     (sıcak su daha az O2 tutar — Henry yasası)
  //   - Tuzluluk arttıkça DO doygunluğu AZALIR
  //     (tuz iyonları çözünmüş gaz kapasitesini düşürür)
  //
  // ÖRNEK DEĞERLER (tatlı su, deniz seviyesi):
  //   10°C → 11.29 mg/L
  //   15°C → 10.08 mg/L
  //   20°C →  9.09 mg/L
  //   25°C →  8.26 mg/L
  //   30°C →  7.56 mg/L
  //
  const doSaturation = calcDOSaturation(temperature, salinity);

  // ── Doygunluk Yüzdesi ───────────────────────────────────────
  //
  // FORMÜL: doygunluk% = (mevcutDO / DO_doygunluk) × 100
  //
  // DURUM DEĞERLENDİRMESİ:
  //   > 105% → Aşırı doygun (süpersatürasyon — gaz kabarcığı hastalığı riski!)
  //   80-105% → Optimal (balıklar rahat, yem alımı normal)
  //   50-80%  → Düşük (stres belirtileri başlar, yem alımı azalır)
  //   < 50%   → Kritik (balık ölümü riski, acil müdahale gerekli!)
  const saturationPercent = (currentDO / doSaturation) * 100;

  let saturationStatus: string;
  if (saturationPercent > 105) {
    saturationStatus = 'supersaturated';  // Aşırı doygun — gaz kabarcığı riski
  } else if (saturationPercent >= 80) {
    saturationStatus = 'optimal';         // Optimal — normal koşullar
  } else if (saturationPercent >= 50) {
    saturationStatus = 'low';             // Düşük — stres başlangıcı
  } else {
    saturationStatus = 'critical';        // Kritik — acil müdahale
  }

  // ════════════════════════════════════════════════════════════════
  // 2. OKSİJEN TÜKETİM HESABI
  // ════════════════════════════════════════════════════════════════
  //
  // Tüketim kaynakları (predict-feeding-impact ile aynı mantık):
  //   A) Balık solunumu: yem_kg × 0.35 kg O2
  //   B) Biyofiltre: TAN_kg × 4.57 kg O2
  //   C) Organik ayrışma: yem_kg × 0.10 kg O2
  //

  const { fishO2: o2FishKg, biofilterO2: o2BiofilterKg, organicO2: o2OrganicKg, totalO2: totalO2DemandKg } =
    calcO2Consumption({ dailyFeedKg, hasBiofilter });

  // ── Tüketim Hızı (mg/L/saat) ─────────────────────────────────
  //
  // FORMÜL: hız = toplam_O2_kg × 1.000.000 / (24 saat × hacim_L)
  //
  // Bu, sabit tüketim varsayımıyla saat başına düşen O2 miktarıdır.
  // Gerçekte tüketim yemleme sonrası pik yapar (metabolik pik).
  const consumptionRateMgLPerH = (totalO2DemandKg * 1_000_000) / (24 * tankVolumeL);

  // ════════════════════════════════════════════════════════════════
  // 3. KRİTİK SÜRE TAHMİNİ
  // ════════════════════════════════════════════════════════════════
  //
  // Soru: Havalandırma durduğunda (veya hiç yokken), mevcut DO
  //       minimum güvenli seviyeye kaç saatte düşer?
  //
  // FORMÜL: saat = (mevcutDO - minimumDO) / tüketim_hızı
  //
  // VARSAYIMLAR:
  //   - Sabit tüketim hızı (doğrusal azalma)
  //   - Yüzey transferi ihmal (en kötü senaryo)
  //   - Havalandırma yok
  //
  // NOT: mevcutDO < minimumDO ise zaten kritik durumdayız → null
  //      tüketim hızı ≤ 0 ise O2 tüketimi yok → null
  //
  let hoursToMinDO: number | null = null;
  if (currentDO > MIN_SAFE_DO && consumptionRateMgLPerH > 0) {
    hoursToMinDO = (currentDO - MIN_SAFE_DO) / consumptionRateMgLPerH;
  }

  // ════════════════════════════════════════════════════════════════
  // 4. SICAKLIK ETKİSİ ANALİZİ
  // ════════════════════════════════════════════════════════════════
  //
  // Sıcaklık iki yönden olumsuz etki eder:
  //   1. Sıcak su daha az O2 tutar (doygunluk düşer)
  //   2. Balık metabolizması hızlanır (tüketim artar)
  //
  // dDO_sat/dT ≈ -0.17 mg/L/°C (20°C civarında yaklaşık değer)
  //
  // Bu, her 1°C sıcaklık artışında DO doygunluğunun
  // yaklaşık 0.17 mg/L düştüğü anlamına gelir.
  //
  // Hassas hesap: Weiss denkleminin türevi alınabilir ama
  // fark yöntemiyle (±0.5°C) hesaplamak daha pratiktir.
  //
  const doSatPlus = calcDOSaturation(temperature + 0.5, salinity);
  const doSatMinus = calcDOSaturation(temperature - 0.5, salinity);
  const temperatureEffect = doSatPlus - doSatMinus; // mg/L per °C (negatif değer)

  // ── Kritik Sıcaklık Hesabı ──────────────────────────────────
  //
  // Soru: Hangi sıcaklıkta DO doygunluğu minimum güvenli seviyeye düşer?
  //
  // Weiss denklemini analitik olarak çözmek zor, iterasyonla buluyoruz:
  //   1°C adımlarla sıcaklık artır
  //   DO_sat < MIN_SAFE_DO olana kadar devam et
  //
  // Bu sıcaklığın üzerinde, su fiziksel olarak yeterli O2 tutamaz.
  // Pratik bir uyarı eşiğidir.
  //
  let criticalTemperature: number | null = null;
  for (let t = temperature; t <= 50; t += 0.5) {
    const doSatAtT = calcDOSaturation(t, salinity);
    if (doSatAtT < MIN_SAFE_DO) {
      criticalTemperature = t;
      break;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 5. SU DEĞİŞİM ETKİSİ (opsiyonel)
  // ════════════════════════════════════════════════════════════════
  //
  // Akışlı sistemlerde gelen taze su DO takviyesi sağlar.
  //
  // FORMÜL: O2_takviye = debi × (DO_gelen - DO_tank) × 1000 / tankHacmi_L
  //
  // Basitleştirilmiş yaklaşım: Gelen su doygunlukta varsayılır.
  // O2_gelen_saatlik_mg = debi_m3h × DO_sat × 1000 (m3→L → mg/L düzeltmesi yok, zaten mg/L)
  //
  // Ama konsantrasyon bazında: daha sofistike bir modele ihtiyaç var.
  // Burada basit bir bilgi olarak ekliyoruz.
  //
  let waterExchangeInfo: Record<string, unknown> | null = null;
  if (waterFlowM3h != null && waterFlowM3h > 0) {
    // Saatte tank hacminin kaçta kaçı değişiyor?
    const exchangeRatePerHour = waterFlowM3h / tankVolumeM3;
    // Tam karışım tank modeli (CSTR) ile denge DO tahmini:
    //   DO_denge ≈ (debi × DO_gelen + ... - tüketim) / (debi + ...)
    // Basitleştirilmiş: DO_gelen = DO_sat varsayımı
    //   DO_kararlı ≈ DO_sat - (tüketim_hızı / değişim_hızı)
    //   burada tüketim_hızı mg/L/saat ve değişim_hızı = debi/hacim (/saat)
    const steadyStateDO = doSaturation - (consumptionRateMgLPerH / exchangeRatePerHour);

    waterExchangeInfo = {
      flowRateM3h: waterFlowM3h,
      exchangeRatePerHour: round(exchangeRatePerHour, 4),
      exchangesPerDay: round(exchangeRatePerHour * 24, 2),
      estimatedSteadyStateDO: round(Math.max(0, steadyStateDO), 2),
      steadyStateAdequate: steadyStateDO >= MIN_SAFE_DO,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 6. DENGE DURUMU DEĞERLENDİRMESİ
  // ════════════════════════════════════════════════════════════════
  //
  // Havalandırma olmadan tankın kendi başına ne kadar dayanacağı:
  //   > 24 saat → Fazla (surplus) — düşük yoğunluk veya düşük sıcaklık
  //   12-24 saat → Dengeli (balanced) — normal operasyon
  //   < 12 saat → Açık (deficit) — havalandırma zorunlu
  //   null → Zaten kritik seviyenin altında
  //
  let balanceStatus: string;
  if (hoursToMinDO === null) {
    balanceStatus = 'critical';  // Zaten minimum DO altında veya tüketim yok
  } else if (hoursToMinDO > 24) {
    balanceStatus = 'surplus';   // 24 saatten fazla dayanır
  } else if (hoursToMinDO >= 12) {
    balanceStatus = 'balanced';  // 12-24 saat arası
  } else {
    balanceStatus = 'deficit';   // 12 saatten az — havalandırma şart
  }

  // ════════════════════════════════════════════════════════════════
  // 7. SONUÇ YAPISI
  // ════════════════════════════════════════════════════════════════

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
      fishRespirationKgO2: round(o2FishKg, 4),
      biofilterNitrificationKgO2: round(o2BiofilterKg, 4),
      organicDecompositionKgO2: round(o2OrganicKg, 4),
      totalDailyO2DemandKg: round(totalO2DemandKg, 4),
      consumptionRateMgLPerHour: round(consumptionRateMgLPerH, 4),
      explanation:
        `Günlük O2 tüketimi: ${round(totalO2DemandKg, 3)} kg ` +
        `(${round(consumptionRateMgLPerH, 3)} mg/L/saat).`,
    },

    // ── Kritik Süre Tahmini ─────────────────────────────────────
    criticalTime: {
      hoursToMinDO: hoursToMinDO !== null ? round(hoursToMinDO, 1) : null,
      balanceStatus,
      explanation: hoursToMinDO !== null
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
        `${criticalTemperature !== null
          ? `${criticalTemperature}°C'de doygunluk ${MIN_SAFE_DO} mg/L'nin altına düşer.`
          : '50°C altında kritik sıcaklığa ulaşılmaz.'}`,
    },

    // ── Su Değişimi (opsiyonel) ─────────────────────────────────
    waterExchange: waterExchangeInfo,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}


