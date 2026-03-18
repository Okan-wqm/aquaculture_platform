// ============================================================================
// MCP Farm Intelligence Server — Guvenilirlik Cercevesi (Reliability Framework)
// ============================================================================
//
// Tum zeka tool ciktilarina eklenen guvenilirlik katmani.
// Bu modul, her analitik sonucun ne kadar guvenilir oldugunu olcer ve
// kullaniciya seffaf bir sekilde bildirir.
//
// NASIL CALISIR:
//   1. Veri kaynaklari analiz edilir:
//      a) Tamamlik: Beklenen veri noktalarinin ne kadari mevcut?
//      b) Tazelik: En son veri ne zaman geldi?
//      c) Orneklem buyuklugu: Istatistiksel anlamlilik icin yeterli mi?
//      d) Kaynak sayisi: Kac farkli domain'den (WQ, besleme, buyume vb.) veri var?
//   2. Her faktor 0.0 - 1.0 arasinda puanlanir
//   3. Agirlikli ortalama ile bileske guven skoru hesaplanir
//   4. Dusuk guven durumunda otomatik uyari mesajlari (caveats) uretilir
//   5. Her sonuc bu modul ile sarmalanarak kullaniciya sunulur
//
// AGIRLIK MANTIGI:
//   - dataCompleteness (0.35): Eksik veri en buyuk guvenilirlik riski.
//     Eksik veri noktasi = kararlar eksik bilgiye dayanir.
//   - dataFreshness (0.25): Eski veri yaniltici olabilir. Su kalitesi
//     saatler icinde dramatik degisebilir.
//   - sampleSize (0.25): Kucuk orneklem = yuksek varyans = guvensiz sonuc.
//     Merkezi limit teoremi ~30 orneklem ile calismaya baslar.
//   - sourceCount (0.15): Birden fazla domain'den veri = capraz dogrulama.
//     Tek kaynakli analiz kisa goruslu olabilir.
//
// EXTENSIBLE:
//   - Yeni guven faktorleri eklenebilir (ornegin: sensor kalibrasyonu, cevresel stabilite)
//   - Agirliklar konfigure edilebilir hale getirilebilir
//   - Caveat kurallari genisletilebilir
// ============================================================================

import { erfc } from '../utils/stats.js';

// ── Tip Tanimlari ─────────────────────────────────────────────────────────────

/**
 * Bir analitik hesaplamada kullanilan tek bir veri kaynagini tanimlar.
 *
 * Her domain (su kalitesi, besleme, buyume vb.) icin ayri bir DataSource nesnesi
 * olusturulur ve guvenilirlik hesaplamasina verilir.
 *
 * Ornek:
 *   {
 *     domain: 'water_quality',
 *     dataPointCount: 45,       // son 7 gunde 45 olcum geldi
 *     expectedPointCount: 56,   // 7 gun x 8 olcum/gun = 56 bekleniyor
 *     lastDataTimestamp: '2026-03-16T14:30:00Z',
 *     maxStaleHours: 6,         // 6 saatten eski veri "bayat" sayilir
 *     minReliableN: 30,         // en az 30 veri noktasi gerekli
 *   }
 */
export interface DataSource {
  /** Veri domain'i — 'water_quality' | 'feeding' | 'growth' | 'mortality' vb. */
  domain: string;

  /** Mevcut veri noktasi sayisi — veritabanindan gelen gercek sayi */
  dataPointCount: number;

  /** Beklenen veri noktasi sayisi — ideal durumda olmasi gereken sayi */
  expectedPointCount: number;

  /**
   * Son veri zamani (ISO 8601 formati).
   * null ise o domain'den hic veri gelmemis demektir.
   */
  lastDataTimestamp: string | null;

  /**
   * Maksimum kabul edilebilir eskilik (saat cinsinden).
   * Bu sureden eski veri "bayat" olarak isaretlenir.
   * Ornek: WQ icin 6 saat, besleme icin 24 saat.
   */
  maxStaleHours: number;

  /**
   * Istatistiksel guvenilirlik icin minimum orneklem buyuklugu.
   * Varsayilan: 30 (merkezi limit teoremi esigi).
   * Bazi analizler icin daha yuksek olabilir (ornegin korelasyon icin 50+).
   */
  minReliableN: number;
}

