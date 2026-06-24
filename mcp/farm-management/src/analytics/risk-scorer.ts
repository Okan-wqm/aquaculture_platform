// ============================================================================
// MCP Farm Intelligence Server — Risk Skorlama Motoru (Risk Scorer)
// ============================================================================
//
// 7 faktoru agirlikli ortalama ile birlestirerek 0-100 arasi risk skoru hesaplar.
// Her faktor bagimsiz olarak degerlendirilir ve bileske skor uretilir.
//
// NASIL CALISIR:
//   1. Her faktor icin 0-100 arasi ham skor hesaplanir:
//      - mortalityTrend (0.25): Son 7 gunluk mortalite trendi
//      - waterQualityDeviation (0.20): WQ parametrelerinin optimaldan sapmasi
//      - tankDensity (0.15): Tank yogunlugununun kapasiteye orani
//      - activeHealthEvents (0.15): Aktif saglik olaylarinin sayisi ve ciddiyeti
//      - fcrDeviation (0.10): FCR'in hedeften sapmasi
//      - overdueMaintenance (0.10): Geciken bakimlarin sayisi ve suresi
//      - weatherRisk (0.05): Hava durumu risk faktoru
//   2. Agirliklar uygulanir
//   3. Agirlikli toplam = composite score (0-100)
//   4. Risk seviyesi belirlenir:
//      - 0-25: normal — operasyonlar saglikli
//      - 26-50: dikkat — bazi faktorler izlenmeli
//      - 51-75: uyari — mudahale gerekebilir
//      - 76-100: kritik — acil mudahale sart
//   5. Uyari mesajlari (alerts) uretilir
//
// AGIRLIK MANTIGI:
//   - mortalityTrend (0.25): En yuksek agirlik cunku mortalite direkt
//     ekonomik kayip ve hayvan refahı göstergesi
//   - waterQualityDeviation (0.20): WQ bozulmasi diger tum sorunlarin kokeni
//   - tankDensity (0.15): Yogunluk WQ ve stres uzerinde dogrudan etkili
//   - activeHealthEvents (0.15): Mevcut hastalik/tedavi durumu
//   - fcrDeviation (0.10): Ekonomik verimlilik gostergesi
//   - overdueMaintenance (0.10): Gelecek risk potansiyeli
//   - weatherRisk (0.05): Cevreel faktor, kontrol disinda ama etki yaratır
//
// EXTENSIBLE:
//   - Yeni faktorler eklenebilir (agirliklar yeniden dengelenmeli)
//   - Alert kurallari genisletilebilir
//   - Faktor skor hesaplama fonksiyonlari override edilebilir
// ============================================================================

import { getThresholds, type SpeciesThresholds } from '../knowledge/thresholds.js';
import { mean, movingAverage, linearRegressionSlope } from '../utils/stats.js';

// ── Tip Tanimlari ─────────────────────────────────────────────────────────────

/**
 * Tek bir risk faktoru ve hesaplanan skoru.
 */
export interface RiskFactor {
  /** Faktor adi (ornegin 'mortalityTrend', 'waterQualityDeviation') */
  name: string;

  /** Ham skor (0-100). Yuksek = yuksek risk. */
  score: number;

  /** Agirlik (0.0 - 1.0). Tum agirliklarin toplami 1.0 olmali. */
  weight: number;

  /** Agirlikli skor: score * weight. Bileske skora katkisi. */
  weightedScore: number;

  /**
   * Trend yonu:
   *   - 'improving': risk azaliyor (iyi yonde gidiyor)
   *   - 'stable': degisim yok
   *   - 'worsening': risk artiyor (kotu yonde gidiyor)
   */
  trend: 'improving' | 'stable' | 'worsening';

  /** Faktor hakkinda Turkce aciklama */
  detail: string;

  /** Bu faktorun hesaplamasinda kullanilan veri noktasi sayisi */
  dataPoints: number;
}

/**
 * Kritik esik asimlarinda veya belirli kosullarda uretilen uyari.
 */
export interface RiskAlert {
  /** Oncelik seviyesi */
  priority: 'low' | 'medium' | 'high' | 'critical';

  /** Uyari mesaji (Turkce) */
  message: string;

  /** Onerilen aksiyon (Turkce) */
  suggestedAction: string;

  /** Uyarinin iliskili oldugu faktor adi */
  relatedFactor: string;
}

