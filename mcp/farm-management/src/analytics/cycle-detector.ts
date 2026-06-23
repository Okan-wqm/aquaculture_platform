// ============================================================================
// MCP Farm Intelligence Server — Kotu Dongu Tespit Motoru (Cycle Detector)
// ============================================================================
//
// Mevcut anomalileri bilinen kotu dongu kaliplariyla eslestirir.
// Erken tespit sayesinde dongulerin kırılmasini saglar.
//
// NASIL CALISIR:
//   1. Aktif anomaliler listesi alinir (detectAnomalies ciktisi)
//   2. Her anomali, bilinen dongu koşullarına (condition) eslenir:
//      Ornek: anomali type='feeding_variance' → condition 'feeding_variance'
//      Ornek: anomali type='wq_deviation' + metric='ammonia' → condition 'ammonia'
//   3. Her bilinen dongu icin knowledge/vicious-cycles.ts'deki
//      detectCycleStage() fonksiyonu cagirilir
//   4. Asama tespiti knowledge'daki stage tanimlarindan gelir:
//      - Her stage kendi conditions, interventionWindow ve suggestedBreak'ini tasir
//      - En ciddi eslesen stage (critical > active > early) secilir
//   5. Her tespit edilen dongu icin:
//      - Etkilenen varliklar (tanklar, batch'ler)
//      - Mudahale penceresi (stage'den)
//      - Donguyu kirma onerisi (stage'den)
//      - Guven skoru
//      bilgisi eklenir
//
// KOTU DONGU MANTIGI:
//   Akvakulturdeki kotu donguler, birden fazla sorunun birbirini
//   beslemesiyle olusan kendi kendini guclendiren durumlardir.
//   Ornegin:
//     NH3 yukselir → baliklar strese girer → istah duser →
//     yenmeyen yem curuyor → NH3 daha da yukselir → ...
//   Bu motor, dongulerin erken asamada tespit edilmesini
//   ve kirilmasini saglar.
//
// EXTENSIBLE:
//   - Yeni dongu kaliplari knowledge/vicious-cycles.ts dosyasina eklenir
//   - Anomali → kosul eslemesi ANOMALY_TO_CONDITIONS haritasi ile genisletilir
// ============================================================================

import { VICIOUS_CYCLES, detectCycleStage } from '../knowledge/vicious-cycles.js';

import type { Anomaly } from './anomaly-detector.js';

// ── Tip Tanimlari ─────────────────────────────────────────────────────────────

/**
 * Tespit edilen bir kotu dongu.
 */
export interface DetectedCycle {
  /** Dongu kimlik bilgisi */
  cycleId: string;

  /**
   * Dongunun asamasi:
   *   - 'early': Bazi kosullar eslesti — dongu baslamak uzere.
   *     En iyi mudahale penceresi buras burada.
   *   - 'active': Cogu kosul eslesti — dongu calisiyor.
   *     Acil mudahale gerekli.
   *   - 'critical': Neredeyse tum kosullar eslesti — dongu tam guçle devam ediyor.
   *     Agresif mudahale sart, kayip kacinilmaz olabilir.
   */
  stage: 'early' | 'active' | 'critical';

  /** Etkilenen varliklar (anomalilerden turetilir) */
  affectedEntities: Array<{ type: string; id: string; name: string }>;

  /** Aktif kosul isimleri (hangi anomaliler bu donguyu tetikliyor) */
  chain: string[];

  /** Tahmini mudahale penceresi */
  interventionWindow: string;

  /** Donguyu kirma onerisi */
  suggestedBreak: string;

  /** Tespit guven skoru (0-1) */
  confidence: number;
}