/**
 * Guven skoru hesaplama sonucu.
 *
 * score: 0.0 (sifir guven) - 1.0 (tam guven) arasinda bileske skor
 * level: score'a dayali kategorik seviye
 * factors: her alt faktogun bireysel skoru (seffaflik icin)
 */
export interface ConfidenceResult {
  /** Bileske guven skoru — 0.0 ile 1.0 arasi */
  score: number;

  /**
   * Kategorik guven seviyesi:
   *   - 'low': 0.00 - 0.39 arasi — sonuclara dikkatli yaklasılmalı
   *   - 'medium': 0.40 - 0.69 arasi — sonuclar yol gosterici ama kesin degil
   *   - 'high': 0.70 - 1.00 arasi — sonuclara guvenle basvurulabilir
   */
  level: 'low' | 'medium' | 'high';

  /** Her alt faktogun bireysel skoru (0.0 - 1.0) */
  factors: {
    /**
     * Veri tamamliligi — mevcut/beklenen veri orani.
     * 1.0 = tum beklenen veriler mevcut
     * 0.5 = beklenenin yarisi eksik
     * 0.0 = hic veri yok
     */
    dataCompleteness: number;

    /**
     * Veri tazeligi — son verinin ne kadar guncel oldugu.
     * 1.0 = cok taze (az once geldi)
     * 0.5 = orta tazelik (maxStaleHours'un yarisi kadar eski)
     * 0.0 = cok bayat veya veri yok
     */
    dataFreshness: number;

    /**
     * Orneklem buyuklugu yeterliligi.
     * 1.0 = minimum guvenilir orneklem buyuklugune ulasildi veya gecildi
     * 0.5 = orneklem yarisi kadar
     * 0.0 = hic veri yok
     */
    sampleSize: number;

    /**
     * Kaynak cesitliligi — kac domain'in kullanilabildigini gosterir.
     * 1.0 = tum domain'ler veri sagladi
     * 0.5 = yarisi sagladi
     * 0.0 = tek domain bile yok (olmamali ama savunma amacli)
     */
    sourceCount: number;
  };
}

/**
 * Istatistiksel anlamlilik degerlendirmesi.
 *
 * Korelasyon veya anomali tespitinin "gercek" olup olmadigini
 * istatistiksel test ile dogrular.
 */
export interface StatisticalSignificance {
  /** Test sonucu: istatistiksel olarak anlamli mi? (p < 0.05) */
  isSignificant: boolean;

  /** p-value: sonucun rastgele olma olasiligi (0-1 arasi) */
  pValue?: number;

  /** Dusuk guvenilirlik durumunda kullaniciya gosterilecek uyari */
  warning?: string;
}

/**
 * Tam guvenilirlik raporu.
 *
 * Bir analitik tool'un ciktisina eklenen meta-bilgi paketi.
 * Kullaniciya hem "ne kadar guvenilir" hem de "neden" bilgisi sunar.
 */
export interface ReliabilityReport {
  /** Bileske guven skoru ve faktorler */
  confidence: ConfidenceResult;

  /**
   * Uyari mesajlari listesi (Turkce).
   * Her mesaj kullanicinin dikkat etmesi gereken bir noktayi belirtir.
   * Ornek: "Su kalitesi verileri 14 saat oncesine ait — guncel olcum onerilir"
   */
  caveats: string[];

  /**
   * Turkce ozet cumlesi — LLM dogrudan kullaniciya aktarabilir.
   * Guven skoru, seviye ve en onemli caveat'i tek cumlede ozetler.
   * Ornek: "Guven: %72 (high). Veri kalitesi iyi."
   */
  insight: string;

  /** Veri kalitesi ozeti */
  dataQuality: {
    /** Analizde kullanilan toplam veri noktasi sayisi */
    totalDataPoints: number;

    /** Beklenen ama eksik olan veri noktasi sayisi */
    missingDataPoints: number;

    /** En eski veri noktasinin zamani (ISO) — null ise veri yok */
    oldestDataPoint: string | null;

    /** En yeni veri noktasinin zamani (ISO) — null ise veri yok */
    newestDataPoint: string | null;

    /** Analizde kullanilan domain isimleri */
    domainsUsed: string[];

    /** Veri saglanamayan (eksik) domain isimleri */
    domainsUnavailable: string[];
  };
}