/**
 * Tam risk degerlendirme sonucu.
 */
export interface RiskAssessment {
  /** Bileske risk skoru (0-100) */
  overallRisk: number;

  /**
   * Risk seviyesi:
   *   - 'normal': 0-25 — operasyonlar saglikli
   *   - 'attention': 26-50 — izleme gerekli
   *   - 'warning': 51-75 — mudahale onerilir
   *   - 'critical': 76-100 — acil mudahale
   */
  riskLevel: 'normal' | 'attention' | 'warning' | 'critical';

  /** Her faktogun detayli bilgisi */
  factors: RiskFactor[];

  /** Uretilen uyari mesajlari */
  alerts: RiskAlert[];
}

/**
 * Risk skoru hesaplama icin girdi verisi.
 *
 * AnomalyInput'a benzer yapida — onceden cekilmis veriler.
 * Her alan opsiyoneldir; mevcut verilerle hesaplama yapilir.
 */
export interface RiskInput {
  /** Gunluk mortalite kayitlari */
  mortalityRecords?: Array<{
    date: string;
    count: number;
    totalStock: number;
  }>;

  /** Son WQ olcumleri (tum tanklar) */
  waterQualityMeasurements?: Array<{
    tankId: string;
    temperature?: number;
    ph?: number;
    dissolvedOxygen?: number;
    ammonia?: number;
    nitrite?: number;
    nitrate?: number;
  }>;

  /** Tank bilgileri */
  tanks?: Array<{
    id: string;
    name: string;
    currentBiomass: number;
    volume: number;
    maxDensity: number;
  }>;

  /** Aktif saglik olaylari */
  healthEvents?: Array<{
    id: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    status: string;
  }>;

  /** Besleme kayitlari (FCR hesabi icin) */
  feedingRecords?: Array<{
    actual: number;
  }>;

  /** Buyume verileri (FCR hesabi icin) */
  growthData?: Array<{
    batchId: string;
    date: string;
    avgWeight: number;
  }>;

  /** Bakim takvimleri */
  maintenanceSchedules?: Array<{
    dueDate: string;
    status: string;
  }>;

  /** Hava durumu bilgisi */
  weather?: {
    windSpeedKph?: number;
    temperatureC?: number;
    stormWarning?: boolean;
    extremeHeat?: boolean;
    extremeCold?: boolean;
  };

  /** Tur bazli esik degerleri */
  speciesThresholds?: SpeciesThresholds;
}

// ── Agirlik Sabitleri ────────────────────────────────────────────────────────

const WEIGHTS = {
  mortalityTrend: 0.25,
  waterQualityDeviation: 0.20,
  tankDensity: 0.15,
  activeHealthEvents: 0.15,
  fcrDeviation: 0.10,
  overdueMaintenance: 0.10,
  weatherRisk: 0.05,
} as const;

// ── Ana Fonksiyon ─────────────────────────────────────────────────────────────

/**
 * Bileske risk skoru hesaplar.
 *
 * NASIL CALISIR:
 *   1. Her faktor icin ilgili scoring fonksiyonu cagirilir
 *   2. Mevcut olmayan veriler icin varsayilan skor atanir (0 = risk yok)
 *   3. Agirlikli toplam hesaplanir
 *   4. Uyari mesajlari uretilir
 *   5. Sonuc dondurulur
 *
 * @param input - Onceden cekilmis veri dizileri
 * @returns Tam risk degerlendirme sonucu
 */