// ── Anomali → Kosul Esleme Haritasi ──────────────────────────────────────────
//
// Anomali tipleri ve metrikleri, dongu kosullarina eslenir.
// Bu harita detectViciousCycles fonksiyonunda kullanilir.
//
// Kosul isimleri knowledge/vicious-cycles.ts'deki ViciousCycleCondition.metric
// degerleriyle dogrudan eslesmektedir — araya adapter katmani yoktur.
//
// Esleme mantigi:
//   - Bazi eslemeler sadece anomali tipine bakar
//     (ornegin 'mortality_spike' → 'mortality_increase')
//   - Bazi eslemeler hem tipe hem metrige bakar
//     (ornegin 'wq_deviation' + metric='ammonia' → 'ammonia')
//
// EXTENSIBLE: Yeni anomali tipleri eklendikce bu harita genisletilir.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Anomali tipinden kosul(lar)a esleme.
 *
 * Anahtar: anomali type degeri
 * Deger: fonksiyon — anomalinin metrik ve trend bilgisine bakarak kosul(lar) uretir
 *
 * Uretilen kosul isimleri knowledge/vicious-cycles.ts'deki
 * ViciousCycleCondition.metric alanlariyla dogrudan eslesmektedir.
 */
const ANOMALY_TO_CONDITIONS: Record<string, (anomaly: Anomaly) => string[]> = {
  // Mortalite sivrilemesi → mortalite artisi kosulu
  mortality_spike: () => ['mortality_increase'],

  // WQ sapmasi → metrige gore farkli kosullar
  wq_deviation: (anomaly: Anomaly) => {
    const conditions: string[] = [];
    const metric = anomaly.metric.toLowerCase();

    if (metric.includes('ammonia') || metric === 'nh3') {
      conditions.push('ammonia');
    }
    if (metric.includes('nitrite') || metric === 'no2') {
      conditions.push('nitrite');
    }
    if (metric.includes('dissolved_oxygen') || metric === 'do') {
      conditions.push('dissolved_oxygen');
    }
    if (metric.includes('temperature')) {
      conditions.push('temperature');
    }
    if (metric.includes('ph')) {
      conditions.push('ph');
    }

    // Genel WQ bozulmasi kosulu
    if (conditions.length === 0) {
      conditions.push('wq_degradation');
    }

    return conditions;
  },

  // Buyume yavasiamasi → buyume dususu kosulu
  growth_slowdown: () => ['sgr'],

  // FCR bozulmasi → verimlilik dususu kosulu
  fcr_degradation: () => ['fcr'],

  // Besleme varyansi → besleme ve istah kosullari
  feeding_variance: (anomaly: Anomaly) => {
    if (anomaly.metric.includes('deficit') || anomaly.currentValue < anomaly.expectedValue) {
      return ['feeding_variance', 'appetite'];
    }
    return ['feeding_variance'];
  },

  // Yogunluk asimi
  density_overload: () => ['stocking_density'],

  // Istah kaybi
  appetite_loss: () => ['appetite', 'feeding_variance'],

  // Biofiltre stresi
  biofilter_stress: () => ['ammonia', 'nitrite', 'biofilter_status'],

  // Geciken bakim
  overdue_maintenance: () => ['maintenance_overdue'],

  // Metabolik stres (sicaklik-oksijen krizi icin)
  metabolic_stress: () => ['metabolic_stress'],

  // Agresyon belirtileri (yogunluk-stres spirali icin)
  aggression: () => ['aggression'],
};

// ── Ana Fonksiyon ─────────────────────────────────────────────────────────────

/**
 * Mevcut anomalileri bilinen kotu dongu kaliplariyla eslestirir.
 *
 * Dongu kaliplari ve asama tespiti knowledge/vicious-cycles.ts'den gelir.
 * Bu fonksiyon sadece anomali → kosul donusumunu ve sonuc montajini yapar.
 *
 * NASIL CALISIR:
 *   1. Anomali listesi, dongu kosullarına (conditions) cevirilir
 *      ANOMALY_TO_CONDITIONS haritasi kullanılarak
 *   2. Her VICIOUS_CYCLES icin knowledge'daki detectCycleStage() cagirilir
 *   3. Eslesen donguler icin etkilenen varliklar, guven skoru hesaplanir
 *   4. Sonuclar ciddiyet sirasina gore siralanir
 *
 * @param anomalies - Aktif anomaliler listesi (detectAnomalies ciktisi)
 * @returns Tespit edilen kotu donguler
 */
