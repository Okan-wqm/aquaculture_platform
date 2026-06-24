import {
  // Ammonia
  fractionNH3, calcNH3, calcNH4, criticalPHforNH3, calcSafeTAN, uiaStatus,
  // H2S
  fractionH2S, calcH2S, calcTotalSulfide, criticalPHforH2S, h2sStatus,
  // CO2
  co2Level, criticalPHforCO2,
  // Carbonate
  calcDicOfAlk, calcAlkOfDicPh, calcPhForAlkDic,
  // Reagents & dosing
  REAGENTS, alkMgToMeq, alkMeqToMg, calculateDosingRecipes, calcForwardDosing,
  // Deffeyes safe zone
  generateSafeZone, calcOperatingPoint,
} from '@platform/aquaculture-engines';
import { describe, it, expect } from 'vitest';

// ============================================================================
// SENARYO: Tatlı su RAS sistemi — Acil müdahale gerekiyor mu?
// ============================================================================
//
// ÖLÇÜMLER:
//   pH       = 8.5
//   TAN      = 4.0 mg/L
//   H₂S      = 0.5 µg/L (ölçülen)
//   Sıcaklık = 20°C
//   Tuzluluk = 0 ppt (tatlı su)
//   Hacim    = 1 m³
//
// TOKSİK LİMİTLER:
//   NH₃  < 0.125 mg/L
//   H₂S  < 5 µg/L
//   CO₂  < 20 mg/L
//
// SORU:
//   1. Mevcut toksin seviyeleri nedir?
//   2. Güvenli bölgede miyiz?
//   3. Ne yapmalıyız? Kaç gram ne eklemeliyiz?
// ============================================================================

const SCENARIO = {
  pH: 8.5,
  tan: 4.0,        // mg/L
  h2s: 0.5,        // µg/L (ölçülen)
  tempC: 20,
  salinity: 0,
  volumeM3: 1,

  // Toksik limitler
  nh3Limit: 0.0125, // mg/L
  h2sLimit: 5,     // µg/L
  co2Limit: 20,    // mg/L
};