export function calculateRiskScore(input: RiskInput): RiskAssessment {
  const thresholds = input.speciesThresholds;
  const factors: RiskFactor[] = [];

  // ── 1. Mortalite Trendi ────────────────────────────────────
  factors.push(scoreMortalityTrend(input.mortalityRecords));

  // ── 2. Su Kalitesi Sapmasi ─────────────────────────────────
  factors.push(scoreWaterQuality(input.waterQualityMeasurements, thresholds));

  // ── 3. Tank Yogunlugu ──────────────────────────────────────
  factors.push(scoreTankDensity(input.tanks));

  // ── 4. Aktif Saglik Olaylari ───────────────────────────────
  factors.push(scoreHealthEvents(input.healthEvents));

  // ── 5. FCR Sapmasi ─────────────────────────────────────────
  factors.push(scoreFCRDeviation(input.feedingRecords, input.growthData, thresholds));

  // ── 6. Geciken Bakim ───────────────────────────────────────
  factors.push(scoreOverdueMaintenance(input.maintenanceSchedules));

  // ── 7. Hava Durumu Riski ───────────────────────────────────
  factors.push(scoreWeatherRisk(input.weather));

  // ── Bileske Skor ───────────────────────────────────────────
  const overallRisk = Math.round(
    factors.reduce((sum, f) => sum + f.weightedScore, 0) * 100,
  ) / 100;

  // ── Risk Seviyesi ──────────────────────────────────────────
  const riskLevel = getRiskLevel(overallRisk);

  // ── Uyarilar ───────────────────────────────────────────────
  const alerts = generateAlerts(factors);

  return {
    overallRisk: Math.min(100, Math.max(0, overallRisk)),
    riskLevel,
    factors,
    alerts,
  };
}

// ── Faktor Skorlama Fonksiyonlari ────────────────────────────────────────────

/**
 * Mortalite trend skoru hesaplar.
 *
 * NASIL CALISIR:
 *   1. Son 7 gunluk mortalite oranlarini hesapla (count/totalStock * 100)
 *   2. Hareketli ortalama ile trend belirle
 *   3. Skor = min(100, mortalityRate * 20) + trend bonusu
 *
 * Neden * 20?
 *   - %0.1 gunluk mortalite → skor 2 (normal)
 *   - %1 gunluk mortalite → skor 20 (dikkat)
 *   - %3 gunluk mortalite → skor 60 (uyari)
 *   - %5+ gunluk mortalite → skor 100 (kritik)
 *   Bu carpan endüstri standartlarina gore kalibrasyon saglar.
 *
 * Trend bonusu:
 *   Artan trend +20, azalan trend -10, stabil +0
 *   Mortalite artiyorsa risk daha yuksek.
 */
export function scoreMortalityTrend(
  records?: RiskInput['mortalityRecords'],
): RiskFactor {
  const weight = WEIGHTS.mortalityTrend;

  // Veri yoksa sifir risk varsay
  if (!records || records.length === 0) {
    return createFactor('mortalityTrend', 0, weight, 'stable', 'Mortalite verisi mevcut degil', 0);
  }

  // Mortalite oranlarini hesapla (%)
  const rates = records.map(r =>
    r.totalStock > 0 ? (r.count / r.totalStock) * 100 : 0,
  );

  // Ortalama mortalite orani
  const avgRate = mean(rates);

  // Ham skor: min(100, oran * 20)
  let score = Math.min(100, avgRate * 20);

  // Trend analizi: son 3 gunun egimi
  const recentRates = rates.slice(-Math.min(3, rates.length));
  const trendSlope = recentRates.length >= 2
    ? linearRegressionSlope(recentRates.map((_, i) => i), recentRates)
    : 0;

  // Trend bonusu
  let trend: RiskFactor['trend'] = 'stable';
  if (trendSlope > avgRate * 0.05) {
    trend = 'worsening';
    score = Math.min(100, score + 20);
  } else if (trendSlope < -avgRate * 0.05) {
    trend = 'improving';
    score = Math.max(0, score - 10);
  }

  const detail = `Ortalama gunluk mortalite: %${avgRate.toFixed(3)}, trend: ${trendToTurkish(trend)}`;

  return createFactor('mortalityTrend', score, weight, trend, detail, records.length);
}

/**
 * Su kalitesi sapma skoru hesaplar.
 *
 * NASIL CALISIR:
 *   1. Her WQ parametresi icin optimal degerden sapma hesaplanir
 *   2. Sapma normalize edilir (0-1 arasi, her parametre icin farkli olcek)
 *   3. Tum parametrelerin ortalama sapmasi alinir
 *   4. Skor = min(100, avgDeviation * 100)
 *
 * Normalizasyon mantigi:
 *   Her parametrenin "tehlikeli sapma mesafesi" farklidir:
 *   - Sicaklik: 1°C sapma az, 5°C sapma cok
 *   - Amonyak: 0.01 mg/L sapma onemli olabilir
 *   Bu nedenle her parametre kendi araligina gore normalize edilir.
 */
