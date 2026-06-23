// ============================================================================
// MCP Farm Intelligence Server — Korelasyon Analiz Motoru (Correlator)
// ============================================================================
//
// Iki zaman serisi arasindaki Pearson korelasyonunu hesaplar ve
// zaman gecikmesi (time lag) ile eslestirme yapar.
//
// NASIL CALISIR:
//   1. Iki domain'den zaman serisi verileri alinir
//      (ornegin: sicaklik zaman serisi + mortalite zaman serisi)
//   2. Zaman bazli eslestirme yapilir:
//      - Verileri saat veya gun bazinda gruplama (bucketing)
//      - Ayni zaman dilimindeki degerleri ortalama ile birlestirme
//   3. Farkli lag degerleri denenir (0h, 6h, 12h, 24h, 48h):
//      - Soru: "Sicaklik degisimi mortaliteyi kac saat sonra etkiler?"
//      - Her lag degeri icin korelasyon hesaplanir
//      - En yuksek |r| veren lag secilir
//   4. Secilen lag icin:
//      - Pearson r katsayisi
//      - p-value (istatistiksel anlamlilik)
//      - %95 guven araligi
//      - Korelasyon gucu ve yonu
//      hesaplanir
//   5. Onemli olaylar (events) tanilanir — korelasyonun en belirgin
//      oldugu zaman noktalarini gosterir
//
// AKVAKULTURDEKI KULLANIM ORNEKLERI:
//   - Sicaklik ↔ Mortalite: +24h lag, pozitif korelasyon
//     (sicaklik arttiktan 24 saat sonra mortalite artar)
//   - pH ↔ Amonyak: -6h lag, negatif korelasyon
//     (pH dustukten 6 saat sonra amonyak artar, cunku NH4+ → NH3 dengesinde
//      pH artisi NH3 fraksiyonunu arttirir — TERS etki!)
//   - Yem tuketimi ↔ Buyume: +48h lag, pozitif korelasyon
//     (yem artisi buyumeye 2 gunde yansir)
//
// EXTENSIBLE:
//   - Yeni lag degerleri dizisi verilebilir (maxLagHours parametresi)
//   - intervalHours degistirilerek saatlik veya gunluk gruplama secilir
//   - Bilinen iliskiler (knownRelationship) haricinden de eklenebilir
// ============================================================================

import {
  pearsonCorrelation,
  correlationPValue,
  correlationConfidenceInterval,
  mean,
} from '../utils/stats.js';

// ── Tip Tanimlari ─────────────────────────────────────────────────────────────

/**
 * Zaman serisi veri noktasi.
 *
 * Tek bir olcum anini ve degerini temsil eder.
 * timestamp ISO 8601 formatinda olmalidir.
 */
export interface TimeSeriesPoint {
  timestamp: string;
  value: number;
}

/**
 * Korelasyon analizi sonucu.
 *
 * Iki zaman serisi arasindaki iliskiyi detayli olarak raporlar.
 */
export interface CorrelationResult {
  /** A serisi bilgisi — isim, metrik ve kullanilan degerler */
  domainA: { name: string; metric: string; values: number[] };

  /** B serisi bilgisi — isim, metrik ve kullanilan degerler */
  domainB: { name: string; metric: string; values: number[] };

  /**
   * Pearson korelasyon katsayisi: -1 ile +1 arasi.
   *   +1 = tam pozitif (birlikte artarlar)
   *    0 = korelasyon yok
   *   -1 = tam negatif (biri artarken digeri azalir)
   */
  coefficient: number;

  /**
   * Korelasyon gucu:
   *   |r| < 0.3  → 'weak' (zayif — pratik anlamda onemli olmayabilir)
   *   0.3 ≤ |r| < 0.7 → 'moderate' (orta — iliskiyi gosterir ama kesin degil)
   *   |r| ≥ 0.7  → 'strong' (guclu — anlamli iliski)
   */
  strength: 'weak' | 'moderate' | 'strong';

