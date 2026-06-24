// ============================================================================
// MCP Farm Intelligence Server — Optimizasyon Firsat Motoru (Optimizer)
// ============================================================================
//
// Risk durumunun yani sira, iyilestirme firsatlarini tespit eder.
// Bu motor "kotu olan ne?" degil "daha iyi olabilecek ne?" sorusuna yanitlar.
//
// NASIL CALISIR:
//   1. Mevcut kosullar analiz edilir (WQ, besleme, buyume, yogunluk)
//   2. "Iyi" kosullarin varliginda firsat tespiti yapilir:
//      - Su kalitesi stabil ve optimal → besleme frekansini artir
//      - Yogunluk optimal araligin ustunde → bol/hasat one
//      - Batch hedef agirlğa yakin → hasat zamanlama onerisi
//      - Sicaklik degisti → yem oranini ayarla
//      - WQ parametreleri marjinla optimal → su degisimini azalt (maliyet tasarrufu)
//   3. Her firsat icin beklenen iyilesme ve guven skoru hesaplanir
//   4. Firsatlar guven skoruna gore siralanir
//
// FARK: Risk Scorer vs Optimizer
//   - Risk Scorer: "Neyin kotulestigi" → alarm ve mudahale
//   - Optimizer: "Neyin iyilestirilebilecegi" → firsat ve oneri
//   Ikisi birbirini tamamlar: biri savunma, digeri saldiri stratejisi.
//
// FIRSATLAR VE BİLİMSEL TEMELLER:
//   1. Besleme frekansı artisi:
//      DO iyi + WQ stabil → sindirim kapasitesi tam kullanilabilir
//      Bilimsel temel: Baliklarda gastrik bosalma suresi sabittir;
//      kucuk porsiyonlarla sik besleme daha iyi FCR saglar (Cho & Bureau, 2001)
//
//   2. Stoklama yogunlugu optimizasyonu:
//      Yogunluk optimal araligin ustunde → buyume yavasiamasi baslar
//      Bilimsel temel: Ellis et al. (2002) — yogunluk-buyume ters iliskisi
//
//   3. Hasat zamanlama:
//      SGR ile hedef agirlğa kalan gun hesaplanir
//      Bilimsel temel: SGR = (ln(W2) - ln(W1)) / gun * 100
//      Bu formulden Wt = W0 * e^(SGR/100 * t) turetilir
//
//   4. Sicaklik bazli yem ayarlama:
//      Metabolizma sicakliga baglidir (Q10 kurali)
//      Bilimsel temel: Her 10°C artis metabolizmayi ~2x hizlandirir
//
//   5. Su degisimi optimizasyonu:
//      WQ parametreleri marjinla optimal → gereksiz su degisimi = maliyet
//      Bilimsel temel: Enerji ve su tasarrufu (Timmons & Ebeling, 2013)
//
// EXTENSIBLE:
//   - Yeni firsat turleri detectXxx fonksiyonlari ile eklenebilir
//   - OptimizerInput yeni veri alanlariyla genisletilebilir
//   - Beklenen iyilesme degerleri konfigure edilebilir
// ============================================================================

import { getThresholds, type SpeciesThresholds } from '../knowledge/thresholds.js';
import { mean, linearRegressionSlope } from '../utils/stats.js';

// ── Tip Tanimlari ─────────────────────────────────────────────────────────────

/**
 * Tespit edilen tek bir optimizasyon firsati.
 */
export interface Opportunity {
  /**
   * Firsat turu:
   *   - 'feeding_frequency': Besleme frekansini artirma
   *   - 'stocking_density_optimization': Yogunluk optimizasyonu
   *   - 'harvest_timing': Hasat zamanlama
   *   - 'temperature_feeding_adjustment': Sicaklik bazli yem ayarlama
   *   - 'water_exchange_optimization': Su degisimi optimizasyonu
   */
  type: string;

  /** Firsatin ilgili oldugu varlik (tank, batch) */
  entity: { type: string; id: string; name: string };

  /** Mevcut durum aciklamasi */
  current: string;

  /** Onerilen degisiklik */
  suggested: string;

  /** Degisikligin gerekçesi (Turkce) */
  rationale: string;

  /** Beklenen iyilesme miktari ve turu */
  expectedImprovement: string;

  /** Onerinin guven skoru (0-1) — veri kalitesine dayali */
  confidence: number;

  /** Onerinin dayandigi veri kaynagi */
  basedOn: string;
}