export function detectViciousCycles(anomalies: Anomaly[]): DetectedCycle[] {
  const detectedCycles: DetectedCycle[] = [];

  // ── Adim 1: Anomalileri kosullara cevir ────────────────────
  // Her anomaliden bir veya birden fazla kosul uretilir
  const activeConditions = new Set<string>();
  const conditionToEntities = new Map<string, Array<{ type: string; id: string; name: string }>>();

  for (const anomaly of anomalies) {
    const mapper = ANOMALY_TO_CONDITIONS[anomaly.type];
    if (!mapper) continue;

    const conditions = mapper(anomaly);
    for (const condition of conditions) {
      activeConditions.add(condition);

      // Kosulun etkiledigi varliklari kaydet
      if (!conditionToEntities.has(condition)) {
        conditionToEntities.set(condition, []);
      }
      const entities = conditionToEntities.get(condition)!;

      // Anomalinin entity'sini ekle (tekrar onleme)
      const exists = entities.some(e => e.id === anomaly.entity.id && e.type === anomaly.entity.type);
      if (!exists) {
        entities.push(anomaly.entity);
      }

      // Iliskili varliklari da ekle
      for (const related of anomaly.relatedEntities) {
        const relExists = entities.some(e => e.id === related.id && e.type === related.type);
        if (!relExists) {
          entities.push(related);
        }
      }
    }
  }

  // ── Adim 2: Her bilinen donguyu kontrol et ─────────────────
  // Knowledge'daki detectCycleStage() fonksiyonunu dogrudan kullan.
  // Stage tespiti, interventionWindow ve suggestedBreak tamamen
  // knowledge katmanindan gelir — araya adapter katmani yoktur.
  const activeConditionsList = [...activeConditions];

  for (const cycle of VICIOUS_CYCLES) {
    const result = detectCycleStage(cycle.id, activeConditionsList);
    if (!result) continue;

    const { stage: matchedStage } = result;

    // Eslesen kosullari bul (chain icin)
    const cycleConditionMetrics = cycle.conditions.map(c => c.metric);
    const matchedConditions = cycleConditionMetrics.filter(c => activeConditions.has(c));

    // ── Adim 3: Etkilenen varliklari topla ───────────────────
    const allEntities: Array<{ type: string; id: string; name: string }> = [];
    const entityIds = new Set<string>();

    for (const condition of matchedConditions) {
      const entities = conditionToEntities.get(condition) ?? [];
      for (const entity of entities) {
        const key = `${entity.type}:${entity.id}`;
        if (!entityIds.has(key)) {
          entityIds.add(key);
          allEntities.push(entity);
        }
      }
    }

    // ── Adim 4: Guven skoru hesapla ──────────────────────────
    // Kapanis oranina, anomali sayisina ve anomali guvenine dayali
    const matchRatio = matchedConditions.length / cycleConditionMetrics.length;

    const relatedAnomalies = anomalies.filter(a => {
      const mapper = ANOMALY_TO_CONDITIONS[a.type];
      if (!mapper) return false;
      const conditions = mapper(a);
      return conditions.some(c => matchedConditions.includes(c));
    });

    const avgConfidence = relatedAnomalies.length > 0
      ? relatedAnomalies.reduce((sum, a) => sum + a.confidence, 0) / relatedAnomalies.length
      : 0.5;

    // Guven = eslesme orani * anomali guveni ortalaması
    const confidence = Math.round(matchRatio * avgConfidence * 1000) / 1000;

    // ── Donguyu kaydet ───────────────────────────────────────
    // interventionWindow ve suggestedBreak dogrudan knowledge
    // stage'inden gelir — adapter/fallback yok.
    detectedCycles.push({
      cycleId: cycle.id,
      stage: matchedStage.stage,
      affectedEntities: allEntities,
      chain: matchedConditions,
      interventionWindow: matchedStage.interventionWindow,
      suggestedBreak: matchedStage.suggestedBreak,
      confidence,
    });
  }

  // ── Ciddiyet sirasina gore sirala ──────────────────────────
  const stageOrder: Record<string, number> = { critical: 0, active: 1, early: 2 };
  detectedCycles.sort((a, b) =>
    (stageOrder[a.stage] ?? 3) - (stageOrder[b.stage] ?? 3),
  );

  return detectedCycles;
}