  /** Korelasyon yonu: r > 0 → 'positive', r < 0 → 'negative' */
  direction: 'positive' | 'negative';

  /** p-value: korelasyonun rastgele olma olasiligi (0-1) */
  pValue: number;

  /**
   * %95 guven araligi.
   * "Gercek korelasyonun %95 olasilikla bu aralikta oldugunu"
   * ifade eder. Dar aralik = kesin, genis aralik = belirsiz.
   */
  confidenceInterval95: { lower: number; upper: number };

  /** Optimal zaman gecikmesi (saat). 0 = esanli iliski */
  timeLagHours: number;

  /** Istatistiksel anlamlilik: p < 0.05 ise true */
  significance: boolean;

  /** Eslestirilen veri cifti sayisi */
  sampleSize: number;

  /**
   * Bilinen iliski aciklamasi (varsa).
   * Ornegin: "Sicaklik artisi NH3 toksisitesini arttirir (pH efekti)"
   */
  knownRelationship?: string;

  /**
   * Korelasyonun en belirgin oldugu olaylar.
   * Her olay, iki serideki esanli degisimleri gosterir.
   */
  events: Array<{
    timestampA: string;
    valueA: number;
    timestampB: string;
    valueB: number;
    description: string;
  }>;

  /** Uyari mesaji (orneklem kucukse, esik sinirindaysa vb.) */
  warning?: string;
}

// ── Sabitler ─────────────────────────────────────────────────────────────────

/**
 * Varsayilan lag degerleri (saat).
 *
 * Neden bu degerler?
 *   0h  = Esanli iliski (ornegin pH ↔ NH3 kimyasal denge, anlik)
 *   6h  = Kisa vadeli gecikme (ornegin yem → metabolik tepki)
 *   12h = Yarim gun gecikme (ornegin WQ bozulmasi → stres belirtileri)
 *   24h = 1 gun gecikme (ornegin sicaklik → mortalite)
 *   48h = 2 gun gecikme (ornegin yem degisikligi → buyume etkisi)
 *
 * EXTENSIBLE: Farkli lag dizileri findOptimalLag fonksiyonuna verilebilir.
 */
const DEFAULT_LAGS = [0, 6, 12, 24, 48];

/**
 * Varsayilan gruplama araligi (saat).
 *
 * Neden 1 saat?
 *   - Su kalitesi olcumleri genelde saatlik yapilir
 *   - 1 saatlik gruplama hem yeterli cozunurluk saglar hem de
 *     farkli zamanlarda gelen olcumleri eslestirir
 *   - Gunluk gruplama (24h) icin intervalHours = 24 verilebilir
 */
const DEFAULT_INTERVAL_HOURS = 1;

// ── Ana Fonksiyon ─────────────────────────────────────────────────────────────

/**
 * Iki zaman serisi arasindaki korelasyonu hesaplar.
 *
 * NASIL CALISIR:
 *   1. Optimal lag bulunur (en yuksek |r| veren gecikme suresi)
 *   2. Seriler optimal lag ile hizalanir (bucketing + lag offset)
 *   3. Pearson r, p-value, guven araligi hesaplanir
 *   4. Korelasyon gucu ve yonu belirlenir
 *   5. Onemli olaylar (events) tanilanir
 *   6. Uyari mesajlari eklenir (gerekirse)
 *
 * @param seriesA - Birinci zaman serisi (ornegin sicaklik)
 * @param seriesB - Ikinci zaman serisi (ornegin mortalite)
 * @param maxLagHours - Denenecek maksimum lag (saat). Varsayilan: 48
 * @returns Detayli korelasyon sonucu
 */
