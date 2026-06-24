// ============================================================================
// MCP Farm Intelligence Server — Kaskad Tahmin Motoru (Cascade Predictor)
// ============================================================================
//
// Bir tetikleyici olay verildiginde, bilinen kaskad zincirlerini kullanarak
// gelecekteki etkileri tahmin eder.
//
// NASIL CALISIR:
//   1. Tetikleyici olayin hangi kaskad zincirine uydugu bulunur
//      Ornek: "ammonia_spike" → "Amonyak Kaskadi" zinciri
//   2. Olayin ne kadar sure once basladigi hesaplanir (hoursElapsed)
//      Ornek: 6 saat once NH3 yukselmeye basladi
//   3. Kaskad zincirindeki adimlar iki gruba ayrilir:
//      a) Tamamlanmis adimlar: T+X <= hoursElapsed olan adimlar
//         (zaten gerceklesmis veya gerceklesiyor olmasi beklenir)
//      b) Yaklaşan adimlar: T+X > hoursElapsed olan adimlar
//         (henuz gerceklesmedi ama gerceklesmesi bekleniyor)
//   4. Her gelecek adim icin:
//      - Tahmini zaman cercevesi (T+Xh formatinda)
//      - Olasilik ve siddet bilgisi
//      eklenir
//   5. Onerilen mudahale aksiyonlari listelenir
//
// KASKAD ZINCIRI MANTIGI:
//   Akvakulturdeki bircok problem "domino etkisi" ile yayilir.
//   Ornegin:
//     T+0h: Biofiltre kapasitesi asılır → NH3 yukselir
//     T+2h: NH3 solungac hasarı yapar → baliklar strese girer
//     T+6h: Stres bagisiklik sistemini zayiflatir → hastalik riski artar
//     T+12h: Enfeksiyon baslar → mortalite artar
//     T+24h: Olum artan organik yuk → WQ daha da bozulur (kotu dongu)
//
//   Bu motor, T+0h'daki tetikleyiciyi gordigunde geri kalan adimlari
//   ONCEDEN tahmin eder ve operatore mudahale penceresi sunar.
//
// VERİ KAYNAĞI:
//   Tüm kaskad zincirleri knowledge/cascade-chains.ts'de tanımlıdır (SINGLE SOURCE OF TRUTH).
//   Bu modül sadece tahmin motorudur — veri tutmaz, knowledge'dan import eder.
//
// EXTENSIBLE:
//   - Yeni kaskad zincirleri knowledge/cascade-chains.ts'ye eklenebilir
//   - matchTrigger fonksiyonu yeni olay tipleriyle genisletilebilir
//   - hoursElapsed parametresi ile "gercek zamanli" takip yapilabilir
// ============================================================================

// ── Knowledge modülünden veri ve tipler ──────────────────────────────────────
// SINGLE SOURCE OF TRUTH: Tüm kaskad verileri ve tipleri knowledge'dan gelir.
// Bu modül kendi interface'i tanımlamaz — knowledge interface'ini doğrudan kullanır.
import {
  KNOWN_CASCADES,
  type CascadeChain,
  type CascadeStep,
} from '../knowledge/cascade-chains.js';

// Knowledge tiplerini re-export et — tüketiciler tek noktadan erişebilsin
export type { CascadeChain, CascadeStep };

// ── CascadePrediction — Tahmin Sonucu Tipi ──────────────────────────────────
// Bu tip analytics-specific'tir: knowledge verisini zaman bazlı analiz ile
// completedSteps/upcomingSteps olarak ayırır. Knowledge'da karşılığı yoktur
// çünkü bu bir "runtime tahmin sonucu"dur, statik veri değildir.

/**
 * Kaskad tahmini sonucu.
 *
 * Bir tetikleyicinin yol actigi/acacagi olaylarin ozeti.
 * Knowledge'daki CascadeStep ve CascadeChain tiplerini doğrudan kullanır.
 */
export interface CascadePrediction {
  /** Tetikleyici olay turu */
  trigger: string;

  /** Tetikleyicinin aciklamasi */
  triggerDescription: string;

  /** Tetikleyicinin ne kadar sure once basladigi (saat) */
  hoursElapsed: number;