// ── Agirlik Sabitleri ────────────────────────────────────────────────────────
//
// Neden bu agirliklar?
//   - dataCompleteness (0.35): En yuksek agirlik. Eksik veri direkt olarak
//     yanlis sonuca yol acar. Ornegin 10 tanktan sadece 3'unun WQ verisi
//     varsa, "tum sistem saglikli" demek yanilticidir.
//   - dataFreshness (0.25): Su kalitesi saatler icinde degisir. 12 saatlik
//     veri ile yapilan analiz, mevcut durumu yansitiyor olmayabilir.
//   - sampleSize (0.25): Kucuk orneklem = yuksek varyans. 5 veri noktasiyla
//     hesaplanan ortalama, 50 veri noktasiyla hesaplanandan cok daha guvensiz.
//   - sourceCount (0.15): Capraz dogrulama. Sadece WQ verisine dayanan bir
//     risk skoru, besleme + buyume + mortalite verisi de olan bir skordan
//     daha kisa goruslu.
//
// EXTENSIBLE: Bu agirliklar konfigure edilebilir hale getirilebilir.
//   Ornegin acil durum modunda freshness agirligi arttirilabilir.
// ─────────────────────────────────────────────────────────────────────────────

const WEIGHT_COMPLETENESS = 0.35;
const WEIGHT_FRESHNESS = 0.25;
const WEIGHT_SAMPLE_SIZE = 0.25;
const WEIGHT_SOURCE_COUNT = 0.15;

// Guven seviyesi esikleri
const LOW_THRESHOLD = 0.40;
const MEDIUM_THRESHOLD = 0.70;

// Caveat uretimi icin esikler
const STALE_DATA_HOURS = 12;       // 12 saatten eski veri icin uyari
const MIN_SAMPLE_FOR_STATS = 10;   // 10'dan az veri noktasi icin uyari
const LOW_FRESHNESS_THRESHOLD = 0.5; // Tazelik skoru < 0.5 icin uyari

// ── Ana Fonksiyonlar ─────────────────────────────────────────────────────────

/**
 * Birden fazla veri kaynagini analiz ederek bileske guven skoru hesaplar.
 *
 * NASIL CALISIR:
 *   1. Her DataSource icin 4 alt faktor hesaplanir:
 *      a) dataCompleteness = min(1, dataPointCount / expectedPointCount)
 *      b) dataFreshness = 1 - min(1, hoursSinceLastData / maxStaleHours)
 *      c) sampleSize = min(1, dataPointCount / minReliableN)
 *      d) sourceCount = (veri_olan_domain_sayisi / toplam_domain_sayisi)
 *   2. Her kaynaktan gelen faktorler ortalanir (kaynak bazinda)
 *   3. Agirlikli toplam hesaplanir:
 *      score = completeness * 0.35 + freshness * 0.25 + sampleSize * 0.25 + sourceCount * 0.15
 *   4. Score'a gore seviye belirlenir
 *
 * @param dataSources - Analiz edilen tum veri kaynaklari
 * @returns Bileske guven skoru, seviye ve alt faktorler
 */