export function correlateTimeSeries(
  seriesA: TimeSeriesPoint[],
  seriesB: TimeSeriesPoint[],
  maxLagHours = 48,
): CorrelationResult {
  // ── Bos seri kontrolu ──────────────────────────────────────
  if (seriesA.length === 0 || seriesB.length === 0) {
    return createEmptyResult(seriesA, seriesB, 'Zaman serilerinden biri veya ikisi bos');
  }

  // ── Adim 1: Optimal lag bul ────────────────────────────────
  // Denenecek lag degerleri: 0'dan maxLagHours'a kadar DEFAULT_LAGS'tan filtrele
  const lags = DEFAULT_LAGS.filter(l => l <= maxLagHours);
  const { lag: optimalLag, r: bestR } = findOptimalLag(seriesA, seriesB, lags);

  // ── Adim 2: Serileri hizala ────────────────────────────────
  const { a: alignedA, b: alignedB } = alignTimeSeries(seriesA, seriesB, optimalLag);

  // Yeterli eslesen nokta var mi?
  const n = alignedA.length;
  if (n < 3) {
    return createEmptyResult(seriesA, seriesB,
      `Hizalama sonrasi yeterli eslesen nokta yok (n=${n}). En az 3 gerekli.`,
    );
  }

  // ── Adim 3: Korelasyon hesapla ─────────────────────────────
  const r = pearsonCorrelation(alignedA, alignedB);
  const pValue = correlationPValue(r, n);
  const ci95 = correlationConfidenceInterval(r, n);

  // ── Adim 4: Guc ve yon ────────────────────────────────────
  const absR = Math.abs(r);
  const strength: CorrelationResult['strength'] =
    absR >= 0.7 ? 'strong' :
    absR >= 0.3 ? 'moderate' :
    'weak';
  const direction: CorrelationResult['direction'] = r >= 0 ? 'positive' : 'negative';

  // ── Adim 5: Olaylari tanila ────────────────────────────────
  const events = identifyCorrelationEvents(seriesA, seriesB, optimalLag);

  // ── Adim 6: Uyari mesaji ──────────────────────────────────
  let warning: string | undefined;
  if (n < 10) {
    warning = `Kucuk orneklem (n=${n}) — korelasyon tahmini yuksek belirsizlige sahip`;
  } else if (pValue >= 0.05 && absR > 0.3) {
    warning = `Orta korelasyon (r=${r.toFixed(3)}) mevcut ama orneklem istatistiksel anlamlilik icin yetersiz`;
  }

  return {
    domainA: { name: 'A', metric: 'value', values: alignedA },
    domainB: { name: 'B', metric: 'value', values: alignedB },
    coefficient: Math.round(r * 10000) / 10000,
    strength,
    direction,
    pValue: Math.round(pValue * 10000) / 10000,
    confidenceInterval95: {
      lower: Math.round(ci95.lower * 10000) / 10000,
      upper: Math.round(ci95.upper * 10000) / 10000,
    },
    timeLagHours: optimalLag,
    significance: pValue < 0.05,
    sampleSize: n,
    events,
    warning,
  };
}

// ── Zaman Serisi Hizalama ────────────────────────────────────────────────────

/**
 * Iki zaman serisini belirli bir lag ile hizalar.
 *
 * NASIL CALISIR:
 *   1. Her iki seri de saatlik (veya belirtilen aralikta) gruplara bolunur (bucketing)
 *   2. Her grup icindeki degerlerin ortalamasi alinir
 *   3. B serisi lag kadar ileri kaydirilir (A[t] ile B[t + lag] eslenir)
 *   4. Her iki seride de deger olan gruplar cikarilir
 *   5. Sonuc: ayni uzunlukta iki sayi dizisi
 *
 * Zaman gruplama mantigi:
 *   - timestamp → epoch milisaniye → saat bazinda gruplanir
 *   - Grup anahtari: Math.floor(epochMs / (intervalHours * 3600000))
 *   - Ayni gruptaki degerlerin ortalamasi → o saatin degeri
 *
 * Lag uygulamasi:
 *   - lag = 24h ise: A'nin T anindaki degeri, B'nin T+24h deki degeri ile eslenir
 *   - Bu, "A degistikten lag saat sonra B nasil degisir?" sorusunu yanitlar
 *
 * @param seriesA - Birinci zaman serisi
 * @param seriesB - Ikinci zaman serisi
 * @param lagHours - Zaman gecikmesi (saat). B serisi bu kadar ileri kaydirilir.
 * @param intervalHours - Gruplama araligi (saat). Varsayilan: 1
 * @returns Hizalanmis sayi dizileri { a, b }
 */