export function scoreWaterQuality(
  measurements?: RiskInput['waterQualityMeasurements'],
  thresholds?: SpeciesThresholds,
): RiskFactor {
  const weight = WEIGHTS.waterQualityDeviation;

  if (!measurements || measurements.length === 0) {
    return createFactor('waterQualityDeviation', 0, weight, 'stable', 'WQ verisi mevcut degil', 0);
  }

  // Varsayilan esikler — knowledge/thresholds.ts'den
  const t = thresholds ?? getThresholds();

  const deviations: number[] = [];

  for (const m of measurements) {
    // Sicaklik sapmasi: |deger - optimal| / (max - min)
    if (m.temperature !== undefined) {
      const range = t.temperature.max - t.temperature.min;
      const dev = range > 0
        ? Math.abs(m.temperature - t.temperature.optimal) / range
        : 0;
      deviations.push(Math.min(1, dev));
    }

    // pH sapmasi
    if (m.ph !== undefined) {
      const range = t.ph.max - t.ph.min;
      const dev = range > 0
        ? Math.abs(m.ph - t.ph.optimal) / range
        : 0;
      deviations.push(Math.min(1, dev));
    }

    // DO sapmasi: optimal'den ne kadar dusuk (dusuk = kotu)
    if (m.dissolvedOxygen !== undefined) {
      const dev = m.dissolvedOxygen < t.dissolvedOxygen.optimal
        ? (t.dissolvedOxygen.optimal - m.dissolvedOxygen) / t.dissolvedOxygen.optimal
        : 0;
      deviations.push(Math.min(1, dev));
    }

    // Amonyak sapmasi: uyari esigini ne kadar asar
    if (m.ammonia !== undefined) {
      const dev = m.ammonia > t.ammonia.warning
        ? (m.ammonia - t.ammonia.warning) / (t.ammonia.max - t.ammonia.warning)
        : 0;
      deviations.push(Math.min(1, Math.max(0, dev)));
    }

    // Nitrit sapmasi
    if (m.nitrite !== undefined) {
      const dev = m.nitrite > t.nitrite.warning
        ? (m.nitrite - t.nitrite.warning) / (t.nitrite.max - t.nitrite.warning)
        : 0;
      deviations.push(Math.min(1, Math.max(0, dev)));
    }

    // Nitrat sapmasi
    if (m.nitrate !== undefined) {
      const dev = m.nitrate > t.nitrate.warning
        ? (m.nitrate - t.nitrate.warning) / (t.nitrate.max - t.nitrate.warning)
        : 0;
      deviations.push(Math.min(1, Math.max(0, dev)));
    }
  }

  if (deviations.length === 0) {
    return createFactor('waterQualityDeviation', 0, weight, 'stable', 'WQ parametreleri eksik', 0);
  }

  const avgDev = mean(deviations);
  const score = Math.min(100, avgDev * 50 * 2); // skor = min(100, avgDeviation * 100) — avgDev 0-1, * 100 yaparak 0-100'e cevir

  // Basit trend: ortalama sapma > 0.5 → kotulesme olarak yorumla
  const trend: RiskFactor['trend'] = avgDev > 0.5 ? 'worsening' : avgDev < 0.2 ? 'improving' : 'stable';

  const detail = `Ortalama WQ sapmasi: ${(avgDev * 100).toFixed(1)}%, ${measurements.length} tank degerlendirildi`;

  return createFactor('waterQualityDeviation', score, weight, trend, detail, deviations.length);
}

/**
 * Tank yogunluk skoru hesaplar.
 *
 * NASIL CALISIR:
 *   1. Her tank icin yogunluk orani hesaplanir: (biomass/volume) / maxDensity
 *   2. En yuksek oran ana skor olarak alinir (en riskli tank belirler)
 *   3. Skor bantlari:
 *      oran > 0.9 → 80+ (yuksek risk)
 *      oran 0.7-0.9 → 40-80 (orta risk, lineer interpolasyon)
 *      oran < 0.7 → 0-40 (dusuk risk)
 */