/**
 * Optimizer girdi verisi.
 * Mevcut kosullarin analiz edilmesi icin gerekli tum veriler.
 */
export interface OptimizerInput {
  /** Tank bilgileri */
  tanks?: Array<{
    id: string;
    name: string;
    currentBiomass: number;
    volume: number;
    maxDensity: number;
  }>;

  /** Batch bilgileri */
  batches?: Array<{
    id: string;
    name: string;
    tankId: string;
    currentAvgWeight: number;
    targetWeight: number;
    sgr?: number;
    startDate: string;
  }>;

  /** Son besleme kayitlari */
  feedingRecords?: Array<{
    date: string;
    batchId: string;
    tankId?: string;
    planned: number;
    actual: number;
    frequency?: number;
  }>;

  /** Son WQ olcumleri */
  waterQuality?: Array<{
    tankId: string;
    temperature?: number;
    ph?: number;
    dissolvedOxygen?: number;
    ammonia?: number;
    nitrite?: number;
    nitrate?: number;
  }>;

  /** Buyume olcumleri (SGR hesabi icin) */
  growthData?: Array<{
    batchId: string;
    date: string;
    avgWeight: number;
    sgr?: number;
  }>;

  /** Tur bazli esik degerleri */
  speciesThresholds?: SpeciesThresholds;
}

// ── Ana Fonksiyon ─────────────────────────────────────────────────────────────

/**
 * Mevcut kosullar analiz ederek optimizasyon firsatlarini tespit eder.
 *
 * NASIL CALISIR:
 *   1. Her firsat turu icin ilgili detect fonksiyonu cagirilir
 *   2. Sadece kosullar uygun oldugunda firsat olusturulur
 *   3. Tum firsatlar birlestirilir ve guven skoruna gore siralanir (yuksek guven basta)
 *
 * @param input - Analiz edilecek veriler
 * @returns Tespit edilen firsatlar listesi
 */
export function detectOpportunities(input: OptimizerInput): Opportunity[] {
  const opportunities: Opportunity[] = [];
  const thresholds = input.speciesThresholds;

  // ── 1. Besleme frekansı optimizasyonu ──────────────────────
  opportunities.push(...detectFeedingFrequencyOpportunity(input, thresholds));

  // ── 2. Stoklama yogunlugu optimizasyonu ────────────────────
  opportunities.push(...detectStockingDensityOpportunity(input, thresholds));

  // ── 3. Hasat zamanlama ─────────────────────────────────────
  opportunities.push(...detectHarvestTimingOpportunity(input));

  // ── 4. Sicaklik bazli yem ayarlama ─────────────────────────
  opportunities.push(...detectTemperatureFeedingAdjustment(input, thresholds));

  // ── 5. Su degisimi optimizasyonu ───────────────────────────
  opportunities.push(...detectWaterExchangeOptimization(input, thresholds));

  // ── Guven skoruna gore sirala (yuksek guven basta) ─────────
  opportunities.sort((a, b) => b.confidence - a.confidence);

  return opportunities;
}

// ── Firsat Tespit Fonksiyonlari ──────────────────────────────────────────────

/**
 * 1. Besleme frekansı optimizasyonu tespiti.
 *
 * NASIL CALISIR:
 *   Kosullar:
 *     a) DO > optimal degerin %90'i (yeterli oksijen var)
 *     b) WQ parametreleri stabil (son olcumler optimal aralıkta)
 *     c) Mevcut FCR endustri ortalamasinin ustunde (iyilestirme mümkün)
 *   Tum kosullar karsilanirsa:
 *     → Besleme frekansini artirma onerisi
 *     → Beklenen iyilesme: FCR'da ~%8 dusus
 *
 * Bilimsel temel:
 *   Kucuk porsiyonlarla sik besleme, balik sindirim sistemini daha verimli
 *   kullandirir. Gastrik bosalma suresi sabittir (turden ture degisir),
 *   bu nedenle buyuk porsiyonlarin bir kismi hazmedilmeden atilabilir.
 *   Sik besleme bu israfi azaltir → FCR duser.
 */