export function alignTimeSeries(
  seriesA: TimeSeriesPoint[],
  seriesB: TimeSeriesPoint[],
  lagHours: number,
  intervalHours: number = DEFAULT_INTERVAL_HOURS,
): { a: number[]; b: number[] } {
  // ── Adim 1: Serileri bucket'la ────────────────────────────
  // Her seriyi zaman gruplarinla haritala
  const bucketsA = bucketize(seriesA, intervalHours);
  const bucketsB = bucketize(seriesB, intervalHours);

  // ── Adim 2: Lag offsetini hesapla ──────────────────────────
  // lagHours'u bucket birimine cevir
  const lagBuckets = Math.round(lagHours / intervalHours);

  // ── Adim 3: Eslestirme ────────────────────────────────────
  // A[bucket] ile B[bucket + lagBuckets] eslenir
  const alignedA: number[] = [];
  const alignedB: number[] = [];

  for (const [bucketKey, valueA] of bucketsA.entries()) {
    const offsetBucket = bucketKey + lagBuckets;
    const valueB = bucketsB.get(offsetBucket);

    // Her iki bucket'ta da deger varsa eslestir
    if (valueB !== undefined) {
      alignedA.push(valueA);
      alignedB.push(valueB);
    }
  }

  return { a: alignedA, b: alignedB };
}

/**
 * Farkli lag degerlerini deneyerek en yuksek |r| veren lag'i bulur.
 *
 * NASIL CALISIR:
 *   1. Her lag degeri icin serileri hizala
 *   2. Pearson r hesapla
 *   3. En yuksek |r| degerini veren lag secilir
 *
 * Neden |r| (mutlak)?
 *   Negatif korelasyon da (ters iliski) guclu bir korelasyondur.
 *   Ornegin sicaklik ↑ → oksijen ↓ bir negatif korelasyondur
 *   ve en az pozitif korelasyon kadar onemlidir.
 *
 * @param seriesA - Birinci zaman serisi
 * @param seriesB - Ikinci zaman serisi
 *   (ornegin sicaklik ile mortalite)
 * @param lags - Denenecek lag degerleri (saat). Varsayilan: [0, 6, 12, 24, 48]
 * @returns En iyi lag ve korelasyon katsayisi
 */
export function findOptimalLag(
  seriesA: TimeSeriesPoint[],
  seriesB: TimeSeriesPoint[],
  lags: number[] = DEFAULT_LAGS,
): { lag: number; r: number } {
  let bestLag = 0;
  let bestR = 0;
  let bestAbsR = -1;

  for (const lag of lags) {
    // Serileri bu lag ile hizala
    const { a, b } = alignTimeSeries(seriesA, seriesB, lag);

    // En az 3 eslesen nokta olmali
    if (a.length < 3) continue;

    // Pearson r hesapla
    const r = pearsonCorrelation(a, b);
    const absR = Math.abs(r);

    // En yuksek |r| secimi
    if (absR > bestAbsR) {
      bestAbsR = absR;
      bestR = r;
      bestLag = lag;
    }
  }

  return {
    lag: bestLag,
    r: Math.round(bestR * 10000) / 10000,
  };
}