export function scoreTankDensity(
  tanks?: RiskInput['tanks'],
): RiskFactor {
  const weight = WEIGHTS.tankDensity;

  if (!tanks || tanks.length === 0) {
    return createFactor('tankDensity', 0, weight, 'stable', 'Tank verisi mevcut degil', 0);
  }

  // Her tankin yogunluk oranini hesapla
  const ratios: number[] = [];
  for (const tank of tanks) {
    if (tank.volume > 0 && tank.maxDensity > 0) {
      const currentDensity = tank.currentBiomass / tank.volume;
      ratios.push(currentDensity / tank.maxDensity);
    }
  }

  if (ratios.length === 0) {
    return createFactor('tankDensity', 0, weight, 'stable', 'Yogunluk hesaplanamadi', 0);
  }

  // En yuksek oran — en riskli tanki temsil eder
  const maxRatio = Math.max(...ratios);
  const avgRatio = mean(ratios);

  // Skor bantlari:
  //   > 0.9 → 80 + (oran - 0.9) / 0.1 * 20 = 80-100
  //   0.7 - 0.9 → 40 + (oran - 0.7) / 0.2 * 40 = 40-80
  //   < 0.7 → oran / 0.7 * 40 = 0-40
  let score: number;
  if (maxRatio > 0.9) {
    score = 80 + Math.min(20, (maxRatio - 0.9) / 0.1 * 20);
  } else if (maxRatio > 0.7) {
    score = 40 + (maxRatio - 0.7) / 0.2 * 40;
  } else {
    score = maxRatio / 0.7 * 40;
  }
  score = Math.min(100, Math.max(0, score));

  const trend: RiskFactor['trend'] = maxRatio > 0.9 ? 'worsening' : maxRatio < 0.7 ? 'improving' : 'stable';
  const detail = `En yuksek yogunluk orani: ${(maxRatio * 100).toFixed(1)}%, ortalama: ${(avgRatio * 100).toFixed(1)}%`;

  return createFactor('tankDensity', score, weight, trend, detail, tanks.length);
}

/**
 * Aktif saglik olaylari skoru hesaplar.
 *
 * NASIL CALISIR:
 *   1. Her olayin ciddiyet agirligi belirlenir:
 *      critical = 30, high = 20, medium = 10, low = 5
 *   2. Toplam agirlikli puan hesaplanir
 *   3. Skor = min(100, toplam)
 */
export function scoreHealthEvents(
  events?: RiskInput['healthEvents'],
): RiskFactor {
  const weight = WEIGHTS.activeHealthEvents;

  if (!events || events.length === 0) {
    return createFactor('activeHealthEvents', 0, weight, 'stable', 'Aktif saglik olayi yok', 0);
  }

  // Sadece aktif (tamamlanmamis) olaylar
  const activeEvents = events.filter(e => e.status !== 'resolved' && e.status !== 'closed');

  if (activeEvents.length === 0) {
    return createFactor('activeHealthEvents', 0, weight, 'improving', 'Tum saglik olaylari cozulmus', events.length);
  }

  // Ciddiyet agirliklari
  const severityWeights: Record<string, number> = {
    critical: 30,
    high: 20,
    medium: 10,
    low: 5,
  };

  const total = activeEvents.reduce((sum, e) => sum + (severityWeights[e.severity] ?? 5), 0);
  const score = Math.min(100, total);

  const hasCritical = activeEvents.some(e => e.severity === 'critical');
  const trend: RiskFactor['trend'] = hasCritical ? 'worsening' : 'stable';

  const detail = `${activeEvents.length} aktif saglik olayi (${activeEvents.filter(e => e.severity === 'critical').length} kritik)`;

  return createFactor('activeHealthEvents', score, weight, trend, detail, activeEvents.length);
}

/**
 * FCR sapma skoru hesaplar.
 *
 * NASIL CALISIR:
 *   1. Toplam yem ve toplam buyume hesaplanir
 *   2. FCR = toplam_yem / toplam_buyume
 *   3. Hedeften sapma: |FCR - target| / target * 100
 *   4. Skor = min(100, sapma * 3)
 *
 * Neden * 3?
 *   - %10 sapma → skor 30 (normal operasyonel varyans)
 *   - %20 sapma → skor 60 (dikkat gerektiren)
 *   - %33+ sapma → skor 100 (ciddi verimlilik sorunu)
 */