function detectFeedingFrequencyOpportunity(
  input: OptimizerInput,
  thresholds?: SpeciesThresholds,
): Opportunity[] {
  const opportunities: Opportunity[] = [];

  if (!input.waterQuality || !input.feedingRecords || !input.tanks) return opportunities;

  const t = thresholds ?? getThresholds();

  // Her tank icin degerlendirme
  for (const tank of input.tanks) {
    // Tank WQ verileri
    const tankWQ = input.waterQuality.filter(wq => wq.tankId === tank.id);
    if (tankWQ.length === 0) continue;

    // Kosul (a): DO yeterli mi?
    // DO > optimal'in %90'i → oksijen bolca var
    const doValues = tankWQ
      .map(wq => wq.dissolvedOxygen)
      .filter((v): v is number => v !== undefined);

    if (doValues.length === 0) continue;
    const avgDO = mean(doValues);
    const doThreshold = t.dissolvedOxygen.optimal * 0.9;
    if (avgDO < doThreshold) continue; // DO yetersiz, besleme artırma riskli

    // Kosul (b): WQ stabil mi?
    // NH3 uyari esiginin altinda → WQ iyi
    const nh3Values = tankWQ
      .map(wq => wq.ammonia)
      .filter((v): v is number => v !== undefined);
    const avgNH3 = nh3Values.length > 0 ? mean(nh3Values) : 0;
    if (avgNH3 > t.ammonia.warning) continue; // NH3 yuksek, besleme artırma yanlis

    // Kosul (c): Mevcut FCR hedefin ustunde mi?
    // Bu tankla iliskili besleme kayitlari
    const tankFeeding = input.feedingRecords.filter(f => f.tankId === tank.id);
    if (tankFeeding.length === 0) continue;

    // Mevcut besleme frekansini tahmin et
    const frequencies = tankFeeding
      .map(f => f.frequency)
      .filter((v): v is number => v !== undefined);
    const currentFreq = frequencies.length > 0 ? mean(frequencies) : 2; // varsayilan 2 ogun

    // 4+ ogun zaten yapiliyorsa fazla artirmanin etkisi azalir
    if (currentFreq >= 4) continue;

    // Tum kosullar karsilandi — firsat olustur
    opportunities.push({
      type: 'feeding_frequency',
      entity: { type: 'tank', id: tank.id, name: tank.name },
      current: `Gunluk ${Math.round(currentFreq)} ogun besleme`,
      suggested: `Gunluk ${Math.round(currentFreq) + 1}-${Math.round(currentFreq) + 2} ogune cikarin (ayni toplam miktarda, daha kucuk porsiyonlar)`,
      rationale:
        'DO seviyesi yeterli ve WQ parametreleri stabil. ' +
        'Kucuk porsiyonlarla sik besleme sindirim verimliligini artirir.',
      expectedImprovement: 'FCR\'da tahmini %8 iyilesme (daha az yem israfi)',
      confidence: calculateOpportunityConfidence(doValues.length + nh3Values.length, [avgDO > doThreshold, avgNH3 < t.ammonia.warning]),
      basedOn: `${doValues.length} DO olcumu, ${nh3Values.length} NH3 olcumu, ${tankFeeding.length} besleme kaydi`,
    });
  }

  return opportunities;
}

/**
 * 2. Stoklama yogunlugu optimizasyonu tespiti.
 *
 * NASIL CALISIR:
 *   Kosul: yogunluk > optimal araligin %110'u
 *   Eger yogunluk optimal araligin cok ustundeyse:
 *     → Bol/hasat onerisi
 *     → Beklenen iyilesme: buyume hizinda ~%12 artis
 *
 * Bilimsel temel:
 *   Yogunluk-buyume iliskisi negatiftir: yogunluk arttikca buyume
 *   yavasilar (stres, rekabet, WQ bozulmasi).
 *   Ellis et al. (2002): optimal yogunlugun %10 ustunde buyume
 *   belirgin olarak yavasilar.
 */