/**
 * Korelasyonun en belirgin oldugu olaylari tanilar.
 *
 * NASIL CALISIR:
 *   1. Serileri lag ile hizalar
 *   2. Her noktada "degisim buyuklugu" hesaplar (onceki noktadan fark)
 *   3. Her iki seride de buyuk degisim olan noktalari "olay" olarak isaretler
 *   4. En onemli 5 olayi dondurur
 *
 * Bir nokta neden "olay" sayilir?
 *   Her iki serideki degisimin carpimi buyukse → korelasyonun belirgin oldugu an
 *   Ornegin:
 *     - Sicaklik 2°C atladi VE mortalite 5 artti → olay
 *     - Sicaklik 0.1°C degisti ama mortalite 0 → olay degil
 *
 * @param seriesA - Birinci zaman serisi
 * @param seriesB - Ikinci zaman serisi
 * @param lag - Zaman gecikmesi (saat)
 * @param threshold - Olay esigi (degisim carpimi). Varsayilan: otomatik hesap
 * @returns Korelasyon olaylari listesi (en fazla 5)
 */
export function identifyCorrelationEvents(
  seriesA: TimeSeriesPoint[],
  seriesB: TimeSeriesPoint[],
  lag: number,
  threshold?: number,
): CorrelationResult['events'] {
  const events: CorrelationResult['events'] = [];

  // ── Serileri bucket'la ─────────────────────────────────────
  const bucketsA = bucketizeWithTimestamps(seriesA, DEFAULT_INTERVAL_HOURS);
  const bucketsB = bucketizeWithTimestamps(seriesB, DEFAULT_INTERVAL_HOURS);

  const lagBuckets = Math.round(lag / DEFAULT_INTERVAL_HOURS);

  // ── Degisim carpimlarini hesapla ───────────────────────────
  // Her eslesen nokta ciftinde, onceki noktadan fark hesaplanir
  type EventCandidate = {
    timestampA: string;
    valueA: number;
    timestampB: string;
    valueB: number;
    changeProduct: number;
  };

  const candidates: EventCandidate[] = [];
  const sortedBucketsA = [...bucketsA.entries()].sort((a, b) => a[0] - b[0]);

  let prevA: number | undefined;
  let prevB: number | undefined;

  for (const [bucketKey, entryA] of sortedBucketsA) {
    const offsetBucket = bucketKey + lagBuckets;
    const entryB = bucketsB.get(offsetBucket);

    if (!entryB) continue;

    if (prevA !== undefined && prevB !== undefined) {
      const changeA = Math.abs(entryA.value - prevA);
      const changeB = Math.abs(entryB.value - prevB);
      const changeProduct = changeA * changeB;

      candidates.push({
        timestampA: entryA.timestamp,
        valueA: entryA.value,
        timestampB: entryB.timestamp,
        valueB: entryB.value,
        changeProduct,
      });
    }

    prevA = entryA.value;
    prevB = entryB.value;
  }

  if (candidates.length === 0) return [];

  // ── Esik belirleme ─────────────────────────────────────────
  // Varsayilan esik: degisim carpimlarinin ortalamasinin 1.5 kati
  const avgProduct = mean(candidates.map(c => c.changeProduct));
  const effectiveThreshold = threshold ?? avgProduct * 1.5;

  // ── Olaylari filtrele ve sirala ────────────────────────────
  const significantEvents = candidates
    .filter(c => c.changeProduct > effectiveThreshold)
    .sort((a, b) => b.changeProduct - a.changeProduct)
    .slice(0, 5); // En fazla 5 olay

  for (const event of significantEvents) {
    events.push({
      timestampA: event.timestampA,
      valueA: Math.round(event.valueA * 10000) / 10000,
      timestampB: event.timestampB,
      valueB: Math.round(event.valueB * 10000) / 10000,
      description: `A=${event.valueA.toFixed(2)}, B=${event.valueB.toFixed(2)} — esanli buyuk degisim`,
    });
  }

  return events;
}

// ── Yardimci Fonksiyonlar (Dahili) ───────────────────────────────────────────

