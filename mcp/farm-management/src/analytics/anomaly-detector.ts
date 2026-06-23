// ============================================================================
// MCP Farm Intelligence Server — Anomali Tespit Motoru (Anomaly Detector)
// ============================================================================
//
// 9 farkli anomali turunu tespit eden cekirdek motor.
// Z-score analizi, esik karsilastirmasi ve trend analizi kullanir.
//
// NASIL CALISIR:
//   1. Her anomali turu icin ilgili veri serisi alinir (onceden cekilen veriler)
//   2. Z-score veya esik karsilastirmasi uygulanir:
//      - Z-score: Degerin ortalamadan kac standart sapma uzakta oldugunu olcer
//      - Esik: Degerin tur bazli min/max sinirlarini asip asmadigini kontrol eder
//   3. Trend analizi yapilir:
//      - Son 7 gunluk hareketli ortalama hesaplanir
//      - Egim hesaplanir → yukselen/dusen/stabil
//   4. Severity hesaplanir (low/medium/high/critical):
//      - z > 4 veya kritik esik → critical
//      - z > 3 veya yuksek esik → high
//      - z > 2 veya orta sapma → medium
//      - z > 1.5 veya hafif sapma → low
//
// ANOMALI TURLERI:
//   1. Mortalite sivrilemesi (mortality_spike)
//   2. Su kalitesi sapmasi (wq_deviation)
//   3. Buyume yavasiamasi (growth_slowdown)
//   4. FCR bozulmasi (fcr_degradation)
//   5. Besleme varyansı (feeding_variance)
//   6. Yogunluk asimi (density_overload)
//   7. Istah kaybi (appetite_loss)
//   8. Biofiltre stresi (biofilter_stress)
//   9. Geciken bakim (overdue_maintenance)
//
// EXTENSIBLE:
//   - Yeni anomali turleri eklemek icin:
//     1. AnomalyInput'a ilgili veri alanini ekleyin
//     2. detectXxx fonksiyonunu yazin
//     3. detectAnomalies icinde cagirin
//   - Severity esikleri konfigure edilebilir hale getirilebilir
// ============================================================================

import { getThresholds, type SpeciesThresholds } from '../knowledge/thresholds.js';
import { mean, stdDev, zScore, movingAverage, linearRegressionSlope, percentChange } from '../utils/stats.js';

// ── Tip Tanimlari ─────────────────────────────────────────────────────────────

/**
 * Anomali tespit motoru icin girdi verisi.
 *
 * Her alan opsiyoneldir — mevcut olan verilerle analiz yapilir.
 * Bu yaklasim "graceful degradation" saglar: verinin bir kismi
 * eksik olsa bile diger anomaliler hala tespit edilebilir.
 */
export interface AnomalyInput {
  /** Gunluk mortalite kayitlari — olum sayilari ve ilgili batch/tank bilgisi */
  mortalityRecords?: Array<{
    date: string;
    count: number;
    batchId: string;
    tankId?: string;
  }>;

  /**
   * Su kalitesi olcumleri — tum parametreler opsiyonel.
   * Her tank icin ayri olcumler gelebilir.
   */
  waterQualityMeasurements?: Array<{
    measuredAt: string;
    tankId: string;
    temperature?: number;
    ph?: number;
    dissolvedOxygen?: number;
    ammonia?: number;
    nitrite?: number;
    nitrate?: number;
  }>;

  /** Buyume olcumleri — ortalama agirlik ve spesifik buyume orani */
  growthMeasurements?: Array<{
    date: string;
    batchId: string;
    avgWeight: number;
    sgr?: number;
  }>;

  /**
   * Besleme kayitlari — planlanan ve gerceklesen yem miktarlari.
   * planned vs actual karsilastirmasi icin kullanilir.
   */
  feedingRecords?: Array<{
    date: string;
    batchId: string;
    tankId?: string;
    planned: number;
    actual: number;
  }>;

  /** Tank bilgileri — yogunluk ve kapasite hesabi icin */
  tanks?: Array<{
    id: string;
    name: string;
    currentBiomass: number;
    maxBiomass: number;
    volume: number;
    maxDensity: number;
  }>;

  /** Bakim takvimleri — geciken bakimlari tespit etmek icin */
  maintenanceSchedules?: Array<{
    id: string;
    dueDate: string;
    status: string;
    title: string;
  }>;

  /**
   * Tur bazli esik degerleri.
   * thresholds.ts'den getThresholds() ile elde edilir.
   * undefined ise varsayilan (default) esikler kullanilir.
   */
  speciesThresholds?: SpeciesThresholds;
}

/**
 * Tespit edilen tek bir anomali.
 *
 * Her anomali, ne oldugunu, nerede oldugunu, ne kadar ciddi oldugunu
 * ve trend bilgisini icerir.
 */
export interface Anomaly {
  /** Anomali turu — 'mortality_spike', 'wq_deviation', vb. */
  type: string;

  /**
   * Ciddiyet seviyesi:
   *   - 'low': z > 1.5 veya hafif sapma — izlenmeli
   *   - 'medium': z > 2 veya orta sapma — dikkat gerekli
   *   - 'high': z > 3 veya yuksek esik — mudahale onerilir
   *   - 'critical': z > 4 veya kritik esik — acil mudahale
   */
  severity: 'low' | 'medium' | 'high' | 'critical';

  /** Anomalinin tespit edildigi varlik (tank, batch, vb.) */
  entity: { type: string; id: string; name: string };

  /** Anomalinin ilgili metrigi (ornegin 'ammonia', 'mortality_rate') */
  metric: string;

  /** Mevcut deger */
  currentValue: number;

  /** Beklenen (normal) deger */
  expectedValue: number;

  /** Sapma miktari — z-score veya mutlak fark */
  deviation: number;

  /** Sapma yuzdesi — |mevcut - beklenen| / beklenen * 100 */
  deviationPercent: number;

  /** Anomalinin tespit zamani (ISO 8601) */
  timestamp: string;