  /** Zaten gerceklesmis (veya gerceklesiyor olmasi beklenen) adimlar */
  completedSteps: CascadeStep[];

  /**
   * Henuz gerceklesmemis gelecek adimlar.
   * Her adima ek olarak "timeframe" alani eklenir:
   * "T+Xh" formatinda, tetikleyiciden sonra beklenen zaman
   */
  upcomingSteps: Array<CascadeStep & { timeframe: string }>;

  /** Onerilen mudahale aksiyonlari */
  recommendedActions: CascadeChain['recommendedActions'];
}

// ── Tetikleyici Esleme Haritasi ──────────────────────────────────────────────
//
// Anomali tipleri ve kanit cumleleri ile bilinen tetikleyiciler arasindaki
// eslestirme. matchTrigger fonksiyonu bu haritayi kullanir.
//
// Anahtar: anomali tipi veya olay turu
// Deger: ilgili kaskad tetikleyicisi
//
// EXTENSIBLE: Yeni anomali tipleri eklendikce bu harita genisletilir.
// ─────────────────────────────────────────────────────────────────────────────

const TRIGGER_MAP: Record<string, string> = {
  // Anomali tipleri → kaskad tetikleyicileri
  'ammonia_spike': 'ammonia_spike',
  'ammonia_high': 'ammonia_spike',
  'wq_deviation_ammonia': 'ammonia_spike',

  'dissolved_oxygen_drop': 'dissolved_oxygen_drop',
  'dissolved_oxygen_low': 'dissolved_oxygen_drop',
  'wq_deviation_dissolved_oxygen': 'dissolved_oxygen_drop',
  'do_critical': 'dissolved_oxygen_drop',

  'temperature_deviation': 'temperature_deviation',
  'temperature_high': 'temperature_deviation',
  'temperature_low': 'temperature_deviation',
  'wq_deviation_temperature': 'temperature_deviation',

  'feeding_excess': 'feeding_excess',
  'overfeeding': 'feeding_excess',
  'feeding_variance_excess': 'feeding_excess',

  'density_overload': 'density_overload',
  'density_high': 'density_overload',
  'stocking_density_exceeded': 'density_overload',
};

// ── Ana Fonksiyonlar ─────────────────────────────────────────────────────────

/**
 * Tetikleyici olay icin kaskad tahmini yapar.
 *
 * NASIL CALISIR:
 *   1. Tetikleyiciye uyan kaskad zinciri bulunur (KNOWN_CASCADES'den)
 *   2. Zincir bulunamazsa bos tahmin dondurulur
 *   3. hoursElapsed parametresi ile adimlar ikiye ayrilir:
 *      - completedSteps: delayHours <= hoursElapsed
 *        (gecmiste gerceklesmis olmasi beklenen adimlar)
 *      - upcomingSteps: delayHours > hoursElapsed
 *        (gelecekte beklenen adimlar)
 *   4. Her gelecek adima "timeframe" eklenir (T+Xh formati)
 *   5. Onerilen aksiyonlar eklenir
 *
 * @param trigger - Tetikleyici olay turu (ornegin 'ammonia_spike')
 * @param hoursElapsed - Tetikleyicinin ne kadar sure once basladigi (saat). Varsayilan: 0
 * @returns Kaskad tahmin sonucu
 */
export function predictCascade(
  trigger: string,
  hoursElapsed = 0,
): CascadePrediction {
  // ── Kaskad zincirini bul ───────────────────────────────────
  const chain = KNOWN_CASCADES.find(c => c.trigger === trigger);

  // Bilinmeyen tetikleyici → bos tahmin
  if (!chain) {
    return {
      trigger,
      triggerDescription: `Bilinmeyen tetikleyici: ${trigger}`,
      hoursElapsed,
      completedSteps: [],
      upcomingSteps: [],
      recommendedActions: [],
    };
  }

  // ── Adimlari ayir: tamamlanmis vs yaklaşan ─────────────────
  // delayHours <= hoursElapsed → muhtemelen zaten gerceklesti
  // delayHours > hoursElapsed → henuz gerceklesmedi, gelecek tahmini
  const completedSteps: CascadeStep[] = [];
  const upcomingSteps: Array<CascadeStep & { timeframe: string }> = [];

  for (const step of chain.chain) {
    if (step.delayHours <= hoursElapsed) {
      completedSteps.push(step);
    } else {
      // Kalan sure hesabi: adimin beklenen zamani - gecen sure
      const remainingHours = step.delayHours - hoursElapsed;

      upcomingSteps.push({
        ...step,
        timeframe: `T+${step.delayHours}h (${remainingHours} saat sonra)`,
      });
    }
  }

  return {
    trigger: chain.trigger,
    triggerDescription: chain.triggerDescription,
    hoursElapsed,
    completedSteps,
    upcomingSteps,
    recommendedActions: chain.recommendedActions,
  };
}