/**
 * Zaman serisi verilerini belirli aralikta gruplara ayirir (bucketing).
 *
 * NASIL CALISIR:
 *   1. Her timestamp → epoch milisaniye → bucket indeksi hesaplanir
 *      bucket = Math.floor(epochMs / (intervalHours * 3600000))
 *   2. Ayni bucket'a dusen degerler ortalanir
 *   3. Sonuc: bucket indeksi → ortalama deger eslesmesi
 *
 * Neden bucketing gerekli?
 *   Iki farkli sensor tam ayni anda olcum yapmaz:
 *   - Sicaklik sensoru 14:03'te olctu
 *   - DO sensoru 14:17'de olctu
 *   1 saatlik gruplama ile ikisi de "saat 14" grubuna duser ve eslesir.
 *
 * @param series - Zaman serisi verileri
 * @param intervalHours - Gruplama araligi (saat)
 * @returns Map<bucket_indeksi, ortalama_deger>
 */
function bucketize(
  series: TimeSeriesPoint[],
  intervalHours: number,
): Map<number, number> {
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const bucketSums = new Map<number, { sum: number; count: number }>();

  for (const point of series) {
    const epochMs = new Date(point.timestamp).getTime();
    const bucket = Math.floor(epochMs / intervalMs);

    const existing = bucketSums.get(bucket);
    if (existing) {
      existing.sum += point.value;
      existing.count += 1;
    } else {
      bucketSums.set(bucket, { sum: point.value, count: 1 });
    }
  }

  // Ortalamalari hesapla
  const result = new Map<number, number>();
  for (const [bucket, { sum, count }] of bucketSums.entries()) {
    result.set(bucket, sum / count);
  }

  return result;
}

/**
 * Bucketing + timestamp bilgisi.
 *
 * identifyCorrelationEvents fonksiyonu icin gereken
 * timestamp bilgisini de saklayan versiyon.
 *
 * @param series - Zaman serisi verileri
 * @param intervalHours - Gruplama araligi (saat)
 * @returns Map<bucket_indeksi, { value, timestamp }>
 */
function bucketizeWithTimestamps(
  series: TimeSeriesPoint[],
  intervalHours: number,
): Map<number, { value: number; timestamp: string }> {
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const bucketData = new Map<number, { sum: number; count: number; lastTimestamp: string }>();

  for (const point of series) {
    const epochMs = new Date(point.timestamp).getTime();
    const bucket = Math.floor(epochMs / intervalMs);

    const existing = bucketData.get(bucket);
    if (existing) {
      existing.sum += point.value;
      existing.count += 1;
      // En son timestamp'i sakla (kronolojik)
      if (point.timestamp > existing.lastTimestamp) {
        existing.lastTimestamp = point.timestamp;
      }
    } else {
      bucketData.set(bucket, { sum: point.value, count: 1, lastTimestamp: point.timestamp });
    }
  }

  const result = new Map<number, { value: number; timestamp: string }>();
  for (const [bucket, { sum, count, lastTimestamp }] of bucketData.entries()) {
    result.set(bucket, { value: sum / count, timestamp: lastTimestamp });
  }

  return result;
}

/**
 * Bos / gecersiz girdi durumunda dondurulecek varsayilan sonuc.
 *
 * @param seriesA - Birinci seri (uzunluk bilgisi icin)
 * @param seriesB - Ikinci seri (uzunluk bilgisi icin)
 * @param warning - Kullaniciya gosterilecek uyari mesaji
 * @returns Sifir korelasyonlu sonuc
 */
function createEmptyResult(
  seriesA: TimeSeriesPoint[],
  seriesB: TimeSeriesPoint[],
  warning: string,
): CorrelationResult {
  return {
    domainA: { name: 'A', metric: 'value', values: seriesA.map(p => p.value) },
    domainB: { name: 'B', metric: 'value', values: seriesB.map(p => p.value) },
    coefficient: 0,
    strength: 'weak',
    direction: 'positive',
    pValue: 1,
    confidenceInterval95: { lower: -1, upper: 1 },
    timeLagHours: 0,
    significance: false,
    sampleSize: 0,
    events: [],
    warning,
  };
}