export function calculateConfidence(dataSources: DataSource[]): ConfidenceResult {
  // ── Bos kaynak kontrolu ───────────────────────────────
  // Hic veri kaynagi yoksa guven sifir
  if (dataSources.length === 0) {
    return {
      score: 0,
      level: 'low',
      factors: {
        dataCompleteness: 0,
        dataFreshness: 0,
        sampleSize: 0,
        sourceCount: 0,
      },
    };
  }

  const now = Date.now();

  // ── Adim 1: Her kaynak icin alt faktorleri hesapla ─────────────
  // Her DataSource'tan gelen faktor degerlerini toplayip ortalama alacagiz

  let totalCompleteness = 0;
  let totalFreshness = 0;
  let totalSampleSize = 0;
  let sourcesWithData = 0;

  for (const source of dataSources) {
    // a) Veri tamamliligi: mevcut / beklenen (1.0'da kapatilir)
    //    Ornek: 45 olcum / 56 beklenen = 0.80
    const completeness = source.expectedPointCount > 0
      ? Math.min(1.0, source.dataPointCount / source.expectedPointCount)
      : 0;
    totalCompleteness += completeness;

    // b) Veri tazeligi: son veri ne kadar once geldi?
    //    Formula: 1 - min(1, saat_farki / maxStaleHours)
    //    Ornek: 3 saat once, maxStale = 6 saat → 1 - (3/6) = 0.5
    //    Ornek: 0 saat once → 1 - 0 = 1.0 (cok taze)
    //    Ornek: 12 saat once, maxStale = 6 → 1 - 1 = 0.0 (cok bayat)
    let freshness = 0;
    if (source.lastDataTimestamp) {
      const lastTime = new Date(source.lastDataTimestamp).getTime();
      const hoursSince = (now - lastTime) / (1000 * 60 * 60);
      // maxStaleHours sifir veya negatifse korunma: tazelik 0 sayilir
      if (source.maxStaleHours > 0) {
        freshness = 1 - Math.min(1.0, hoursSince / source.maxStaleHours);
        // Negatif saat farki (gelecek zaman) korunmasi: max 1.0
        freshness = Math.max(0, Math.min(1.0, freshness));
      }
    }
    totalFreshness += freshness;

    // c) Orneklem buyuklugu: mevcut / minimum_gerekli (1.0'da kapatilir)
    //    Ornek: 45 noktasi / 30 gerekli = 1.0 (yeterli)
    //    Ornek: 15 noktasi / 30 gerekli = 0.5 (yetersiz)
    const sampleAdequacy = source.minReliableN > 0
      ? Math.min(1.0, source.dataPointCount / source.minReliableN)
      : (source.dataPointCount > 0 ? 1.0 : 0);
    totalSampleSize += sampleAdequacy;

    // d) Bu kaynakta veri var mi? (sourceCount hesabi icin)
    if (source.dataPointCount > 0) {
      sourcesWithData++;
    }
  }

  // ── Adim 2: Ortalama faktorler ─────────────────────────────────
  const n = dataSources.length;
  const avgCompleteness = totalCompleteness / n;
  const avgFreshness = totalFreshness / n;
  const avgSampleSize = totalSampleSize / n;

  // sourceCount: veri olan kaynaklar / toplam kaynaklar
  // Ornek: 5 domain'den 4'unde veri var → 0.8
  const sourceCountRatio = sourcesWithData / n;

  // ── Adim 3: Agirlikli toplam ───────────────────────────────────
  // score = completeness × 0.35 + freshness × 0.25 + sampleSize × 0.25 + sourceCount × 0.15
  const score =
    avgCompleteness * WEIGHT_COMPLETENESS +
    avgFreshness * WEIGHT_FRESHNESS +
    avgSampleSize * WEIGHT_SAMPLE_SIZE +
    sourceCountRatio * WEIGHT_SOURCE_COUNT;

  // ── Adim 4: Seviye belirleme ───────────────────────────────────
  // 0.00 - 0.39: low — sonuclara dikkatli yaklasılmalı
  // 0.40 - 0.69: medium — yol gosterici ama kesin degil
  // 0.70 - 1.00: high — guvenle basvurulabilir
  const level: ConfidenceResult['level'] =
    score < LOW_THRESHOLD ? 'low' :
    score < MEDIUM_THRESHOLD ? 'medium' :
    'high';

  return {
    score: Math.round(score * 1000) / 1000, // 3 ondalik hane
    level,
    factors: {
      dataCompleteness: Math.round(avgCompleteness * 1000) / 1000,
      dataFreshness: Math.round(avgFreshness * 1000) / 1000,
      sampleSize: Math.round(avgSampleSize * 1000) / 1000,
      sourceCount: Math.round(sourceCountRatio * 1000) / 1000,
    },
  };
}

/**
 * Korelasyon katsayisinin istatistiksel anlamliligi degerlendirir.
 *
 * NASIL CALISIR:
 *   1. Pearson r katsayisi ve orneklem buyuklugu (n) alinir
 *   2. t-istatistigi hesaplanir: t = r × sqrt(n-2) / sqrt(1 - r^2)
 *   3. p-value hesaplanir (iki kuyruklu test)
 *   4. p < 0.05 ise "istatistiksel olarak anlamli" kabul edilir
 *   5. Kucuk orneklem veya zayif korelasyon icin uyari eklenir
 *
 * Neden p < 0.05?
 *   Geleneksel anlamlilik esigi. "Bu korelasyonun rastgele olusma
 *   olasiligi %5'ten dusuk" anlamina gelir.
 *
 * @param r - Pearson korelasyon katsayisi (-1 ile +1 arasi)
 * @param n - Orneklem buyuklugu (cift sayisi)
 * @returns Anlamlilik degerlendirmesi
 */