  /**
   * Trend yonu:
   *   - 'rising': deger artmaya devam ediyor (kotulesme)
   *   - 'falling': deger dusmeye devam ediyor (kotulesme veya duzleme)
   *   - 'stable': deger sabit (ani olay veya stabilize)
   */
  trend: 'rising' | 'falling' | 'stable';

  /** Anomaliyle iliskili diger varliklar */
  relatedEntities: Array<{ type: string; id: string; name: string }>;

  /** Anomali tespitinin guven skoru (0-1) */
  confidence: number;
}

// ── Sabitler ─────────────────────────────────────────────────────────────────

/** Hareketli ortalama pencere boyutu (gun cinsinden) */
const MOVING_AVG_WINDOW = 7;


// ── Ana Fonksiyon ─────────────────────────────────────────────────────────────

/**
 * Tum anomali turlerini tespit eder ve birlestirilmis liste dondurur.
 *
 * NASIL CALISIR:
 *   1. Her anomali turu icin ilgili detect fonksiyonu cagirilir
 *   2. Fonksiyonlar sadece ilgili veri mevcutsa calisir (graceful degradation)
 *   3. Tum sonuclar tek bir Anomaly[] listesinde birlestirilir
 *   4. Severity'ye gore siralenir (critical > high > medium > low)
 *
 * @param input - Onceden cekilmis veri dizileri
 * @returns Tespit edilen anomalilerin listesi (severity'ye gore sirali)
 */
export function detectAnomalies(input: AnomalyInput): Anomaly[] {
  const thresholds = input.speciesThresholds ?? getThresholds();
  const anomalies: Anomaly[] = [];

  // ── 1. Mortalite sivrilemesi ───────────────────────────────
  if (input.mortalityRecords && input.mortalityRecords.length > 0) {
    anomalies.push(...detectMortalitySpike(input.mortalityRecords));
  }

  // ── 2. Su kalitesi sapmasi ─────────────────────────────────
  if (input.waterQualityMeasurements && input.waterQualityMeasurements.length > 0) {
    anomalies.push(...detectWQDeviation(input.waterQualityMeasurements, thresholds));
  }

  // ── 3. Buyume yavasiamasi ──────────────────────────────────
  if (input.growthMeasurements && input.growthMeasurements.length > 0) {
    anomalies.push(...detectGrowthSlowdown(input.growthMeasurements, thresholds));
  }

  // ── 4. FCR bozulmasi ───────────────────────────────────────
  if (input.feedingRecords && input.feedingRecords.length > 0 && input.growthMeasurements && input.growthMeasurements.length > 0) {
    anomalies.push(...detectFCRDegradation(input.feedingRecords, input.growthMeasurements, thresholds));
  }

  // ── 5. Besleme varyansi ────────────────────────────────────
  if (input.feedingRecords && input.feedingRecords.length > 0) {
    anomalies.push(...detectFeedingVariance(input.feedingRecords));
  }

  // ── 6. Yogunluk asimi ──────────────────────────────────────
  if (input.tanks && input.tanks.length > 0) {
    anomalies.push(...detectDensityOverload(input.tanks));
  }

  // ── 7. Istah kaybi ────────────────────────────────────────
  if (input.feedingRecords && input.feedingRecords.length > 0 && input.waterQualityMeasurements) {
    anomalies.push(...detectAppetiteLoss(input.feedingRecords, input.waterQualityMeasurements, thresholds));
  }

  // ── 8. Biofiltre stresi ────────────────────────────────────
  if (input.waterQualityMeasurements && input.waterQualityMeasurements.length > 0) {
    anomalies.push(...detectBiofilterStress(input.waterQualityMeasurements, thresholds));
  }

  // ── 9. Geciken bakim ───────────────────────────────────────
  if (input.maintenanceSchedules && input.maintenanceSchedules.length > 0) {
    anomalies.push(...detectOverdueMaintenance(input.maintenanceSchedules));
  }

  // ── Severity'ye gore sirala (en ciddi basta) ───────────────
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  anomalies.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));

  return anomalies;
}

// ── Alt Tespit Fonksiyonlari ─────────────────────────────────────────────────

/**
 * 1. Mortalite sivrilemesi tespiti.
 *
 * NASIL CALISIR:
 *   1. Gunluk mortalite sayilari cikarilir
 *   2. 7 gunluk hareketli ortalama hesaplanir
 *   3. Son gundeki mortalite icin z-score hesaplanir
 *   4. z > 2 ise mortalite sivrilemesi tespit edilir
 *   5. Batch bazinda gruplama yapilir — her batch ayri degerlendirilir
 *
 * Neden 7 gunluk hareketli ortalama?
 *   Balikcilikta gunluk mortalite dogal olarak dalgalanir (yem, hava durumu vb.).
 *   7 gunluk pencere bu normal dalgalanmalari yumusatir ve
 *   gercek sivrilemeler belirgin hale gelir.
 *
 * @param records - Mortalite kayitlari
 * @returns Tespit edilen mortalite anomalileri
 */