export function scoreFCRDeviation(
  feedingRecords?: RiskInput['feedingRecords'],
  growthData?: RiskInput['growthData'],
  thresholds?: SpeciesThresholds,
): RiskFactor {
  const weight = WEIGHTS.fcrDeviation;
  const targetFCR = thresholds?.targetFCR ?? 1.5;

  if (!feedingRecords || feedingRecords.length === 0 || !growthData || growthData.length < 2) {
    return createFactor('fcrDeviation', 0, weight, 'stable', 'FCR hesabi icin yeterli veri yok', 0);
  }

  // Toplam yem
  const totalFeed = feedingRecords.reduce((sum, r) => sum + r.actual, 0);

  // Buyume: batch bazinda ilk ve son agirlik farki
  // Basitlestirme: tum buyume verilerini batch bazinda grupla
  const byBatch: Record<string, Array<{ date: string; avgWeight: number }>> = {};
  for (const g of growthData) {
    if (!byBatch[g.batchId]) byBatch[g.batchId] = [];
    byBatch[g.batchId]!.push({ date: g.date, avgWeight: g.avgWeight });
  }

  let totalGrowth = 0;
  for (const records of Object.values(byBatch)) {
    if (records.length < 2) continue;
    const sorted = [...records].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const gain = sorted[sorted.length - 1]!.avgWeight - sorted[0]!.avgWeight;
    if (gain > 0) totalGrowth += gain;
  }

  if (totalGrowth <= 0 || totalFeed <= 0) {
    return createFactor('fcrDeviation', 0, weight, 'stable', 'Buyume veya yem verisi yetersiz', 0);
  }

  const calculatedFCR = totalFeed / totalGrowth;
  const deviationPct = Math.abs(calculatedFCR - targetFCR) / targetFCR * 100;
  const score = Math.min(100, deviationPct * 3);

  const trend: RiskFactor['trend'] = calculatedFCR > targetFCR * 1.15 ? 'worsening' :
    calculatedFCR <= targetFCR * 1.05 ? 'improving' : 'stable';

  const detail = `Hesaplanan FCR: ${calculatedFCR.toFixed(2)}, hedef: ${targetFCR}, sapma: %${deviationPct.toFixed(1)}`;

  return createFactor('fcrDeviation', score, weight, trend, detail, feedingRecords.length);
}

/**
 * Geciken bakim skoru hesaplar.
 *
 * NASIL CALISIR:
 *   1. Tamamlanmamis ve tarihi gecmis bakimlar sayilir
 *   2. Her bakim icin gecikme suresi (gun) hesaplanir
 *   3. Skor = min(100, geciken_sayi * ortalama_gecikme * 5)
 *
 * Neden * 5?
 *   - 1 bakim 1 gun gecikti → skor 5 (dusuk)
 *   - 2 bakim 3 gun gecikti → skor 30 (dikkat)
 *   - 3 bakim 7 gun gecikti → skor 100 (kritik)
 */
export function scoreOverdueMaintenance(
  schedules?: RiskInput['maintenanceSchedules'],
): RiskFactor {
  const weight = WEIGHTS.overdueMaintenance;

  if (!schedules || schedules.length === 0) {
    return createFactor('overdueMaintenance', 0, weight, 'stable', 'Bakim takvimi verisi yok', 0);
  }

  const now = Date.now();
  const overdue = schedules.filter(s => {
    const isIncomplete = s.status !== 'completed' && s.status !== 'cancelled';
    const isPastDue = new Date(s.dueDate).getTime() < now;
    return isIncomplete && isPastDue;
  });

  if (overdue.length === 0) {
    return createFactor('overdueMaintenance', 0, weight, 'improving', 'Geciken bakim yok — tum bakimlar zamaninda', schedules.length);
  }

  // Ortalama gecikme suresi (gun)
  const delayDays = overdue.map(s => {
    return (now - new Date(s.dueDate).getTime()) / (1000 * 60 * 60 * 24);
  });
  const avgDelay = mean(delayDays);

  const score = Math.min(100, overdue.length * avgDelay * 5);
  const trend: RiskFactor['trend'] = overdue.length > 2 ? 'worsening' : 'stable';

  const detail = `${overdue.length} geciken bakim, ortalama gecikme: ${avgDelay.toFixed(1)} gun`;

  return createFactor('overdueMaintenance', score, weight, trend, detail, overdue.length);
}

/**
 * Hava durumu risk skoru hesaplar.
 *
 * NASIL CALISIR:
 *   1. Firtina uyarisi varsa → skor 80
 *   2. Asiri sicaklik veya soguk → skor 60
 *   3. Ruzgar > 40 kph → skor 40
 *   4. Aksi halde → skor 0
 *
 * Neden en dusuk agirlik (%5)?
 *   Hava durumu kontrol edileez bir faktor.
 *   Ama etki yaratabilir:
 *   - Firtina → dalga → kafes hasari
 *   - Asiri sicaklik → su sicakligi artisi
 *   - Sert soguk → hipothermi riski
 */