export function assessCorrelationSignificance(
  r: number,
  n: number,
): StatisticalSignificance {
  // ── Yetersiz veri kontrolu ──────────────────────────────────
  // Korelasyon testi icin en az 3 veri cifti gerekir (df = n - 2 >= 1)
  if (n < 3) {
    return {
      isSignificant: false,
      warning: `Orneklem cok kucuk (n=${n}) — korelasyon testi icin en az 3 veri cifti gerekli`,
    };
  }

  // ── Tam korelasyon ozel durumu ──────────────────────────────
  const rAbs = Math.abs(r);
  if (rAbs >= 1.0) {
    return {
      isSignificant: true,
      pValue: 0,
    };
  }

  // ── t-istatistigi hesabi ────────────────────────────────────
  // t = r × sqrt(n - 2) / sqrt(1 - r^2)
  // Serbestlik derecesi: df = n - 2
  const df = n - 2;
  const tStat = rAbs * Math.sqrt(df) / Math.sqrt(1 - r * r);

  // ── p-value yaklasimi (iki kuyruklu) ────────────────────────
  // Buyuk df icin normal yaklasim kullanilir.
  // p = 2 × P(T > |t|) yaklasik olarak 2 × P(Z > |t|) (df >= 30)
  // Kucuk df icin duzeltme uygulanir.
  //
  // Basitlestirilmis yaklasim:
  //   p ≈ 2 × e^(-0.717 × t - 0.416 × t^2)  (genis t icin)
  //   Daha dogru yaklasim icin erfc tabanli hesap:
  const adjustedT = tStat * Math.sqrt(df / (df + tStat * tStat / 3));
  const pValue = Math.max(0, Math.min(1, 2 * (0.5 * erfc(adjustedT / Math.SQRT2))));

  const isSignificant = pValue < 0.05;

  // ── Uyari uretimi ──────────────────────────────────────────
  let warning: string | undefined;
  if (n < 10) {
    warning = `Kucuk orneklem (n=${n}) — korelasyon tahmini yuksek belirsizlige sahip`;
  } else if (!isSignificant && rAbs > 0.3) {
    warning = `Orta korelasyon (r=${r.toFixed(3)}) mevcut ama orneklem (n=${n}) istatistiksel anlamlilik icin yetersiz`;
  }

  return { isSignificant, pValue, warning };
}

/**
 * Anomali z-score'unun istatistiksel anlamliligini degerlendirir.
 *
 * NASIL CALISIR:
 *   1. Hesaplanan z-score ve orneklem buyuklugu alinir
 *   2. |z| > 2 ise anomali istatistiksel olarak anlamli kabul edilir
 *      (Normal dagılımda |z| > 2 olasılığı %4.55)
 *   3. Kucuk orneklem durumunda uyari eklenir
 *
 * Neden |z| > 2?
 *   - |z| > 2 → verinin %95.45'inin disinda (yaklasik %5 olasilik)
 *   - |z| > 3 → verinin %99.73'unun disinda (yaklasik %0.3 olasilik)
 *   - Akvakulturdeki uygulamada z > 2 yeterli hassasiyeti saglar.
 *     z > 3 kullanmak onemli anomalileri gozden kacirabilir.
 *
 * @param zScore - Z-score degeri (mutlak)
 * @param n - Orneklem buyuklugu (z-score hesaplanirken kullanilan)
 * @returns Anlamlilik degerlendirmesi
 */