export function detectMortalitySpike(
  records: NonNullable<AnomalyInput['mortalityRecords']>,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // ── Batch bazinda gruplama ──────────────────────────────────
  // Her batch'in mortalite trendi bagimsiz degerlendirilir
  const byBatch = groupBy(records, r => r.batchId);

  for (const [batchId, batchRecords] of Object.entries(byBatch)) {
    // Tarihe gore sirala (eskiden yeniye)
    const sorted = [...batchRecords].sort((a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    // Gunluk mortalite sayilari
    const dailyCounts = sorted.map(r => r.count);

    // En az 3 gunluk veri gerekli (stdDev hesabi icin)
    if (dailyCounts.length < 3) continue;

    // 7 gunluk hareketli ortalama
    const ma = movingAverage(dailyCounts, MOVING_AVG_WINDOW);

    // Tum verinin ortalama ve standart sapmasi
    const avg = mean(dailyCounts);
    const sd = stdDev(dailyCounts);

    // Son gundeki mortalite
    const lastRecord = sorted[sorted.length - 1]!;
    const lastCount = lastRecord.count;

    // Z-score hesabi
    const z = zScore(lastCount, avg, sd);

    // Trend analizi: son 3 gunun egimi
    const recentCounts = dailyCounts.slice(-Math.min(3, dailyCounts.length));
    const trend = determineTrend(recentCounts);

    // Anomali esigi: |z| > 1.5
    if (Math.abs(z) > 1.5) {
      const lastMA = ma[ma.length - 1] ?? avg;
      const devPercent = lastMA > 0 ? Math.abs(lastCount - lastMA) / lastMA * 100 : 0;

      anomalies.push({
        type: 'mortality_spike',
        severity: calculateSeverityFromZ(z),
        entity: { type: 'batch', id: batchId, name: `Batch ${batchId}` },
        metric: 'daily_mortality_count',
        currentValue: lastCount,
        expectedValue: Math.round(lastMA * 100) / 100,
        deviation: Math.round(z * 100) / 100,
        deviationPercent: Math.round(devPercent * 100) / 100,
        timestamp: lastRecord.date,
        trend,
        relatedEntities: lastRecord.tankId
          ? [{ type: 'tank', id: lastRecord.tankId, name: `Tank ${lastRecord.tankId}` }]
          : [],
        confidence: calculateConfidenceFromN(dailyCounts.length),
      });
    }
  }

  return anomalies;
}

/**
 * 2. Su kalitesi sapmasi tespiti.
 *
 * NASIL CALISIR:
 *   1. Her tank icin en son olcumler alinir
 *   2. Her WQ parametresi tur bazli esiklerle karsilastirilir:
 *      - Sicaklik: min/max/criticalMin/criticalMax
 *      - pH: min/max
 *      - Cozunmus oksijen: min/critical
 *      - Amonyak: max/warning
 *      - Nitrit: max/warning
 *      - Nitrat: max/warning
 *   3. Esik asiminda anomali olusturulur
 *   4. Kritik esik asiminda severity = critical
 *
 * @param measurements - WQ olcumleri
 * @param thresholds - Tur bazli esik degerleri
 * @returns Tespit edilen WQ anomalileri
 */
export function detectWQDeviation(
  measurements: NonNullable<AnomalyInput['waterQualityMeasurements']>,
  thresholds: SpeciesThresholds,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // ── Tank bazinda gruplama ──────────────────────────────────
  const byTank = groupBy(measurements, m => m.tankId);

  for (const [tankId, tankMeasurements] of Object.entries(byTank)) {
    // Zamana gore sirala, en son olcumu al
    const sorted = [...tankMeasurements].sort((a, b) =>
      new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime(),
    );
    const latest = sorted[sorted.length - 1]!;

    // ── Sicaklik kontrolu ──────────────────────────────────
    if (latest.temperature !== undefined) {
      const temp = latest.temperature;
      const t = thresholds.temperature;

      // Kritik esikler (varsa)
      if (t.criticalMin !== undefined && temp < t.criticalMin) {
        anomalies.push(createWQAnomaly(
          tankId, 'temperature', temp, t.criticalMin, t.optimal, latest.measuredAt,
          'critical', sorted.map(m => m.temperature).filter((v): v is number => v !== undefined),
        ));
      } else if (t.criticalMax !== undefined && temp > t.criticalMax) {
        anomalies.push(createWQAnomaly(
          tankId, 'temperature', temp, t.criticalMax, t.optimal, latest.measuredAt,
          'critical', sorted.map(m => m.temperature).filter((v): v is number => v !== undefined),
        ));
      } else if (temp < t.min || temp > t.max) {
        // Normal aralik disi ama kritik degil
        const expected = temp < t.min ? t.min : t.max;
        const severity = Math.abs(temp - expected) > (t.max - t.min) * 0.5 ? 'high' : 'medium';
        anomalies.push(createWQAnomaly(
          tankId, 'temperature', temp, expected, t.optimal, latest.measuredAt,
          severity, sorted.map(m => m.temperature).filter((v): v is number => v !== undefined),
        ));
      }
    }

    // ── pH kontrolu ────────────────────────────────────────
    if (latest.ph !== undefined) {
      const ph = latest.ph;
      const p = thresholds.ph;
      if (ph < p.min || ph > p.max) {
        const expected = ph < p.min ? p.min : p.max;
        const deviation = Math.abs(ph - expected);
        const severity = deviation > 1.0 ? 'high' : deviation > 0.5 ? 'medium' : 'low';
        anomalies.push(createWQAnomaly(
          tankId, 'ph', ph, expected, p.optimal, latest.measuredAt,
          severity, sorted.map(m => m.ph).filter((v): v is number => v !== undefined),
        ));
      }
    }

    // ── Cozunmus oksijen kontrolu ──────────────────────────
    if (latest.dissolvedOxygen !== undefined) {
      const doVal = latest.dissolvedOxygen;
      const d = thresholds.dissolvedOxygen;
      if (doVal < d.critical) {
        anomalies.push(createWQAnomaly(
          tankId, 'dissolved_oxygen', doVal, d.critical, d.optimal, latest.measuredAt,
          'critical', sorted.map(m => m.dissolvedOxygen).filter((v): v is number => v !== undefined),
        ));
      } else if (doVal < d.min) {
        anomalies.push(createWQAnomaly(
          tankId, 'dissolved_oxygen', doVal, d.min, d.optimal, latest.measuredAt,
          'high', sorted.map(m => m.dissolvedOxygen).filter((v): v is number => v !== undefined),
        ));
      }
    }

    // ── Amonyak kontrolu ───────────────────────────────────
    if (latest.ammonia !== undefined) {
      const nh3 = latest.ammonia;
      const a = thresholds.ammonia;
      if (nh3 > a.max) {
        anomalies.push(createWQAnomaly(
          tankId, 'ammonia', nh3, a.max, a.warning, latest.measuredAt,
          'critical', sorted.map(m => m.ammonia).filter((v): v is number => v !== undefined),
        ));
      } else if (nh3 > a.warning) {
        anomalies.push(createWQAnomaly(
          tankId, 'ammonia', nh3, a.warning, a.warning * 0.5, latest.measuredAt,
          'medium', sorted.map(m => m.ammonia).filter((v): v is number => v !== undefined),
        ));
      }
    }

    // ── Nitrit kontrolu ────────────────────────────────────
    if (latest.nitrite !== undefined) {
      const no2 = latest.nitrite;
      const ni = thresholds.nitrite;
      if (no2 > ni.max) {
        anomalies.push(createWQAnomaly(
          tankId, 'nitrite', no2, ni.max, ni.warning, latest.measuredAt,
          'high', sorted.map(m => m.nitrite).filter((v): v is number => v !== undefined),
        ));
      } else if (no2 > ni.warning) {
        anomalies.push(createWQAnomaly(
          tankId, 'nitrite', no2, ni.warning, ni.warning * 0.5, latest.measuredAt,
          'medium', sorted.map(m => m.nitrite).filter((v): v is number => v !== undefined),
        ));
      }
    }

    // ── Nitrat kontrolu ────────────────────────────────────
    if (latest.nitrate !== undefined) {
      const no3 = latest.nitrate;
      const na = thresholds.nitrate;
      if (no3 > na.max) {
        anomalies.push(createWQAnomaly(
          tankId, 'nitrate', no3, na.max, na.warning, latest.measuredAt,
          'high', sorted.map(m => m.nitrate).filter((v): v is number => v !== undefined),
        ));
      } else if (no3 > na.warning) {
        anomalies.push(createWQAnomaly(
          tankId, 'nitrate', no3, na.warning, na.warning * 0.5, latest.measuredAt,
          'low', sorted.map(m => m.nitrate).filter((v): v is number => v !== undefined),
        ));
      }
    }
  }

  return anomalies;
}

/**
 * 3. Buyume yavasiamasi tespiti.
 *
 * NASIL CALISIR:
 *   1. Her batch icin SGR (Specific Growth Rate) zaman serisi alinir
 *   2. 7 gunluk hareketli ortalama SGR hesaplanir
 *   3. Son SGR degerinin hareketli ortalamadan %20'den fazla dusup dusmedigine bakilir
 *   4. Hedef SGR ile de karsilastirilir
 *
 * SGR Formulu: SGR = (ln(W2) - ln(W1)) / gun_sayisi * 100
 *   Ornek: 100g → 110g, 7 gunde: SGR = (ln(110)-ln(100))/7*100 = 1.36%/gun
 *
 * @param measurements - Buyume olcumleri
 * @param thresholds - Tur bazli esikler (targetSGR)
 * @returns Tespit edilen buyume anomalileri
 */
export function detectGrowthSlowdown(
  measurements: NonNullable<AnomalyInput['growthMeasurements']>,
  thresholds: SpeciesThresholds,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const byBatch = groupBy(measurements, m => m.batchId);

  for (const [batchId, batchMeasurements] of Object.entries(byBatch)) {
    const sorted = [...batchMeasurements].sort((a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    // SGR degerlerini topla — varsa direkt kullan, yoksa agirliktan hesapla
    const sgrValues: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const record = sorted[i]!;
      if (record.sgr !== undefined) {
        sgrValues.push(record.sgr);
      } else if (i > 0) {
        // SGR = (ln(W2) - ln(W1)) / gun_farki * 100
        const prev = sorted[i - 1]!;
        const daysDiff = (new Date(record.date).getTime() - new Date(prev.date).getTime()) / (1000 * 60 * 60 * 24);
        if (daysDiff > 0 && record.avgWeight > 0 && prev.avgWeight > 0) {
          const sgr = (Math.log(record.avgWeight) - Math.log(prev.avgWeight)) / daysDiff * 100;
          sgrValues.push(sgr);
        }
      }
    }

    if (sgrValues.length < 3) continue;

    // 7 gunluk hareketli ortalama
    const ma = movingAverage(sgrValues, MOVING_AVG_WINDOW);
    const currentSGR = sgrValues[sgrValues.length - 1]!;
    const avgSGR = ma[ma.length - 1] ?? mean(sgrValues);

    // %20'den fazla dusus kontrolu
    const dropPercent = avgSGR > 0 ? ((avgSGR - currentSGR) / avgSGR) * 100 : 0;

    if (dropPercent > 20) {
      const targetSGR = thresholds.targetSGR ?? 1.5;
      const trend = determineTrend(sgrValues.slice(-3));

      anomalies.push({
        type: 'growth_slowdown',
        severity: dropPercent > 50 ? 'high' : dropPercent > 35 ? 'medium' : 'low',
        entity: { type: 'batch', id: batchId, name: `Batch ${batchId}` },
        metric: 'sgr',
        currentValue: Math.round(currentSGR * 1000) / 1000,
        expectedValue: Math.round(avgSGR * 1000) / 1000,
        deviation: Math.round(dropPercent * 100) / 100,
        deviationPercent: Math.round(dropPercent * 100) / 100,
        timestamp: sorted[sorted.length - 1]!.date,
        trend: trend === 'rising' ? 'falling' : trend, // SGR dusuyorsa "buyume yavasiamasi" artiyor
        relatedEntities: [],
        confidence: calculateConfidenceFromN(sgrValues.length),
      });
    }
  }

  return anomalies;
}

/**
 * 4. FCR bozulmasi tespiti.
 *
 * NASIL CALISIR:
 *   1. Toplam yem miktari ve toplam buyume hesaplanir
 *   2. FCR = toplam_yem / toplam_buyume
 *   3. Hesaplanan FCR, hedef FCR ile karsilastirilir
 *   4. %15'ten fazla sapma → anomali
 *
 * FCR (Feed Conversion Ratio):
 *   FCR = verilen_yem_kg / canli_agirlik_artisi_kg
 *   Dusuk FCR = verimli (az yemle cok buyume)
 *   Yuksek FCR = verimsiz (cok yemle az buyume)
 *
 * @param feedingRecords - Besleme kayitlari
 * @param growthMeasurements - Buyume olcumleri
 * @param thresholds - Tur bazli esikler (targetFCR)
 * @returns Tespit edilen FCR anomalileri
 */
export function detectFCRDegradation(
  feedingRecords: NonNullable<AnomalyInput['feedingRecords']>,
  growthMeasurements: NonNullable<AnomalyInput['growthMeasurements']>,
  thresholds: SpeciesThresholds,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const targetFCR = thresholds.targetFCR;

  // Batch bazinda gruplama
  const feedByBatch = groupBy(feedingRecords, r => r.batchId);
  const growthByBatch = groupBy(growthMeasurements, m => m.batchId);

  for (const [batchId, batchFeeding] of Object.entries(feedByBatch)) {
    const batchGrowth = growthByBatch[batchId];
    if (!batchGrowth || batchGrowth.length < 2) continue;

    // Toplam gercek yem miktari
    const totalFeed = batchFeeding.reduce((sum, r) => sum + r.actual, 0);
    if (totalFeed <= 0) continue;

    // Toplam buyume (son agirlik - ilk agirlik)
    const sortedGrowth = [...batchGrowth].sort((a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    const firstWeight = sortedGrowth[0]!.avgWeight;
    const lastWeight = sortedGrowth[sortedGrowth.length - 1]!.avgWeight;
    const weightGain = lastWeight - firstWeight;

    if (weightGain <= 0) continue; // Buyume yoksa FCR hesaplanamaz

    // FCR hesabi
    const calculatedFCR = totalFeed / weightGain;

    // Hedeften sapma
    const deviationPercent = ((calculatedFCR - targetFCR) / targetFCR) * 100;

    // %15'ten fazla kotu sapma → anomali
    if (deviationPercent > 15) {
      anomalies.push({
        type: 'fcr_degradation',
        severity: deviationPercent > 50 ? 'high' : deviationPercent > 30 ? 'medium' : 'low',
        entity: { type: 'batch', id: batchId, name: `Batch ${batchId}` },
        metric: 'fcr',
        currentValue: Math.round(calculatedFCR * 100) / 100,
        expectedValue: targetFCR,
        deviation: Math.round((calculatedFCR - targetFCR) * 100) / 100,
        deviationPercent: Math.round(deviationPercent * 100) / 100,
        timestamp: sortedGrowth[sortedGrowth.length - 1]!.date,
        trend: 'stable', // FCR kumulatif bir deger, trend analizi farkli yapilir
        relatedEntities: [],
        confidence: calculateConfidenceFromN(batchFeeding.length),
      });
    }
  }

  return anomalies;
}

/**
 * 5. Besleme varyansi tespiti.
 *
 * NASIL CALISIR:
 *   1. Her besleme kaydinda actual/planned orani hesaplanir
 *   2. Oran < 0.7 veya > 1.3 ise anomali (planlananin %30'undan fazla sapma)
 *   3. Gunluk bazda gruplama yapilir — ayni gundeki birden fazla sapma bilestirilir
 *
 * Neden 0.7 ve 1.3?
 *   - < 0.7: Baliklar planlananin %70'inden azini yedi → istah sorunu olabilir
 *   - > 1.3: Planlananin %30'undan fazla verildi → asiri besleme riski
 *   - Dogal olarak %10-20 varyans normaldir (hava durumu, gunluk ritim)
 *
 * @param records - Besleme kayitlari
 * @returns Tespit edilen besleme varyansi anomalileri
 */
export function detectFeedingVariance(
  records: NonNullable<AnomalyInput['feedingRecords']>,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  for (const record of records) {
    if (record.planned <= 0) continue; // Planlanan sifirsa oran anlamsiz

    const ratio = record.actual / record.planned;

    // %30'dan fazla sapma kontrolu
    if (ratio < 0.7 || ratio > 1.3) {
      const deviationPct = Math.abs(1 - ratio) * 100;
      const isUnderFeeding = ratio < 1;

      anomalies.push({
        type: 'feeding_variance',
        severity: ratio < 0.5 || ratio > 1.5 ? 'high' : 'medium',
        entity: {
          type: 'batch',
          id: record.batchId,
          name: `Batch ${record.batchId}`,
        },
        metric: isUnderFeeding ? 'feeding_deficit' : 'feeding_excess',
        currentValue: Math.round(record.actual * 100) / 100,
        expectedValue: Math.round(record.planned * 100) / 100,
        deviation: Math.round((record.actual - record.planned) * 100) / 100,
        deviationPercent: Math.round(deviationPct * 100) / 100,
        timestamp: record.date,
        trend: 'stable', // Tek nokta — trend belirlenemez
        relatedEntities: record.tankId
          ? [{ type: 'tank', id: record.tankId, name: `Tank ${record.tankId}` }]
          : [],
        confidence: 0.8, // Tek kayit bazinda yuksek kesinlik ama bag bolam yok
      });
    }
  }

  return anomalies;
}

/**
 * 6. Yogunluk asimi tespiti.
 *
 * NASIL CALISIR:
 *   1. Her tank icin mevcut yogunluk hesaplanir: currentBiomass / volume (kg/m3)
 *   2. Hesaplanan yogunluk / maxDensity orani alinir
 *   3. Oran > 0.9 ise yogunluk asimi anomalisi olusturulur
 *
 * Neden 0.9 esigi?
 *   Maksimum yogunlugun %90'ina ulasilmissa:
 *   - WQ cok hizli bozulabilir (amonyak birikimi)
 *   - Stres kaynaklı hastalik riski dramatik artar
 *   - Oksijen tuketimi kapasiteye yaklasir
 *   Bu nedenle %90'da erken uyari verilir, %100'e gelmesi beklenmez.
 *
 * @param tanks - Tank bilgileri
 * @returns Tespit edilen yogunluk anomalileri
 */
export function detectDensityOverload(
  tanks: NonNullable<AnomalyInput['tanks']>,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  for (const tank of tanks) {
    if (tank.volume <= 0 || tank.maxDensity <= 0) continue;

    // Mevcut yogunluk: biyokütle / hacim
    const currentDensity = tank.currentBiomass / tank.volume;

    // Yogunluk orani: mevcut / maksimum
    const densityRatio = currentDensity / tank.maxDensity;

    if (densityRatio > 0.9) {
      const deviationPct = (densityRatio - 0.9) / 0.1 * 100; // %90'dan ne kadar fazla

      anomalies.push({
        type: 'density_overload',
        severity: densityRatio > 1.0 ? 'critical' : densityRatio > 0.95 ? 'high' : 'medium',
        entity: { type: 'tank', id: tank.id, name: tank.name },
        metric: 'stocking_density',
        currentValue: Math.round(currentDensity * 100) / 100,
        expectedValue: Math.round(tank.maxDensity * 0.9 * 100) / 100, // %90 esigi
        deviation: Math.round((currentDensity - tank.maxDensity * 0.9) * 100) / 100,
        deviationPercent: Math.round(deviationPct * 100) / 100,
        timestamp: new Date().toISOString(),
        trend: 'stable', // Anlik deger — trend icin gecmis veri gerekir
        relatedEntities: [],
        confidence: 0.95, // Yogunluk hesabi direkt biyokutleye dayali, cok kesin
      });
    }
  }

  return anomalies;
}

/**
 * 7. Istah kaybi tespiti.
 *
 * NASIL CALISIR:
 *   1. Besleme kayitlarinda actual << planned (oran < 0.6) olan kayitlar bulunur
 *   2. Ayni tank/batch icin esanli WQ sapmasi aranir
 *   3. Hem besleme dususu HEM WQ sapmasi varsa → istah kaybi anomalisi
 *
 * Neden sadece besleme dususu degil de WQ ile birlestiriyoruz?
 *   Besleme dususunun bircok nedeni olabilir:
 *   - Operasyonel hata (yanlis tartim)
 *   - Hasat oncesi aclık
 *   - Gercek istah kaybi
 *   WQ sapmasi ile birlestiginde gercek istah kaybi olasiligi cok daha yuksek.
 *
 * @param feedingRecords - Besleme kayitlari
 * @param wqMeasurements - WQ olcumleri
 * @param thresholds - Tur bazli esikler
 * @returns Tespit edilen istah kaybi anomalileri
 */
export function detectAppetiteLoss(
  feedingRecords: NonNullable<AnomalyInput['feedingRecords']>,
  wqMeasurements: NonNullable<AnomalyInput['waterQualityMeasurements']>,
  thresholds: SpeciesThresholds,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // ── Pre-index WQ measurements by tankId for O(1) lookup ──────────
  // BEFORE: for each low-feeding record, wqMeasurements.filter() scanned ALL
  //         measurements → O(n×m) quadratic at scale (500 tanks × 100 records).
  // AFTER:  Map<tankId, WQMeasurement[]> built once, lookup is O(1) per tank.
  const wqByTank = new Map<string, typeof wqMeasurements>();
  for (const wq of wqMeasurements) {
    const existing = wqByTank.get(wq.tankId);
    if (existing) {
      existing.push(wq);
    } else {
      wqByTank.set(wq.tankId, [wq]);
    }
  }

  // Dusuk besleme kayitlarini bul (actual/planned < 0.6)
  const lowFeeding = feedingRecords.filter(r => r.planned > 0 && r.actual / r.planned < 0.6);

  for (const record of lowFeeding) {
    const feedDate = new Date(record.date).getTime();

    // Son 24 saat icindeki WQ olcumlerini bul (ayni tank veya genel)
    // O(1) tank lookup via pre-built Map instead of O(m) full scan
    const candidateWQ = record.tankId !== undefined
      ? (wqByTank.get(record.tankId) ?? [])
      : wqMeasurements; // tankId yoksa tum olcumlere bak (nadir durum)
    const recentWQ = candidateWQ.filter(m => {
      const wqTime = new Date(m.measuredAt).getTime();
      const hoursDiff = Math.abs(feedDate - wqTime) / (1000 * 60 * 60);
      return hoursDiff <= 24;
    });

    if (recentWQ.length === 0) continue;

    // WQ sapmasi var mi? (herhangi bir parametre esik disinda)
    let hasWQDeviation = false;
    const wqIssues: string[] = [];

    for (const wq of recentWQ) {
      if (wq.ammonia !== undefined && wq.ammonia > thresholds.ammonia.warning) {
        hasWQDeviation = true;
        wqIssues.push('ammonia');
      }
      if (wq.dissolvedOxygen !== undefined && wq.dissolvedOxygen < thresholds.dissolvedOxygen.min) {
        hasWQDeviation = true;
        wqIssues.push('dissolved_oxygen');
      }
      if (wq.temperature !== undefined && (wq.temperature < thresholds.temperature.min || wq.temperature > thresholds.temperature.max)) {
        hasWQDeviation = true;
        wqIssues.push('temperature');
      }
      if (wq.ph !== undefined && (wq.ph < thresholds.ph.min || wq.ph > thresholds.ph.max)) {
        hasWQDeviation = true;
        wqIssues.push('ph');
      }
    }

    // Hem besleme dususu HEM WQ sapmasi → istah kaybi
    if (hasWQDeviation) {
      const ratio = record.actual / record.planned;

      anomalies.push({
        type: 'appetite_loss',
        severity: ratio < 0.3 ? 'high' : 'medium',
        entity: { type: 'batch', id: record.batchId, name: `Batch ${record.batchId}` },
        metric: 'feed_consumption_ratio',
        currentValue: Math.round(ratio * 100) / 100,
        expectedValue: 1.0,
        deviation: Math.round((1 - ratio) * 100) / 100,
        deviationPercent: Math.round((1 - ratio) * 100 * 100) / 100,
        timestamp: record.date,
        trend: 'falling',
        relatedEntities: [
          ...wqIssues.map(issue => ({ type: 'parameter', id: issue, name: issue })),
          ...(record.tankId ? [{ type: 'tank', id: record.tankId, name: `Tank ${record.tankId}` }] : []),
        ],
        confidence: 0.85, // WQ + besleme birlesimi yuksek guvenilirlik saglar
      });
    }
  }

  return anomalies;
}

/**
 * 8. Biofiltre stresi tespiti.
 *
 * NASIL CALISIR:
 *   1. Her tank icin NH3 ve NO2 zaman serisi cikarilir
 *   2. Her iki parametre de esanli olarak yukseliyorsa → biofiltre stresi
 *   3. NH3 yukselme + NO2 yukselme = nitrifikasyon bakterileri yetersiz
 *
 * Biyolojik arkaplan:
 *   Biofiltre (nitrifikasyon) sureci: NH3 → NO2 → NO3
 *   - Nitrosomonas bakterileri NH3'u NO2'ye cevirir
 *   - Nitrobacter bakterileri NO2'yi NO3'e cevirir
 *   - Her iki ara urun de (NH3, NO2) ESANLI yukseliyorsa:
 *     Ya biofiltre kapasitesi asılmis ya da bakteri populasyonu zarar gormis
 *   - Bu cok tehlikeli bir durumdur — her ikisi de toksik
 *
 * @param measurements - WQ olcumleri
 * @param thresholds - Tur bazli esikler
 * @returns Tespit edilen biofiltre stresi anomalileri
 */
export function detectBiofilterStress(
  measurements: NonNullable<AnomalyInput['waterQualityMeasurements']>,
  thresholds: SpeciesThresholds,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const byTank = groupBy(measurements, m => m.tankId);

  for (const [tankId, tankMeasurements] of Object.entries(byTank)) {
    const sorted = [...tankMeasurements].sort((a, b) =>
      new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime(),
    );

    // NH3 ve NO2 zaman serileri
    const nh3Values = sorted.map(m => m.ammonia).filter((v): v is number => v !== undefined);
    const no2Values = sorted.map(m => m.nitrite).filter((v): v is number => v !== undefined);

    // Her ikisi de en az 3 veri noktasi olmali
    if (nh3Values.length < 3 || no2Values.length < 3) continue;

    // Trend analizi — son 3 degerin egimi
    const nh3Recent = nh3Values.slice(-3);
    const no2Recent = no2Values.slice(-3);
    const nh3Trend = determineTrend(nh3Recent);
    const no2Trend = determineTrend(no2Recent);

    // Her ikisi de yukseliyorsa → biofiltre stresi
    if (nh3Trend === 'rising' && no2Trend === 'rising') {
      const lastNH3 = nh3Values[nh3Values.length - 1]!;
      const lastNO2 = no2Values[no2Values.length - 1]!;

      // Severity: esik asimina gore
      let severity: Anomaly['severity'] = 'medium';
      if (lastNH3 > thresholds.ammonia.max || lastNO2 > thresholds.nitrite.max) {
        severity = 'critical';
      } else if (lastNH3 > thresholds.ammonia.warning || lastNO2 > thresholds.nitrite.warning) {
        severity = 'high';
      }

      anomalies.push({
        type: 'biofilter_stress',
        severity,
        entity: { type: 'tank', id: tankId, name: `Tank ${tankId}` },
        metric: 'nh3_no2_concurrent_rise',
        currentValue: lastNH3, // NH3 degeri (birincil metrik)
        expectedValue: thresholds.ammonia.warning,
        deviation: lastNH3 - thresholds.ammonia.warning,
        deviationPercent: thresholds.ammonia.warning > 0
          ? Math.round((lastNH3 - thresholds.ammonia.warning) / thresholds.ammonia.warning * 100 * 100) / 100
          : 0,
        timestamp: sorted[sorted.length - 1]!.measuredAt,
        trend: 'rising',
        relatedEntities: [
          { type: 'parameter', id: 'nitrite', name: `NO2: ${lastNO2} mg/L` },
        ],
        confidence: calculateConfidenceFromN(Math.min(nh3Values.length, no2Values.length)),
      });
    }
  }

  return anomalies;
}

/**
 * 9. Geciken bakim tespiti.
 *
 * NASIL CALISIR:
 *   1. Tum bakim takvimlerinde status != 'completed' olanlara bakilir
 *   2. dueDate gecmis olanlari filtrelenir
 *   3. Gecikme suresi hesaplanir
 *   4. Gecikme suresi ve geciken bakim sayisina gore severity belirlenir
 *
 * Neden bakim gecikmesi anomali sayilir?
 *   - Filter temizligi gecikmesi → WQ bozulmasi
 *   - Aerator bakimi gecikmesi → DO dususu
 *   - Jenerator bakimi gecikmesi → elektrik kesintisi riski
 *   Bakim gecikmeleri "sessiz tehlikeler"dir — anlik etki yaratmaz
 *   ama baska anomalilerin tetikleyicisi olabilir.
 *
 * @param schedules - Bakim takvimleri
 * @returns Tespit edilen geciken bakim anomalileri
 */
export function detectOverdueMaintenance(
  schedules: NonNullable<AnomalyInput['maintenanceSchedules']>,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const now = Date.now();

  // Tamamlanmamis ve tarihi gecmis bakimlar
  const overdue = schedules.filter(s => {
    const isIncomplete = s.status !== 'completed' && s.status !== 'cancelled';
    const isPastDue = new Date(s.dueDate).getTime() < now;
    return isIncomplete && isPastDue;
  });

  for (const schedule of overdue) {
    const dueTime = new Date(schedule.dueDate).getTime();
    const delayHours = (now - dueTime) / (1000 * 60 * 60);
    const delayDays = Math.round(delayHours / 24 * 10) / 10;

    // Severity: gecikme suresine gore
    // 7+ gun gecikme → critical, 3-7 gun → high, 1-3 gun → medium, <1 gun → low
    let severity: Anomaly['severity'] = 'low';
    if (delayDays > 7) severity = 'critical';
    else if (delayDays > 3) severity = 'high';
    else if (delayDays > 1) severity = 'medium';

    anomalies.push({
      type: 'overdue_maintenance',
      severity,
      entity: { type: 'maintenance', id: schedule.id, name: schedule.title },
      metric: 'delay_days',
      currentValue: delayDays,
      expectedValue: 0, // Beklenen gecikme: 0 gun
      deviation: delayDays,
      deviationPercent: 100, // Tanimsal olarak %100 gecikme (zamaninda yapilmadi)
      timestamp: schedule.dueDate,
      trend: 'rising', // Gecikme her gun artar
      relatedEntities: [],
      confidence: 1.0, // Bakim gecikme tespiti kesindir — belirsizlik yok
    });
  }

  return anomalies;
}

// ── Yardimci Fonksiyonlar ─────────────────────────────────────────────────────

/**
 * Z-score'a dayali severity hesaplar.
 *
 * NASIL CALISIR:
 *   |z| > 4   → critical (cok nadir, acil durum)
 *   |z| > 3   → high (istatistiksel olarak cok olagandisi)
 *   |z| > 2   → medium (%95 guven araligi disi)
 *   |z| > 1.5 → low (izlenmeli)
 *   |z| <= 1.5 → degerlendirme disi (bu fonksiyona gelmemeli)
 *
 * @param z - Z-score degeri
 * @returns Severity seviyesi
 */
function calculateSeverityFromZ(z: number): Anomaly['severity'] {
  const absZ = Math.abs(z);
  if (absZ > 4) return 'critical';
  if (absZ > 3) return 'high';
  if (absZ > 2) return 'medium';
  return 'low';
}

/**
 * Orneklem buyuklugune dayali guven skoru hesaplar.
 *
 * Basit heuristik:
 *   n >= 30 → 0.95 (merkezi limit teoremi gecerli)
 *   n >= 10 → 0.7 + (n-10)/20 * 0.25 (kademeli artis)
 *   n >= 3  → 0.3 + (n-3)/7 * 0.4 (dusuk ama degerlendirebilir)
 *   n < 3   → 0.2 (cok dusuk)
 *
 * @param n - Orneklem buyuklugu
 * @returns Guven skoru (0-1)
 */
function calculateConfidenceFromN(n: number): number {
  if (n >= 30) return 0.95;
  if (n >= 10) return 0.7 + ((n - 10) / 20) * 0.25;
  if (n >= 3) return 0.3 + ((n - 3) / 7) * 0.4;
  return 0.2;
}

/**
 * Sayi dizisinin trendini belirler.
 *
 * NASIL CALISIR:
 *   1. Lineer regresyon eğimi hesaplanir (x = indeks, y = deger)
 *   2. Egim > esik → rising (artis trendi)
 *   3. Egim < -esik → falling (dusus trendi)
 *   4. Aksi halde → stable
 *
 * Esik degeri: ortalama degerin %5'i
 *   Bu, cok kucuk dalgalanmalarin "trend" olarak isaretlenmesini onler.
 *
 * @param values - Son n degerin dizisi (kronolojik sira)
 * @returns Trend yonu
 */
function determineTrend(values: number[]): Anomaly['trend'] {
  if (values.length < 2) return 'stable';

  // x = indeksler [0, 1, 2, ...]
  const x = values.map((_, i) => i);
  const slope = linearRegressionSlope(x, values);

  // Esik: ortalama degerin %5'i (cok kucuk degisimler filtrelenir)
  const avg = mean(values);
  const threshold = Math.abs(avg) * 0.05;

  if (slope > threshold) return 'rising';
  if (slope < -threshold) return 'falling';
  return 'stable';
}

/**
 * WQ anomalisi olusturma yardimcisi.
 *
 * Tekrarlayan WQ anomali olusturma kodunu merkeziler.
 *
 * @param tankId - Tank kimlik bilgisi
 * @param metric - WQ metrigi adi
 * @param currentValue - Mevcut deger
 * @param expectedValue - Beklenen (esik) deger
 * @param optimalValue - Optimal deger
 * @param timestamp - Olcum zamani
 * @param severity - Ciddiyet seviyesi
 * @param historicalValues - Gecmis degerler (trend analizi icin)
 * @returns Anomaly nesnesi
 */
function createWQAnomaly(
  tankId: string,
  metric: string,
  currentValue: number,
  expectedValue: number,
  optimalValue: number,
  timestamp: string,
  severity: Anomaly['severity'],
  historicalValues: number[],
): Anomaly {
  const deviation = currentValue - expectedValue;
  const deviationPct = expectedValue !== 0
    ? Math.abs(deviation) / Math.abs(expectedValue) * 100
    : 0;

  return {
    type: 'wq_deviation',
    severity,
    entity: { type: 'tank', id: tankId, name: `Tank ${tankId}` },
    metric,
    currentValue: Math.round(currentValue * 10000) / 10000,
    expectedValue,
    deviation: Math.round(deviation * 10000) / 10000,
    deviationPercent: Math.round(deviationPct * 100) / 100,
    timestamp,
    trend: determineTrend(historicalValues.slice(-3)),
    relatedEntities: [],
    confidence: calculateConfidenceFromN(historicalValues.length),
  };
}

/**
 * Dizi elemanlarini bir anahtar fonksiyonuna gore gruplar.
 *
 * Array.prototype.groupBy henuz tum ortamlarda mevcut olmadigi icin
 * kendi implementasyonumuz. Object.groupBy ES2024'te eklendi ama
 * ES2022 hedefledigimiz icin bu yardimci gerekli.
 *
 * @param items - Gruplanacak elemanlar
 * @param keyFn - Her elemandan grup anahtari ureten fonksiyon
 * @returns Anahtar → eleman dizisi eslesmesi
 */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    const group = (groups[key] ??= []);
    group.push(item);
  }
  return groups;
}