/**
 * Olay tipini bilinen bir tetikleyiciye esler.
 *
 * NASIL CALISIR:
 *   1. eventType dogrudan TRIGGER_MAP'te aranir
 *   2. Bulunamazsa, evidence (kanit) cumleleri icinde
 *      anahtar kelimeler aranir
 *   3. Hala bulunamazsa null dondurulur
 *
 * Neden evidence parametresi?
 *   Bazi durumlarda olay tipi tek basina yeterli degildir:
 *   - 'wq_deviation' → hangi parametre? (ammonia, DO, temperature?)
 *   - evidence icindeki 'ammonia' kelimesi → 'ammonia_spike' tetikleyicisi
 *
 * @param eventType - Olay turu (ornegin 'wq_deviation', 'feeding_variance')
 * @param evidence - Olayla ilgili kanit cumleleri
 * @returns Eslesen tetikleyici adi veya null
 */
export function matchTrigger(
  eventType: string,
  evidence: string[] = [],
): string | null {
  // ── Dogrudan eslestirme ────────────────────────────────────
  const directMatch = TRIGGER_MAP[eventType];
  if (directMatch) return directMatch;

  // ── Birlesik anahtar deneme ────────────────────────────────
  // Ornegin eventType='wq_deviation' + evidence icinde 'ammonia'
  // → 'wq_deviation_ammonia' anahtarini dene
  const evidenceStr = evidence.join(' ').toLowerCase();

  const metricKeywords: Array<{ keyword: string; suffix: string }> = [
    { keyword: 'ammonia', suffix: 'ammonia' },
    { keyword: 'nh3', suffix: 'ammonia' },
    { keyword: 'dissolved_oxygen', suffix: 'dissolved_oxygen' },
    { keyword: 'oksijen', suffix: 'dissolved_oxygen' },
    { keyword: 'do_', suffix: 'dissolved_oxygen' },
    { keyword: 'temperature', suffix: 'temperature' },
    { keyword: 'sicaklik', suffix: 'temperature' },
    { keyword: 'density', suffix: 'density_overload' },
    { keyword: 'yogunluk', suffix: 'density_overload' },
    { keyword: 'feeding', suffix: 'feeding_excess' },
    { keyword: 'besleme', suffix: 'feeding_excess' },
    { keyword: 'overfeeding', suffix: 'feeding_excess' },
  ];

  for (const { keyword, suffix } of metricKeywords) {
    if (evidenceStr.includes(keyword)) {
      // Birlesik anahtari dene
      const compositeKey = `${eventType}_${suffix}`;
      const compositeMatch = TRIGGER_MAP[compositeKey];
      if (compositeMatch) return compositeMatch;

      // Suffix'i dogrudan dene
      const suffixMatch = TRIGGER_MAP[suffix];
      if (suffixMatch) return suffixMatch;
    }
  }

  return null;
}

/**
 * Tetikleyici icin onerilen aksiyonlari dondurur.
 *
 * predictCascade'in alt fonksiyonu — sadece aksiyon listesi gereken
 * durumlarda kullanilir (tam tahmin gerekmediginde).
 *
 * @param trigger - Tetikleyici olay turu
 * @returns Onerilen aksiyonlar veya bos dizi
 */
export function getRecommendedActions(
  trigger: string,
): CascadeChain['recommendedActions'] {
  const chain = KNOWN_CASCADES.find(c => c.trigger === trigger);
  return chain?.recommendedActions ?? [];
}