function detectStockingDensityOpportunity(
  input: OptimizerInput,
  thresholds?: SpeciesThresholds,
): Opportunity[] {
  const opportunities: Opportunity[] = [];

  if (!input.tanks) return opportunities;

  const optimalDensity = thresholds?.optimalDensity ?? 15;

  for (const tank of input.tanks) {
    if (tank.volume <= 0) continue;

    const currentDensity = tank.currentBiomass / tank.volume;

    // Yogunluk optimal araligin %110'unun ustunde mi?
    // Bu esik, buyume uzerinde olculebilir negatif etki basladigini gosterir
    if (currentDensity > optimalDensity * 1.1) {
      const excessPercent = Math.round((currentDensity / optimalDensity - 1) * 100);

      opportunities.push({
        type: 'stocking_density_optimization',
        entity: { type: 'tank', id: tank.id, name: tank.name },
        current: `Mevcut yogunluk: ${currentDensity.toFixed(1)} kg/m³ (optimal: ${optimalDensity} kg/m³)`,
        suggested: `Yogunlugu ${optimalDensity} kg/m³ civarina dusurun — batch bolme veya erken hasat ile`,
        rationale:
          `Yogunluk optimal araligin %${excessPercent} ustunde. ` +
          'Yuksek yogunluk stres, WQ bozulmasi ve buyume yavasilamasina neden olur.',
        expectedImprovement: 'Buyume hizinda tahmini %12 artis, FCR\'da iyilesme',
        confidence: 0.85, // Yogunluk verisi genelde kesin
        basedOn: `Tank hacim: ${tank.volume}m³, biyokutle: ${tank.currentBiomass}kg`,
      });
    }
  }

  return opportunities;
}

/**
 * 3. Hasat zamanlama onerisi.
 *
 * NASIL CALISIR:
 *   1. Her batch icin mevcut agirlik ve hedef agirlik alinir
 *   2. Mevcut SGR ile hedef agirliga kalan gun hesaplanir:
 *      Wt = W0 * e^(SGR/100 * t)
 *      → t = ln(Wt/W0) / (SGR/100)
 *   3. Hedef agirlığa 14 gundern az kaldiysa → hasat zamanlama onerisi
 *
 * Bilimsel temel:
 *   SGR (Specific Growth Rate) = (ln(W2) - ln(W1)) / gun * 100
 *   Bu formulden turetilen buyume projeksiyonu:
 *   Wt = W0 * e^(SGR/100 * t)
 *   Bu ustel model kısa vadede (birkaç hafta) gercekci tahminler verir.
 */
function detectHarvestTimingOpportunity(
  input: OptimizerInput,
): Opportunity[] {
  const opportunities: Opportunity[] = [];

  if (!input.batches || !input.growthData) return opportunities;

  for (const batch of input.batches) {
    if (batch.targetWeight <= 0 || batch.currentAvgWeight <= 0) continue;
    if (batch.currentAvgWeight >= batch.targetWeight) {
      // Zaten hedef agirlikta veya ustunde → hemen hasat onerisi
      opportunities.push({
        type: 'harvest_timing',
        entity: { type: 'batch', id: batch.id, name: batch.name },
        current: `Mevcut agirlik: ${batch.currentAvgWeight.toFixed(0)}g (hedef: ${batch.targetWeight.toFixed(0)}g)`,
        suggested: 'Hedef agirliga ulasildi — hasat planlanmali',
        rationale:
          'Batch hedef agirliga ulasti. Gecikmeli hasat yogunluk artisina, ' +
          'WQ bozulmasina ve FCR kotulesmesine neden olabilir.',
        expectedImprovement: 'Zamaninda hasat ile yogunluk ve WQ kontrolu korunur',
        confidence: 0.95,
        basedOn: `Batch agirlik: ${batch.currentAvgWeight.toFixed(0)}g, hedef: ${batch.targetWeight.toFixed(0)}g`,
      });
      continue;
    }

    // SGR hesabi — batch'ten veya buyume verilerinden
    let sgr = batch.sgr;

    if (sgr === undefined) {
      // Buyume verilerinden SGR hesapla
      const batchGrowth = input.growthData
        .filter(g => g.batchId === batch.id)
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      if (batchGrowth.length >= 2) {
        // SGR direkt saglanmissa son degerini kullan
        const lastWithSgr = batchGrowth.filter(g => g.sgr !== undefined);
        if (lastWithSgr.length > 0) {
          sgr = lastWithSgr[lastWithSgr.length - 1]!.sgr;
        } else {
          // Agirliktan hesapla
          const first = batchGrowth[0]!;
          const last = batchGrowth[batchGrowth.length - 1]!;
          const days = (new Date(last.date).getTime() - new Date(first.date).getTime()) / (1000 * 60 * 60 * 24);
          if (days > 0 && first.avgWeight > 0 && last.avgWeight > 0) {
            sgr = (Math.log(last.avgWeight) - Math.log(first.avgWeight)) / days * 100;
          }
        }
      }
    }

    // SGR yoksa bu batch icin tahmin yapamayiz
    if (sgr === undefined || sgr <= 0) continue;

    // Kalan gun hesabi:
    // Wt = W0 * e^(SGR/100 * t)
    // t = ln(Wt / W0) / (SGR / 100)
    const daysToTarget = Math.log(batch.targetWeight / batch.currentAvgWeight) / (sgr / 100);
    const roundedDays = Math.round(daysToTarget);

    // 14 gundern az kaldiysa → zamanlama onerisi
    if (roundedDays > 0 && roundedDays <= 14) {
      // Tahmini hasat tarihi
      const harvestDate = new Date();
      harvestDate.setDate(harvestDate.getDate() + roundedDays);
      const harvestDateStr = harvestDate.toISOString().split('T')[0];

      opportunities.push({
        type: 'harvest_timing',
        entity: { type: 'batch', id: batch.id, name: batch.name },
        current: `Mevcut agirlik: ${batch.currentAvgWeight.toFixed(0)}g, SGR: %${sgr.toFixed(2)}/gun`,
        suggested: `Tahmini hasat tarihi: ${harvestDateStr} (${roundedDays} gun sonra)`,
        rationale:
          `Mevcut buyume hizi ile hedef agirlik (${batch.targetWeight.toFixed(0)}g) ` +
          `${roundedDays} gun icinde ulasilacak. Hasat lojistigini simdiden planlayin.`,
        expectedImprovement: 'Zamaninda hasat ile optimal pazar agirliginda satis',
        confidence: calculateSGRConfidence(sgr, input.growthData?.filter(g => g.batchId === batch.id).length ?? 0),
        basedOn: `SGR: %${sgr.toFixed(2)}/gun, ${input.growthData?.filter(g => g.batchId === batch.id).length ?? 0} buyume olcumu`,
      });
    }
  }

  return opportunities;
}