export function scoreWeatherRisk(
  weather?: RiskInput['weather'],
): RiskFactor {
  const weight = WEIGHTS.weatherRisk;

  if (!weather) {
    return createFactor('weatherRisk', 0, weight, 'stable', 'Hava durumu verisi yok', 0);
  }

  let score = 0;
  const issues: string[] = [];

  // Firtina uyarisi — en yuksek oncelik
  if (weather.stormWarning) {
    score = Math.max(score, 80);
    issues.push('Firtina uyarisi aktif');
  }

  // Asiri sicaklik
  if (weather.extremeHeat) {
    score = Math.max(score, 60);
    issues.push('Asiri sicaklik');
  }

  // Asiri soguk
  if (weather.extremeCold) {
    score = Math.max(score, 60);
    issues.push('Asiri soguk');
  }

  // Yuksek ruzgar (> 40 kph)
  if (weather.windSpeedKph !== undefined && weather.windSpeedKph > 40) {
    const windScore = Math.min(80, 40 + (weather.windSpeedKph - 40));
    score = Math.max(score, windScore);
    issues.push(`Yuksek ruzgar: ${weather.windSpeedKph} kph`);
  }

  const trend: RiskFactor['trend'] = score > 50 ? 'worsening' : 'stable';
  const detail = issues.length > 0 ? issues.join(', ') : 'Hava durumu normal';

  return createFactor('weatherRisk', score, weight, trend, detail, 1);
}

// ── Uyari Uretimi ─────────────────────────────────────────────────────────────

/**
 * Risk faktorlerine dayali uyari mesajlari uretir.
 *
 * NASIL CALISIR:
 *   1. Her faktor kontrol edilir:
 *      - Skor > 80 → critical uyari
 *      - Skor > 60 → high uyari
 *   2. Bileske skor > 50 → genel uyari
 *   3. Birden fazla faktor kotulesme trendindeyse → eskalasyon uyarisi
 *
 * @param factors - Tum risk faktorleri
 * @returns Uretilen uyari listesi
 */
export function generateAlerts(factors: RiskFactor[]): RiskAlert[] {
  const alerts: RiskAlert[] = [];

  // ── Faktor bazli uyarilar ──────────────────────────────────
  for (const factor of factors) {
    const factorLabel = factorToTurkish(factor.name);

    // Kritik esik (skor > 80)
    if (factor.score > 80) {
      alerts.push({
        priority: 'critical',
        message: `${factorLabel} kritik seviyede (skor: ${factor.score.toFixed(0)})`,
        suggestedAction: getFactorAction(factor.name, 'critical'),
        relatedFactor: factor.name,
      });
    }
    // Yuksek esik (skor > 60)
    else if (factor.score > 60) {
      alerts.push({
        priority: 'high',
        message: `${factorLabel} yuksek risk bolgdlerinde (skor: ${factor.score.toFixed(0)})`,
        suggestedAction: getFactorAction(factor.name, 'high'),
        relatedFactor: factor.name,
      });
    }
  }

  // ── Genel uyari (bileske > 50) ─────────────────────────────
  const composite = factors.reduce((sum, f) => sum + f.weightedScore, 0);
  if (composite > 50) {
    alerts.push({
      priority: 'high',
      message: `Genel risk skoru yuksek (${composite.toFixed(0)}/100) — birden fazla faktor risk bolgdlerine`,
      suggestedAction: 'Tum risk faktorlerini inceleyin ve oncelikli mudahale plani olusturun',
      relatedFactor: 'composite',
    });
  }

  // ── Eskalasyon uyarisi (birden fazla kotulesme) ────────────
  const worseningFactors = factors.filter(f => f.trend === 'worsening');
  if (worseningFactors.length >= 2) {
    const names = worseningFactors.map(f => factorToTurkish(f.name)).join(', ');
    alerts.push({
      priority: 'high',
      message: `Birden fazla faktor kotulesme trendinde: ${names}`,
      suggestedAction: 'Kaskad etkisi riski mevcut — faktorler arasi iliskiyi inceleyin',
      relatedFactor: 'escalation',
    });
  }

  // Priority'ye gore sirala (critical > high > medium > low)
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  alerts.sort((a, b) => (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4));

  return alerts;
}