describe('Su Tedavi Senaryosu — pH 8.5, TAN 4, H₂S 0.5 µg/L', () => {

  // ========================================================================
  // 1. MEVCUT TOKSİN SEVİYELERİ
  // ========================================================================

  describe('1. Mevcut Toksin Seviyeleri', () => {

    it('NH₃ hesaplaması — TAN 4 mg/L, pH 8.5, 20°C, S=0', () => {
      const fraction = fractionNH3(SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);
      const nh3 = calcNH3(SCENARIO.tan, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);
      const nh4 = calcNH4(SCENARIO.tan, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);

      console.log('\n══════════════════════════════════════════');
      console.log('  AMONYAK ANALİZİ');
      console.log('══════════════════════════════════════════');
      console.log(`  NH₃ fraksiyonu   : ${(fraction * 100).toFixed(4)}%`);
      console.log(`  NH₃ (toksik)     : ${nh3.toFixed(4)} mg/L`);
      console.log(`  NH₄⁺ (güvenli)   : ${nh4.toFixed(4)} mg/L`);
      console.log(`  Toksik limit     : ${SCENARIO.nh3Limit} mg/L`);
      console.log(`  DURUM            : ${nh3 > SCENARIO.nh3Limit ? '🔴 TEHLİKELİ — NH₃ limiti aşıldı!' : '🟢 Güvenli'}`);
      console.log(`  Limit aşım oranı: ${(nh3 / SCENARIO.nh3Limit).toFixed(2)}x`);

      // pH 8.5'te TAN=4 ile NH3 oldukça yüksek olmalı
      expect(nh3).toBeGreaterThan(0);
      expect(nh4).toBeGreaterThan(0);
      expect(nh3 + nh4).toBeCloseTo(SCENARIO.tan, 4);
    });

    it('H₂S hesaplaması — 0.5 µg/L ölçülen, pH 8.5', () => {
      const totalSulfide = calcTotalSulfide(SCENARIO.h2s, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);
      const h2sAtCurrentPH = calcH2S(totalSulfide, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);

      console.log('\n══════════════════════════════════════════');
      console.log('  H₂S ANALİZİ');
      console.log('══════════════════════════════════════════');
      console.log(`  Ölçülen H₂S      : ${SCENARIO.h2s} µg/L`);
      console.log(`  Toplam sülfid     : ${totalSulfide.toFixed(4)} µg/L`);
      console.log(`  Hesaplanan H₂S    : ${h2sAtCurrentPH.toFixed(4)} µg/L`);
      console.log(`  Toksik limit      : ${SCENARIO.h2sLimit} µg/L`);
      console.log(`  DURUM             : ${h2sAtCurrentPH > SCENARIO.h2sLimit ? '🔴 TEHLİKELİ' : '🟢 Güvenli'}`);

      // Ölçülen değerle hesaplanan tutarlı olmalı
      expect(h2sAtCurrentPH).toBeCloseTo(SCENARIO.h2s, 2);
      // 0.5 µg/L < 5 µg/L limit → güvenli
      expect(h2sAtCurrentPH).toBeLessThan(SCENARIO.h2sLimit);
    });

    it('CO₂ hesaplaması — alkalinite gerekiyor', () => {
      // CO₂ hesabı için alkalinite gerekli. Tipik tatlı su alkalinite: 100 mg/L CaCO₃
      // Farklı alkalinite değerleri için CO₂ hesaplayalım
      const alkValues = [50, 80, 100, 120, 150, 200];

      console.log('\n══════════════════════════════════════════');
      console.log('  CO₂ ANALİZİ (pH 8.5, 20°C, S=0)');
      console.log('══════════════════════════════════════════');
      console.log('  Alk (mg/L CaCO₃) | Alk (meq/L) | CO₂ (mg/L) | Durum');
      console.log('  ─────────────────|─────────────|────────────|──────');

      for (const alkMg of alkValues) {
        const alkMeq = alkMgToMeq(alkMg);
        const co2 = co2Level(alkMeq, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);
        const status = co2 > SCENARIO.co2Limit ? '🔴' : '🟢';
        console.log(`  ${String(alkMg).padStart(17)} | ${alkMeq.toFixed(4).padStart(11)} | ${co2.toFixed(4).padStart(10)} | ${status}`);
      }

      // pH 8.5'te CO₂ çok düşük olmalı (yüksek pH = düşük CO₂)
      const co2at100 = co2Level(alkMgToMeq(100), SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);
      expect(co2at100).toBeLessThan(SCENARIO.co2Limit);
    });
  });

  // ========================================================================
  // 2. KRİTİK pH SINIRLARI
  // ========================================================================

  describe('2. Kritik pH Sınırları', () => {

    it('NH₃ kritik pH — TAN=4, limit=0.125', () => {
      const critPH = criticalPHforNH3(SCENARIO.tan, SCENARIO.nh3Limit, SCENARIO.tempC, SCENARIO.salinity);
      const status = uiaStatus(SCENARIO.pH, critPH);

      console.log('\n══════════════════════════════════════════');
      console.log('  KRİTİK pH SINIRLARI');
      console.log('══════════════════════════════════════════');
      console.log(`  NH₃ kritik pH    : ${critPH.toFixed(4)}`);
      console.log(`  Mevcut pH        : ${SCENARIO.pH}`);
      console.log(`  Fark             : ${(critPH - SCENARIO.pH).toFixed(4)}`);
      console.log(`  NH₃ Durumu       : ${status.toUpperCase()}`);

      expect(critPH).not.toBeNaN();
    });

    it('H₂S kritik pH — 0.5 µg/L ölçülen, limit=5 µg/L', () => {
      const critPH = criticalPHforH2S(SCENARIO.h2s, SCENARIO.pH, SCENARIO.h2sLimit, SCENARIO.tempC, SCENARIO.salinity);
      const status = h2sStatus(SCENARIO.pH, critPH);

      console.log(`  H₂S kritik pH    : ${isNaN(critPH) ? 'N/A (limit aşılamaz)' : critPH.toFixed(4)}`);
      console.log(`  H₂S Durumu       : ${status.toUpperCase()}`);

      // 0.5 µg/L << 5 µg/L → limit çok uzak, critPH çok düşük olmalı
    });

    it('CO₂ kritik pH — farklı alkalinitelerde', () => {
      const alkValues = [50, 80, 100, 120, 150, 200];

      console.log('  CO₂ kritik pH değerleri:');
      for (const alkMg of alkValues) {
        const alkMeq = alkMgToMeq(alkMg);
        const critPH = criticalPHforCO2(alkMeq, SCENARIO.co2Limit, SCENARIO.tempC, SCENARIO.salinity);
        console.log(`    Alk ${alkMg} mg/L → kritik pH: ${critPH.toFixed(4)} (pH bunun altına düşerse CO₂ > ${SCENARIO.co2Limit} mg/L)`);
      }
    });

    it('Güvenli TAN — mevcut pH\'da maksimum kaç mg/L TAN tutulabilir', () => {
      const safeTAN = calcSafeTAN(SCENARIO.pH, SCENARIO.nh3Limit, SCENARIO.tempC, SCENARIO.salinity);

      console.log('\n══════════════════════════════════════════');
      console.log('  GÜVENLİ TAN KAPASİTESİ');
      console.log('══════════════════════════════════════════');
      console.log(`  pH ${SCENARIO.pH}'de güvenli max TAN: ${safeTAN.toFixed(4)} mg/L`);
      console.log(`  Mevcut TAN               : ${SCENARIO.tan} mg/L`);
      console.log(`  TAN aşımı                : ${SCENARIO.tan > safeTAN ? `🔴 ${(SCENARIO.tan - safeTAN).toFixed(4)} mg/L fazla` : '🟢 Limit içinde'}`);

      // pH 8.5'te NH3 fraksiyonu yüksek → safeTAN düşük olmalı
    });
  });

  // ========================================================================
  // 3. AKSİYON PLANI — pH DÜŞÜRME
  // ========================================================================

  describe('3. Aksiyon Planı', () => {

    it('pH düşürerek NH₃ azaltma — hedef pH hesaplama', () => {
      const critPH = criticalPHforNH3(SCENARIO.tan, SCENARIO.nh3Limit, SCENARIO.tempC, SCENARIO.salinity);

      // Güvenli pH = critPH - 0.2 (güvenlik marjı)
      const targetPH = critPH - 0.2;

      // Hedef pH'da NH3 hesapla
      const nh3AtTarget = calcNH3(SCENARIO.tan, targetPH, SCENARIO.tempC, SCENARIO.salinity);
      const nh3AtCurrent = calcNH3(SCENARIO.tan, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);

      console.log('\n══════════════════════════════════════════');
      console.log('  AKSİYON: pH DÜŞÜRME');
      console.log('══════════════════════════════════════════');
      console.log(`  Mevcut pH        : ${SCENARIO.pH}`);
      console.log(`  Kritik pH (NH₃)  : ${critPH.toFixed(4)}`);
      console.log(`  Hedef pH         : ${targetPH.toFixed(4)} (0.2 güvenlik marjı)`);
      console.log(`  NH₃ mevcut       : ${nh3AtCurrent.toFixed(4)} mg/L`);
      console.log(`  NH₃ hedefte      : ${nh3AtTarget.toFixed(4)} mg/L`);
      console.log(`  NH₃ azalma       : ${((1 - nh3AtTarget / nh3AtCurrent) * 100).toFixed(1)}%`);

      expect(nh3AtTarget).toBeLessThan(SCENARIO.nh3Limit);
    });

    it('pH düşürmenin H₂S etkisi — pH düşünce H₂S artar', () => {
      const totalSulfide = calcTotalSulfide(SCENARIO.h2s, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);
      const critPH_NH3 = criticalPHforNH3(SCENARIO.tan, SCENARIO.nh3Limit, SCENARIO.tempC, SCENARIO.salinity);
      const targetPH = critPH_NH3 - 0.2;

      // pH düşünce H₂S artar
      const h2sAtTarget = calcH2S(totalSulfide, targetPH, SCENARIO.tempC, SCENARIO.salinity);

      console.log('\n══════════════════════════════════════════');
      console.log('  H₂S ETKİ ANALİZİ (pH düşürme sonrası)');
      console.log('══════════════════════════════════════════');
      console.log(`  Toplam sülfid     : ${totalSulfide.toFixed(4)} µg/L`);
      console.log(`  H₂S mevcut pH'da : ${SCENARIO.h2s} µg/L`);
      console.log(`  H₂S hedef pH'da  : ${h2sAtTarget.toFixed(4)} µg/L`);
      console.log(`  H₂S limit        : ${SCENARIO.h2sLimit} µg/L`);
      console.log(`  H₂S güvenli mi?  : ${h2sAtTarget > SCENARIO.h2sLimit ? '🔴 pH düşürmek H₂S\'yi tehlikeli yapıyor!' : '🟢 Hala güvenli'}`);
    });
  });

  // ========================================================================
  // 4. KİMYASAL DOZLAMA HESABI
  // ========================================================================

  describe('4. Kimyasal Dozlama Hesabı', () => {

    it('Deffeyes diyagramı üzerinde mevcut ve hedef nokta', () => {
      // Alkalinite varsayımı: 100 mg/L CaCO₃ (tipik tatlı su)
      const alkMg = 100;
      const alkMeq = alkMgToMeq(alkMg);

      const currentPoint = calcOperatingPoint(SCENARIO.pH, alkMeq, SCENARIO.tempC, SCENARIO.salinity);

      const critPH = criticalPHforNH3(SCENARIO.tan, SCENARIO.nh3Limit, SCENARIO.tempC, SCENARIO.salinity);
      const targetPH = critPH - 0.2;
      const targetAlk = alkMeq; // Alkaliniteyi sabit tut

      const targetDIC = calcDicOfAlk(targetAlk, targetPH, SCENARIO.tempC, SCENARIO.salinity);

      console.log('\n══════════════════════════════════════════');
      console.log('  DEFFEYES DİYAGRAMI');
      console.log('══════════════════════════════════════════');
      console.log(`  Alkalinite       : ${alkMg} mg/L CaCO₃ = ${alkMeq.toFixed(4)} meq/L`);
      console.log(`  Mevcut nokta     : DIC=${currentPoint.DIC.toFixed(4)} mmol/L, ALK=${currentPoint.ALK.toFixed(4)} meq/L`);
      console.log(`  Hedef pH         : ${targetPH.toFixed(4)}`);
      console.log(`  Hedef nokta      : DIC=${targetDIC.toFixed(4)} mmol/L, ALK=${targetAlk.toFixed(4)} meq/L`);
    });

    it('Dozlama reçeteleri — 1 m³ hacim, alkalinite 100 mg/L', () => {
      const alkMg = 100;
      const alkMeq = alkMgToMeq(alkMg);

      const currentDIC = calcDicOfAlk(alkMeq, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);
      const critPH = criticalPHforNH3(SCENARIO.tan, SCENARIO.nh3Limit, SCENARIO.tempC, SCENARIO.salinity);
      const targetPH = critPH - 0.2;
      const targetDIC = calcDicOfAlk(alkMeq, targetPH, SCENARIO.tempC, SCENARIO.salinity);

      // pH düşürmek için: CO₂ ekle veya HCl kullan
      const allReagents = REAGENTS.map(r => r.name);
      const recipes = calculateDosingRecipes(
        currentDIC, alkMeq,
        targetDIC, alkMeq,
        SCENARIO.volumeM3,
        allReagents
      );

      console.log('\n══════════════════════════════════════════');
      console.log('  DOZLAMA REÇETELERİ');
      console.log(`  pH ${SCENARIO.pH} → ${targetPH.toFixed(2)}`);
      console.log(`  DIC ${currentDIC.toFixed(4)} → ${targetDIC.toFixed(4)} mmol/L`);
      console.log(`  ALK sabit: ${alkMeq.toFixed(4)} meq/L`);
      console.log(`  Hacim: ${SCENARIO.volumeM3} m³`);
      console.log('══════════════════════════════════════════');

      if (recipes.length === 0) {
        console.log('  ❌ Uygun reçete bulunamadı');
      }

      for (const [i, recipe] of recipes.entries()) {
        console.log(`\n  📋 Reçete ${i + 1}: ${recipe.description}`);
        for (const step of recipe.steps) {
          console.log(`     ${step.formula}: ${step.amountGrams.toFixed(2)} g (${step.amountKg.toFixed(4)} kg)`);
          console.log(`       ΔDIC: ${step.deltaDIC.toFixed(4)} mmol/L, ΔALK: ${step.deltaAlk.toFixed(4)} meq/L`);
        }
      }

      // En az bir reçete bulunmalı
      expect(recipes.length).toBeGreaterThan(0);
    });

    it('Forward dozlama simülasyonu — CO₂ ekleme', () => {
      const alkMg = 100;
      const alkMeq = alkMgToMeq(alkMg);
      const currentDIC = calcDicOfAlk(alkMeq, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);

      // CO₂ ile pH düşürme: farklı miktarlar dene
      const co2Doses = [5, 10, 15, 20, 25, 30, 40, 50];

      console.log('\n══════════════════════════════════════════');
      console.log('  CO₂ DOZLAMA SİMÜLASYONU (1 m³)');
      console.log('══════════════════════════════════════════');
      console.log('  CO₂ (g) | pH      | CO₂ (mg/L) | NH₃ (mg/L) | Durum');
      console.log('  ────────|─────────|────────────|────────────|──────');

      for (const dose of co2Doses) {
        const result = calcForwardDosing(
          { dic: currentDIC, alk: alkMeq, tempC: SCENARIO.tempC, salinity: SCENARIO.salinity },
          SCENARIO.volumeM3,
          [{ reagentKey: 'Add CO₂', amountGrams: dose }]
        );

        const final = result[result.length - 1];
        if (!final) throw new Error('calcForwardDosing returned no dosing steps');
        const nh3 = calcNH3(SCENARIO.tan, final.ph, SCENARIO.tempC, SCENARIO.salinity);
        const nh3Status = nh3 > SCENARIO.nh3Limit ? '🔴' : '🟢';
        const co2Status = final.co2 > SCENARIO.co2Limit ? '⚠️CO₂↑' : '';

        console.log(`  ${String(dose).padStart(7)} | ${final.ph.toFixed(4)} | ${final.co2.toFixed(4).padStart(10)} | ${nh3.toFixed(4).padStart(10)} | ${nh3Status} ${co2Status}`);
      }
    });

    it('Forward dozlama simülasyonu — HCl (Muriatic Acid)', () => {
      const alkMg = 100;
      const alkMeq = alkMgToMeq(alkMg);
      const currentDIC = calcDicOfAlk(alkMeq, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);

      const hclDoses = [1, 2, 3, 5, 7, 10, 15, 20];

      console.log('\n══════════════════════════════════════════');
      console.log('  HCl DOZLAMA SİMÜLASYONU (1 m³)');
      console.log('══════════════════════════════════════════');
      console.log('  HCl (g) | pH      | CO₂ (mg/L) | NH₃ (mg/L) | ALK sonuç | Durum');
      console.log('  ────────|─────────|────────────|────────────|───────────|──────');

      for (const dose of hclDoses) {
        const result = calcForwardDosing(
          { dic: currentDIC, alk: alkMeq, tempC: SCENARIO.tempC, salinity: SCENARIO.salinity },
          SCENARIO.volumeM3,
          [{ reagentKey: 'Muriatic Acid', amountGrams: dose }]
        );

        const final = result[result.length - 1];
        if (!final) throw new Error('calcForwardDosing returned no dosing steps');
        const nh3 = calcNH3(SCENARIO.tan, final.ph, SCENARIO.tempC, SCENARIO.salinity);
        const alkFinalMg = alkMeqToMg(final.alk);
        const nh3Status = nh3 > SCENARIO.nh3Limit ? '🔴' : '🟢';
        const co2Status = final.co2 > SCENARIO.co2Limit ? '⚠️CO₂↑' : '';

        console.log(`  ${String(dose).padStart(7)} | ${final.ph.toFixed(4)} | ${final.co2.toFixed(4).padStart(10)} | ${nh3.toFixed(4).padStart(10)} | ${alkFinalMg.toFixed(1).padStart(9)} | ${nh3Status} ${co2Status}`);
      }
    });
  });

  // ========================================================================
  // 5. ÖZET VE ÖNERİ
  // ========================================================================

  describe('5. Sonuç Özeti', () => {

    it('Kapsamlı risk değerlendirmesi ve öneriler', () => {
      const alkMg = 100; // varsayılan alkalinite
      const alkMeq = alkMgToMeq(alkMg);
      const currentDIC = calcDicOfAlk(alkMeq, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);

      // --- Mevcut durum ---
      const nh3 = calcNH3(SCENARIO.tan, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);
      const totalSulfide = calcTotalSulfide(SCENARIO.h2s, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);
      const co2 = co2Level(alkMeq, SCENARIO.pH, SCENARIO.tempC, SCENARIO.salinity);
      const safeTAN = calcSafeTAN(SCENARIO.pH, SCENARIO.nh3Limit, SCENARIO.tempC, SCENARIO.salinity);

      // --- Kritik pH'lar ---
      const critPH_NH3 = criticalPHforNH3(SCENARIO.tan, SCENARIO.nh3Limit, SCENARIO.tempC, SCENARIO.salinity);
      const critPH_H2S = criticalPHforH2S(SCENARIO.h2s, SCENARIO.pH, SCENARIO.h2sLimit, SCENARIO.tempC, SCENARIO.salinity);
      const critPH_CO2 = criticalPHforCO2(alkMeq, SCENARIO.co2Limit, SCENARIO.tempC, SCENARIO.salinity);

      // --- Optimal dozlama bul (CO₂ ile) ---
      // Hedef: NH₃ < 0.125 ve CO₂ < 20
      let optimalCO2Dose = 0;
      let optimalPH = SCENARIO.pH;
      let optimalNH3 = nh3;
      let optimalCO2Level = co2;

      for (let dose = 1; dose <= 200; dose += 0.5) {
        const result = calcForwardDosing(
          { dic: currentDIC, alk: alkMeq, tempC: SCENARIO.tempC, salinity: SCENARIO.salinity },
          SCENARIO.volumeM3,
          [{ reagentKey: 'Add CO₂', amountGrams: dose }]
        );
        const final = result[result.length - 1];
        if (!final) throw new Error('calcForwardDosing returned no dosing steps');
        const testNH3 = calcNH3(SCENARIO.tan, final.ph, SCENARIO.tempC, SCENARIO.salinity);

        if (testNH3 <= SCENARIO.nh3Limit && final.co2 <= SCENARIO.co2Limit) {
          optimalCO2Dose = dose;
          optimalPH = final.ph;
          optimalNH3 = testNH3;
          optimalCO2Level = final.co2;
          break;
        }
      }

      // --- Optimal HCl dozlama bul ---
      let optimalHClDose = 0;
      let optimalHClPH = SCENARIO.pH;
      let optimalHClNH3 = nh3;
      let optimalHClCO2 = co2;
      let optimalHClAlk = alkMeq;

      for (let dose = 0.5; dose <= 100; dose += 0.5) {
        const result = calcForwardDosing(
          { dic: currentDIC, alk: alkMeq, tempC: SCENARIO.tempC, salinity: SCENARIO.salinity },
          SCENARIO.volumeM3,
          [{ reagentKey: 'Muriatic Acid', amountGrams: dose }]
        );
        const final = result[result.length - 1];
        if (!final) throw new Error('calcForwardDosing returned no dosing steps');
        const testNH3 = calcNH3(SCENARIO.tan, final.ph, SCENARIO.tempC, SCENARIO.salinity);

        if (testNH3 <= SCENARIO.nh3Limit && final.co2 <= SCENARIO.co2Limit) {
          optimalHClDose = dose;
          optimalHClPH = final.ph;
          optimalHClNH3 = testNH3;
          optimalHClCO2 = final.co2;
          optimalHClAlk = final.alk;
          break;
        }
      }

      // --- H₂S kontrol: hedef pH'da H₂S güvenli mi? ---
      const h2sAtOptimalCO2 = calcH2S(totalSulfide, optimalPH, SCENARIO.tempC, SCENARIO.salinity);
      const h2sAtOptimalHCl = calcH2S(totalSulfide, optimalHClPH, SCENARIO.tempC, SCENARIO.salinity);

      console.log('\n');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║             SU KİMYASI KAPSAMLI RAPOR                       ║');
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log('║  ÖLÇÜMLER                                                   ║');
      console.log(`║  pH: ${SCENARIO.pH}  TAN: ${SCENARIO.tan} mg/L  H₂S: ${SCENARIO.h2s} µg/L              ║`);
      console.log(`║  T: ${SCENARIO.tempC}°C  S: ${SCENARIO.salinity} ppt  V: ${SCENARIO.volumeM3} m³  Alk: ${alkMg} mg/L CaCO₃    ║`);
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log('║  MEVCUT TOKSİN SEVİYELERİ                                  ║');
      console.log(`║  NH₃ : ${nh3.toFixed(4)} mg/L  (limit: ${SCENARIO.nh3Limit})  ${nh3 > SCENARIO.nh3Limit ? '🔴 AŞILDI' : '🟢 OK'}        ║`);
      console.log(`║  H₂S : ${SCENARIO.h2s} µg/L     (limit: ${SCENARIO.h2sLimit})    ${SCENARIO.h2s > SCENARIO.h2sLimit ? '🔴 AŞILDI' : '🟢 OK'}        ║`);
      console.log(`║  CO₂ : ${co2.toFixed(4)} mg/L (limit: ${SCENARIO.co2Limit})  ${co2 > SCENARIO.co2Limit ? '🔴 AŞILDI' : '🟢 OK'}        ║`);
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log('║  KRİTİK pH SINIRLARI                                       ║');
      console.log(`║  NH₃ üst sınır   : pH ${critPH_NH3.toFixed(4)} (üstünde NH₃ toksik)      ║`);
      console.log(`║  H₂S alt sınır   : pH ${isNaN(critPH_H2S) ? 'N/A      ' : critPH_H2S.toFixed(4)} (altında H₂S toksik)      ║`);
      console.log(`║  CO₂ alt sınır   : pH ${critPH_CO2.toFixed(4)} (altında CO₂ toksik)      ║`);
      console.log(`║  Güvenli pH aralığı: ${Math.max(critPH_CO2, isNaN(critPH_H2S) ? 0 : critPH_H2S).toFixed(2)} — ${critPH_NH3.toFixed(2)}          ║`);
      console.log(`║  Güvenli max TAN   : ${safeTAN.toFixed(4)} mg/L (pH ${SCENARIO.pH}'de)          ║`);
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log('║  ÖNERİLEN AKSİYONLAR                                       ║');
      console.log('║                                                             ║');

      if (optimalCO2Dose > 0) {
        console.log(`║  🧪 Seçenek 1: CO₂ Ekleme                                  ║`);
        console.log(`║     Miktar  : ${optimalCO2Dose.toFixed(1)} gram CO₂ gazı                          ║`);
        console.log(`║     pH      : ${SCENARIO.pH} → ${optimalPH.toFixed(4)}                             ║`);
        console.log(`║     NH₃     : ${nh3.toFixed(4)} → ${optimalNH3.toFixed(4)} mg/L                    ║`);
        console.log(`║     CO₂     : ${co2.toFixed(4)} → ${optimalCO2Level.toFixed(4)} mg/L                ║`);
        console.log(`║     H₂S     : ${SCENARIO.h2s} → ${h2sAtOptimalCO2.toFixed(4)} µg/L ${h2sAtOptimalCO2 > SCENARIO.h2sLimit ? '⚠️' : '✅'}         ║`);
      } else {
        console.log(`║  ❌ CO₂ ile güvenli bölgeye ulaşılamıyor                    ║`);
      }

      console.log('║                                                             ║');

      if (optimalHClDose > 0) {
        console.log(`║  🧪 Seçenek 2: HCl (Muriatic Acid) Ekleme                  ║`);
        console.log(`║     Miktar  : ${optimalHClDose.toFixed(1)} gram HCl                               ║`);
        console.log(`║     pH      : ${SCENARIO.pH} → ${optimalHClPH.toFixed(4)}                          ║`);
        console.log(`║     NH₃     : ${nh3.toFixed(4)} → ${optimalHClNH3.toFixed(4)} mg/L                 ║`);
        console.log(`║     CO₂     : ${co2.toFixed(4)} → ${optimalHClCO2.toFixed(4)} mg/L                  ║`);
        console.log(`║     H₂S     : ${SCENARIO.h2s} → ${h2sAtOptimalHCl.toFixed(4)} µg/L ${h2sAtOptimalHCl > SCENARIO.h2sLimit ? '⚠️' : '✅'}         ║`);
        console.log(`║     ALK     : ${alkMg} → ${alkMeqToMg(optimalHClAlk).toFixed(1)} mg/L CaCO₃          ║`);
      } else {
        console.log(`║  ❌ HCl ile güvenli bölgeye ulaşılamıyor                    ║`);
      }

      console.log('║                                                             ║');
      console.log('║  ⚠️ DİKKAT: pH düşürme H₂S riskini artırır!                ║');
      console.log('║  Su değişimi ile TAN dilüsyonu da düşünülmeli.              ║');
      console.log('╚══════════════════════════════════════════════════════════════╝');
    });
  });
});