export function assessAnomalySignificance(
  zScore: number,
  n: number,
): StatisticalSignificance {
  const absZ = Math.abs(zScore);

  // ── Cok kucuk orneklem kontrolu ─────────────────────────────
  // Z-score hesabi icin en az 3 veri noktasi olmali (stdDev icin)
  if (n < 3) {
    return {
      isSignificant: false,
      warning: `Orneklem cok kucuk (n=${n}) — z-score hesabi guvenilir degil`,
    };
  }

  // ── p-value yaklasimi ───────────────────────────────────────
  // Normal dagılımda: p = 2 × P(Z > |z|) = 2 × (1 - Phi(|z|))
  // erfc kullanarak: p = erfc(|z| / sqrt(2))
  const pValue = Math.max(0, Math.min(1, erfc(absZ / Math.SQRT2)));

  // ── Anlamlilik karari ───────────────────────────────────────
  // |z| > 2 → anlamli anomali
  const isSignificant = absZ > 2;

  // ── Uyari uretimi ──────────────────────────────────────────
  let warning: string | undefined;
  if (n < MIN_SAMPLE_FOR_STATS) {
    warning = `Kucuk orneklem (n=${n}) — z-score tahmini yuksek belirsizlige sahip. En az ${MIN_SAMPLE_FOR_STATS} veri noktasi onerilir.`;
  } else if (absZ > 1.5 && absZ <= 2) {
    warning = `Z-score (${absZ.toFixed(2)}) anlamlilik esigine yakin ama henuz gecmiyor — izlemeye devam edilmeli`;
  }

  return { isSignificant, pValue, warning };
}

/**
 * Guven skoru ve veri kaynaklarina dayali uyari mesajlari (caveats) uretir.
 *
 * NASIL CALISIR:
 *   1. Her veri kaynagi teker teker kontrol edilir
 *   2. Su kurallara gore uyari mesajlari olusturulur:
 *      a) Son veri 12 saatten eski → "... verileri X saat oncesine ait"
 *      b) Bir domain'de hic veri yok → "X domain'inde veri boslugu var"
 *      c) Orneklem < 10 → "Sadece N veri noktasi — guvenilirlik dusuk"
 *      d) Tazelik skoru < 0.5 → "Veriler guncel degil"
 *   3. Tekrar eden mesajlar filtrelenir
 *   4. Mesajlar Turkce ve kullanici dostu sekilde formatlanir
 *
 * @param confidence - Onceden hesaplanmis guven skoru
 * @param dataSources - Analiz edilen veri kaynaklari
 * @returns Turkce uyari mesajlari listesi
 */
export function generateCaveats(
  confidence: ConfidenceResult,
  dataSources: DataSource[],
): string[] {
  const caveats: string[] = [];
  const now = Date.now();

  // ── Domain bazli uyarilar ──────────────────────────────────
  for (const source of dataSources) {
    const domainLabel = domainToTurkish(source.domain);

    // Kural (a): Eski veri uyarisi
    // 12 saatten eski veri icin uyari uret — su kalitesi, besleme gibi
    // kritik parametreler saatler icinde degisebilir
    if (source.lastDataTimestamp) {
      const lastTime = new Date(source.lastDataTimestamp).getTime();
      const hoursSince = Math.round((now - lastTime) / (1000 * 60 * 60));

      if (hoursSince >= STALE_DATA_HOURS) {
        caveats.push(
          `${domainLabel} verileri ${hoursSince} saat oncesine ait — guncel olcum onerilir`,
        );
      }
    }

    // Kural (b): Veri boslugu uyarisi
    // Domain'de hic veri yoksa analiz o boyutu hic kapsamiyor demektir
    if (source.dataPointCount === 0) {
      caveats.push(
        `${domainLabel} domain'inde veri boslugu var — bu alan analize dahil edilemedi`,
      );
    }

    // Kural (c): Kucuk orneklem uyarisi
    // 10'dan az veri noktasiyla yapilan istatistiksel hesaplamalar
    // yuksek varyansa sahiptir
    if (source.dataPointCount > 0 && source.dataPointCount < MIN_SAMPLE_FOR_STATS) {
      caveats.push(
        `${domainLabel} icin sadece ${source.dataPointCount} veri noktasi mevcut — istatistiksel guvenilirlik dusuk`,
      );
    }
  }

  // ── Genel tazelik uyarisi ──────────────────────────────────
  // Kural (d): Ortalama tazelik dusukse genel bir uyari
  if (confidence.factors.dataFreshness < LOW_FRESHNESS_THRESHOLD) {
    caveats.push(
      'Veriler guncel degil — sonuclar eski verilere dayaniyor. Guncel olcumlerle dogrulama onerilir.',
    );
  }

  // ── Dusuk genel guven uyarisi ──────────────────────────────
  if (confidence.level === 'low') {
    caveats.push(
      'Genel guven skoru dusuk — bu sonuclari kesin karar vermek icin degil, yol gosterici olarak kullanin.',
    );
  }

  return caveats;
}