/**
 * Risk skoruna gore seviye belirler.
 *
 * @param score - Bileske risk skoru (0-100)
 * @returns Risk seviyesi etiketi
 */
export function getRiskLevel(score: number): RiskAssessment['riskLevel'] {
  if (score <= 25) return 'normal';
  if (score <= 50) return 'attention';
  if (score <= 75) return 'warning';
  return 'critical';
}

// ── Yardimci Fonksiyonlar (Dahili) ───────────────────────────────────────────

/**
 * RiskFactor nesnesi olusturma yardimcisi.
 *
 * Tekrarlayan nesne olusturma kodunu merkeziler.
 */
function createFactor(
  name: string,
  score: number,
  weight: number,
  trend: RiskFactor['trend'],
  detail: string,
  dataPoints: number,
): RiskFactor {
  // Skoru sinirla ve yuvarla
  const clampedScore = Math.min(100, Math.max(0, Math.round(score * 100) / 100));

  return {
    name,
    score: clampedScore,
    weight,
    weightedScore: Math.round(clampedScore * weight * 100) / 100,
    trend,
    detail,
    dataPoints,
  };
}

/**
 * Trend degerini Turkce'ye cevirir.
 */
function trendToTurkish(trend: RiskFactor['trend']): string {
  const map: Record<RiskFactor['trend'], string> = {
    improving: 'iyilesme',
    stable: 'stabil',
    worsening: 'kotulesme',
  };
  return map[trend] ?? trend;
}

/**
 * Faktor adini Turkce etiketine cevirir.
 *
 * EXTENSIBLE: Yeni faktorler eklendikce bu harita genisletilir.
 */
function factorToTurkish(factorName: string): string {
  const map: Record<string, string> = {
    mortalityTrend: 'Mortalite trendi',
    waterQualityDeviation: 'Su kalitesi sapmasi',
    tankDensity: 'Tank yogunlugu',
    activeHealthEvents: 'Aktif saglik olaylari',
    fcrDeviation: 'FCR sapmasi',
    overdueMaintenance: 'Geciken bakim',
    weatherRisk: 'Hava durumu riski',
  };
  return map[factorName] ?? factorName;
}

/**
 * Faktor ve ciddiyet seviyesine gore onerilen aksiyon mesaji dondurur.
 *
 * EXTENSIBLE: Yeni faktor/seviye kombinasyonlari eklenebilir.
 */
function getFactorAction(factorName: string, level: 'critical' | 'high'): string {
  const actions: Record<string, Record<string, string>> = {
    mortalityTrend: {
      critical: 'Acil mortalite arastirmasi baslatın — ornek alin, su kalitesini kontrol edin',
      high: 'Mortalite nedenini arastirin — WQ verileri ve saglik kayitlarini inceleyin',
    },
    waterQualityDeviation: {
      critical: 'Acil su degisimi ve havalandirma artisi — WQ parametrelerini stabilize edin',
      high: 'WQ izleme sikligini artirin ve sapma nedenini arastirin',
    },
    tankDensity: {
      critical: 'Acil hasat veya tank bolme planlayinin — yogunlugu azaltın',
      high: 'Hasat planini one cekin veya ek tanka transfer dusunun',
    },
    activeHealthEvents: {
      critical: 'Veteriner danismanlik alin — tedavi protokolunu baslatın',
      high: 'Hasta bireyleri izole edin ve tedavi plani olusturun',
    },
    fcrDeviation: {
      critical: 'Yem kalitesini, besleme stratejisini ve balik sagligini gozden gecirin',
      high: 'Besleme programini optimize edin — israf azaltma onlemleri uygulayin',
    },
    overdueMaintenance: {
      critical: 'Geciken bakimlari derhal tamamlayinin — onceliklendirme yapin',
      high: 'Bakim takvimini guncelleyin ve acil bakim planlayinin',
    },
    weatherRisk: {
      critical: 'Acil durum protokolunu aktive edin — ekipman ve stok guvenligi',
      high: 'Hava durumunu yakindan izleyin ve onleyici tedbirler alin',
    },
  };

  return actions[factorName]?.[level]
    ?? 'Bu faktor icin uzman degerlendirmesi onerilir';
}