/**
 * 4. Sicaklik bazli yem ayarlama onerisi.
 *
 * NASIL CALISIR:
 *   1. Mevcut su sicakligi ile optimal sicaklik karsilastirilir
 *   2. Sicaklik optimalden farkli ise metabolizma degisir:
 *      - Sicaklik > optimal → metabolizma hizlanir → yem arttirilabilir (dikkatli)
 *      - Sicaklik < optimal → metabolizma yavasilar → yem azaltilmali
 *   3. Ayarlama orani hesaplanir (Q10 kuralina dayali yaklasim)
 *
 * Q10 Kurali:
 *   Her 10°C sicaklik artisinda metabolik hiz ~2x artar.
 *   Yaklasim: yem_ayarlama_orani = 2^((mevcut - optimal) / 10) - ters yonlu
 *   Dusuk sicaklikta yem azaltmak, yuksek sicaklikta dikkatli artirmak gerekir.
 *   UYARI: Yuksek sicaklikta yem artirmak riskli olabilir (DO dususu + NH3 artisi)
 */
function detectTemperatureFeedingAdjustment(
  input: OptimizerInput,
  thresholds?: SpeciesThresholds,
): Opportunity[] {
  const opportunities: Opportunity[] = [];

  if (!input.waterQuality || !input.tanks) return opportunities;

  const optimalTemp = thresholds?.temperature.optimal ?? 20;
  const tempMin = thresholds?.temperature.min ?? 15;
  const tempMax = thresholds?.temperature.max ?? 25;

  for (const tank of input.tanks) {
    const tankWQ = input.waterQuality.filter(wq => wq.tankId === tank.id);
    const tempValues = tankWQ
      .map(wq => wq.temperature)
      .filter((v): v is number => v !== undefined);

    if (tempValues.length === 0) continue;

    const avgTemp = mean(tempValues);

    // Sicaklik optimal araliktaysa ayarlama onerilmez
    // "Optimal aralik" toleransi: +/- 2°C
    if (Math.abs(avgTemp - optimalTemp) < 2) continue;

    // Sicaklik normal araligin DISINDAYSA bu bir risk durumu, optimizasyon degil
    if (avgTemp < tempMin || avgTemp > tempMax) continue;

    // Sicaklik farkına gore yem ayarlama oranı
    const tempDiff = avgTemp - optimalTemp;

    if (tempDiff > 0) {
      // Sicaklik yuksek → metabolizma hizli → DIKKATLI yem artirma onerilir
      // Ama sadece DO iyi durumda ise
      const doValues = tankWQ
        .map(wq => wq.dissolvedOxygen)
        .filter((v): v is number => v !== undefined);
      const avgDO = doValues.length > 0 ? mean(doValues) : 0;

      if (avgDO < (thresholds?.dissolvedOxygen.optimal ?? 7) * 0.85) continue; // DO yetersiz

      const adjustPercent = Math.min(15, Math.round(tempDiff * 3)); // Max %15 artis

      opportunities.push({
        type: 'temperature_feeding_adjustment',
        entity: { type: 'tank', id: tank.id, name: tank.name },
        current: `Su sicakligi: ${avgTemp.toFixed(1)}°C (optimal: ${optimalTemp}°C)`,
        suggested: `Yem miktarini %${adjustPercent} artirin — artan metabolik hiz nedeniyle`,
        rationale:
          `Sicaklik optimalin ${tempDiff.toFixed(1)}°C ustunde. Metabolizma hizlanmis durumda, ` +
          'DO seviyesi yeterli. Dikkatli yem artisi buyumeyi destekleyebilir.',
        expectedImprovement: `Buyume hizinda tahmini %${Math.round(adjustPercent * 0.6)} artis`,
        confidence: calculateOpportunityConfidence(tempValues.length + (doValues.length), [true, avgDO > (thresholds?.dissolvedOxygen.optimal ?? 7) * 0.85]),
        basedOn: `${tempValues.length} sicaklik olcumu, ortalama: ${avgTemp.toFixed(1)}°C`,
      });
    } else {
      // Sicaklik dusuk → metabolizma yavas → yem azaltma
      const reducePercent = Math.min(25, Math.round(Math.abs(tempDiff) * 4)); // Max %25 azaltma

      opportunities.push({
        type: 'temperature_feeding_adjustment',
        entity: { type: 'tank', id: tank.id, name: tank.name },
        current: `Su sicakligi: ${avgTemp.toFixed(1)}°C (optimal: ${optimalTemp}°C)`,
        suggested: `Yem miktarini %${reducePercent} azaltin — yavaslamis metabolizma nedeniyle`,
        rationale:
          `Sicaklik optimalin ${Math.abs(tempDiff).toFixed(1)}°C altinda. Metabolizma yavasladi, ` +
          'fazla yem sindirilmeden atilir → FCR kotulesir ve su kalitesi bozulur.',
        expectedImprovement: `FCR'da tahmini %${Math.round(reducePercent * 0.5)} iyilesme, WQ korumasi`,
        confidence: calculateOpportunityConfidence(tempValues.length, [true]),
        basedOn: `${tempValues.length} sicaklik olcumu, ortalama: ${avgTemp.toFixed(1)}°C`,
      });
    }
  }

  return opportunities;
}