/**
 * Tam guvenilirlik raporu olusturur.
 *
 * Bu fonksiyon, bir analitik tool'un ciktisina eklenecek olan
 * meta-bilgi paketini hazirlar. Guven skoru, uyarilar ve
 * veri kalitesi ozetini icerir.
 *
 * NASIL CALISIR:
 *   1. calculateConfidence ile guven skoru hesaplanir
 *   2. generateCaveats ile uyari mesajlari olusturulur
 *   3. Veri kalitesi istatistikleri derlenir (toplam/eksik noktalar, zaman araligi)
 *   4. Kullanilan ve eksik domain'ler belirlenir
 *   5. Tum bilgiler tek bir ReliabilityReport nesnesi olarak dondurulur
 *
 * @param dataSources - Analiz edilen veri kaynaklari
 * @param usedDomains - Bu analizde kullanilan domain adlari
 * @param allDomains - Analizde kullanilabilecek tum domain adlari
 * @returns Tam guvenilirlik raporu
 */
export function buildReliabilityReport(
  dataSources: DataSource[],
  usedDomains: string[],
  allDomains: string[],
): ReliabilityReport {
  // ── Adim 1: Guven skoru hesapla ────────────────────────────
  const confidence = calculateConfidence(dataSources);

  // ── Adim 2: Uyari mesajlari olustur ───────────────────────
  const caveats = generateCaveats(confidence, dataSources);

  // ── Adim 3: Veri kalitesi istatistikleri ───────────────────
  // Toplam ve eksik veri noktalarini hesapla
  let totalDataPoints = 0;
  let totalExpected = 0;

  // Zaman damgalarini topla (en eski ve en yeni)
  const timestamps: number[] = [];

  for (const source of dataSources) {
    totalDataPoints += source.dataPointCount;
    totalExpected += source.expectedPointCount;

    if (source.lastDataTimestamp) {
      timestamps.push(new Date(source.lastDataTimestamp).getTime());
    }
  }

  const missingDataPoints = Math.max(0, totalExpected - totalDataPoints);

  // En eski ve en yeni zaman damgalari
  const oldestDataPoint = timestamps.length > 0
    ? new Date(Math.min(...timestamps)).toISOString()
    : null;
  const newestDataPoint = timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toISOString()
    : null;

  // ── Adim 4: Kullanilmayan domain'leri belirle ─────────────
  const domainsUnavailable = allDomains.filter(d => !usedDomains.includes(d));

  // ── Adim 5: Insight cumlesi olustur ──────────────────────
  const insight = `Güven: %${Math.round(confidence.score * 100)} (${confidence.level}). ${caveats.length > 0 ? caveats[0] : 'Veri kalitesi iyi.'}`;

  // ── Adim 6: Raporu derle ───────────────────────────────────
  return {
    confidence,
    caveats,
    insight,
    dataQuality: {
      totalDataPoints,
      missingDataPoints,
      oldestDataPoint,
      newestDataPoint,
      domainsUsed: usedDomains,
      domainsUnavailable,
    },
  };
}

// ── Yardimci Fonksiyonlar (Dahili) ───────────────────────────────────────────

/**
 * Domain adini Turkce etiketine cevirir.
 *
 * Kullanici dostu uyari mesajlari icin domain adlari
 * teknik_ad → okunabilir Turkce'ye donusturulur.
 *
 * EXTENSIBLE: Yeni domain eklendikce bu map genisletilmelidir.
 *
 * @param domain - Teknik domain adi (ornegin 'water_quality')
 * @returns Turkce etiket (ornegin 'Su kalitesi')
 */
function domainToTurkish(domain: string): string {
  const map: Record<string, string> = {
    water_quality: 'Su kalitesi',
    feeding: 'Besleme',
    growth: 'Buyume',
    mortality: 'Mortalite',
    density: 'Yogunluk',
    health: 'Saglik',
    maintenance: 'Bakim',
    weather: 'Hava durumu',
    harvest: 'Hasat',
    stocking: 'Stoklama',
  };

  return map[domain] ?? domain;
}

// erfc fonksiyonu artik '../utils/stats.js' modulunden import edilmektedir.
// Onceden burada erfcApprox adli yerel kopya vardi — DRY prensibi geregi kaldirildi.