/**
 * 5. Su degisimi optimizasyonu onerisi.
 *
 * NASIL CALISIR:
 *   1. Tum WQ parametreleri kontrol edilir
 *   2. Tum parametreler optimal araliktaysa VE marjin varsa
 *      (ornegin NH3 < uyari esiginin %50'si):
 *      → Su degisim oranini azaltma onerisi
 *      → Beklenen tasarruf: enerji ve su maliyeti
 *
 * Neden bu optimizasyon?
 *   Su degisimi en buyuk operasyonel maliyetlerden biridir:
 *   - Pompalama enerjisi
 *   - Isitma/sogutma enerjisi (yeni su sicakligini ayarlama)
 *   - Su temini maliyeti (ozellikle RAS sistemlerde)
 *   WQ zaten iyi durumdaysa, gereksiz su degisimi kaynak israfidir.
 */
function detectWaterExchangeOptimization(
  input: OptimizerInput,
  thresholds?: SpeciesThresholds,
): Opportunity[] {
  const opportunities: Opportunity[] = [];

  if (!input.waterQuality || !input.tanks) return opportunities;

  const t = thresholds ?? getThresholds();

  for (const tank of input.tanks) {
    const tankWQ = input.waterQuality.filter(wq => wq.tankId === tank.id);
    if (tankWQ.length === 0) continue;

    // Tum parametreleri kontrol et — hepsi marjinla optimal mi?
    let allOptimal = true;
    let paramCount = 0;
    let goodParamCount = 0;

    for (const wq of tankWQ) {
      // NH3 < uyari esiginin %50'si?
      if (wq.ammonia !== undefined) {
        paramCount++;
        if (wq.ammonia < t.ammonia.warning * 0.5) goodParamCount++;
        else allOptimal = false;
      }

      // NO2 < uyari esiginin %50'si?
      if (wq.nitrite !== undefined) {
        paramCount++;
        if (wq.nitrite < t.nitrite.warning * 0.5) goodParamCount++;
        else allOptimal = false;
      }

      // NO3 < uyari esiginin %50'si?
      if (wq.nitrate !== undefined) {
        paramCount++;
        if (wq.nitrate < t.nitrate.warning * 0.5) goodParamCount++;
        else allOptimal = false;
      }

      // DO > optimal'in %90'i?
      if (wq.dissolvedOxygen !== undefined) {
        paramCount++;
        if (wq.dissolvedOxygen > t.dissolvedOxygen.optimal * 0.9) goodParamCount++;
        else allOptimal = false;
      }

      // pH optimal aralıkta?
      if (wq.ph !== undefined) {
        paramCount++;
        const phMargin = (t.ph.max - t.ph.min) * 0.2; // %20 marjin
        if (wq.ph >= t.ph.min + phMargin && wq.ph <= t.ph.max - phMargin) goodParamCount++;
        else allOptimal = false;
      }
    }

    // En az 3 parametre olculmeli ve hepsi iyi olmali
    if (paramCount < 3 || !allOptimal) continue;

    opportunities.push({
      type: 'water_exchange_optimization',
      entity: { type: 'tank', id: tank.id, name: tank.name },
      current: 'Tum WQ parametreleri optimal aralıkta ve guvenli marjin mevcut',
      suggested: 'Su degisim oranini %15-20 azaltmayi deneyin — WQ durumunu yakindan izleyerek',
      rationale:
        'Tum su kalitesi parametreleri uyari esiklerinin cok altinda. ' +
        'Mevcut su degisimi gereksiz yuksek olabilir. Kademeli azaltma ile ' +
        'enerji ve su tasarrufu saglanabilir.',
      expectedImprovement: 'Enerji maliyetinde tahmini %15-20 tasarruf, su tuketiminde azalma',
      confidence: calculateOpportunityConfidence(paramCount, [allOptimal]),
      basedOn: `${paramCount} WQ olcumu, ${goodParamCount} parametre optimal aralıkta`,
    });
  }

  return opportunities;
}

// ── Yardimci Fonksiyonlar ─────────────────────────────────────────────────────

/**
 * Firsat guven skoru hesaplar.
 *
 * NASIL CALISIR:
 *   1. Veri noktasi sayisina gore temel guven: min(0.8, n/20)
 *   2. Karsilanan kosul oranina gore bonus: kosul_karsilanan / kosul_toplam * 0.2
 *   3. Toplam = temel + bonus (max 0.95)
 *
 * @param dataPoints - Hesaplamada kullanilan veri noktasi sayisi
 * @param conditionsMet - Karsilanan kosullar (boolean dizisi)
 * @returns Guven skoru (0-1)
 */
function calculateOpportunityConfidence(
  dataPoints: number,
  conditionsMet: boolean[],
): number {
  // Temel guven: veri noktasina dayali
  const baseConfidence = Math.min(0.8, dataPoints / 20);

  // Kosul bonusu
  const metCount = conditionsMet.filter(Boolean).length;
  const conditionBonus = conditionsMet.length > 0
    ? (metCount / conditionsMet.length) * 0.2
    : 0;

  return Math.round(Math.min(0.95, baseConfidence + conditionBonus) * 1000) / 1000;
}

/**
 * SGR bazli hasat zamanlama icin ozel guven skoru.
 *
 * SGR tahmini uzun vadede sapabilir:
 *   - Yuksek SGR → kisa vade, yuksek guven
 *   - Dusuk SGR → uzun vade, dusuk guven (daha fazla belirsizlik)
 *   - Cok veri noktasi → yuksek guven
 *   - Az veri noktasi → dusuk guven
 *
 * @param sgr - Spesifik buyume orani (%/gun)
 * @param dataPoints - Buyume olcumu sayisi
 * @returns Guven skoru (0-1)
 */
function calculateSGRConfidence(sgr: number, dataPoints: number): number {
  // Veri noktasi bileşeni
  const dataBased = Math.min(0.6, dataPoints / 15);

  // SGR kararliligi bileşeni (yuksek SGR → kisa tahmın surel → daha kesin)
  const sgrBased = sgr > 2 ? 0.3 : sgr > 1 ? 0.25 : sgr > 0.5 ? 0.2 : 0.1;

  return Math.round(Math.min(0.95, dataBased + sgrBased) * 1000) / 1000;
}
