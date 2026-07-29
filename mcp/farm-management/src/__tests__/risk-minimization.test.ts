import {
  fractionNH3,
  calcNH3,
  calcNH4,
  fractionH2S,
  calcH2S,
  calcTotalSulfide,
  co2Level,
  calcDicOfAlk,
  calcForwardDosing,
  alkMgToMeq,
  alkMeqToMg,
  REAGENTS,
} from '@platform/aquaculture-engines';
import { describe, it } from 'vitest';

// ============================================================================
// SENARYO
// ============================================================================
const S = {
  pH: 8.5,
  tan: 4.0,
  h2s: 0.5,
  tempC: 20,
  sal: 0,
  vol: 1,
  alkMg: 100,
  nh3Lim: 0.0125,
  h2sLim: 5,
  co2Lim: 20,
};
const alkMeq = alkMgToMeq(S.alkMg);
const totalSulfide = calcTotalSulfide(S.h2s, S.pH, S.tempC, S.sal);
const currentDIC = calcDicOfAlk(alkMeq, S.pH, S.tempC, S.sal);

// ============================================================================
// Risk skoru: her toksin/limit oranı → max(ratio) = en kötü risk
// ============================================================================
function riskAt(pH: number, alk: number) {
  const nh3 = calcNH3(S.tan, pH, S.tempC, S.sal);
  const h2s = calcH2S(totalSulfide, pH, S.tempC, S.sal);
  const co2 = co2Level(alk, pH, S.tempC, S.sal);

  const rNH3 = nh3 / S.nh3Lim;
  const rH2S = h2s / S.h2sLim;
  const rCO2 = co2 / S.co2Lim;

  return { pH, nh3, h2s, co2, rNH3, rH2S, rCO2, maxR: Math.max(rNH3, rH2S, rCO2) };
}

describe('Risk Minimizasyonu — pH taraması', () => {
  it('pH taraması: en düşük max-risk noktasını bul', () => {
    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log("  pH TARAMASI — Her pH'da NH₃, H₂S, CO₂ risk oranları");
    console.log('  Alk sabit: 100 mg/L CaCO₃, TAN=4, toplam sülfid=%.1f µg/L', totalSulfide);
    console.log('══════════════════════════════════════════════════════════════════');
    console.log('  pH    | NH₃ mg/L  | NH₃/lim | H₂S µg/L | H₂S/lim | CO₂ mg/L | CO₂/lim | maxR');
    console.log('  ──────|───────────|─────────|──────────|─────────|──────────|─────────|──────');

    let best = { pH: 0, maxR: Infinity, nh3: 0, h2s: 0, co2: 0, rNH3: 0, rH2S: 0, rCO2: 0 };

    for (let pH = 5.5; pH <= 9.5; pH += 0.05) {
      const r = riskAt(pH, alkMeq);
      const mark = pH >= 6.8 && pH <= 7.5 ? ' ◄' : '';

      if (pH % 0.25 < 0.03 || (pH >= 6.5 && pH <= 7.8)) {
        console.log(
          `  ${pH.toFixed(2)}  | ${r.nh3.toFixed(6).padStart(9)} | ${r.rNH3.toFixed(2).padStart(7)} | ${r.h2s.toFixed(4).padStart(8)} | ${r.rH2S.toFixed(2).padStart(7)} | ${r.co2.toFixed(4).padStart(8)} | ${r.rCO2.toFixed(2).padStart(7)} | ${r.maxR.toFixed(2).padStart(5)}${mark}`,
        );
      }

      if (r.maxR < best.maxR) best = r;
    }

    console.log('\n  ──────────────────────────────────────────────────────────────');
    console.log(`  🎯 OPTİMAL pH: ${best.pH.toFixed(2)}`);
    console.log(`     NH₃ : ${best.nh3.toFixed(6)} mg/L (${best.rNH3.toFixed(2)}x limit)`);
    console.log(`     H₂S : ${best.h2s.toFixed(4)} µg/L (${best.rH2S.toFixed(2)}x limit)`);
    console.log(`     CO₂ : ${best.co2.toFixed(4)} mg/L (${best.rCO2.toFixed(2)}x limit)`);
    console.log(`     Max risk oranı: ${best.maxR.toFixed(2)}`);
  });

  it('Hassas pH taraması — optimal bölge etrafında 0.01 adımla', () => {
    // Kaba tarama ile optimal bölgeyi bul
    let bestPH = 7.0;
    let bestMax = Infinity;
    for (let pH = 6.0; pH <= 8.5; pH += 0.01) {
      const r = riskAt(pH, alkMeq);
      if (r.maxR < bestMax) {
        bestMax = r.maxR;
        bestPH = pH;
      }
    }

    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log(
      `  HASSAS TARAMA — pH ${(bestPH - 0.3).toFixed(2)} — ${(bestPH + 0.3).toFixed(2)} arası`,
    );
    console.log('══════════════════════════════════════════════════════════════════');
    console.log(
      '  pH    | NH₃ mg/L  | ratio | H₂S µg/L | ratio | CO₂ mg/L | ratio | maxR  | baskın risk',
    );
    console.log(
      '  ──────|───────────|───────|──────────|───────|──────────|───────|───────|───────────',
    );

    for (let pH = bestPH - 0.3; pH <= bestPH + 0.3; pH += 0.02) {
      const r = riskAt(pH, alkMeq);
      const dominant =
        r.rNH3 >= r.rH2S && r.rNH3 >= r.rCO2
          ? 'NH₃'
          : r.rH2S >= r.rNH3 && r.rH2S >= r.rCO2
            ? 'H₂S'
            : 'CO₂';
      const marker = Math.abs(pH - bestPH) < 0.015 ? ' ◄◄◄ OPTİMAL' : '';

      console.log(
        `  ${pH.toFixed(2)}  | ${r.nh3.toFixed(6).padStart(9)} | ${r.rNH3.toFixed(2).padStart(5)} | ${r.h2s.toFixed(4).padStart(8)} | ${r.rH2S.toFixed(2).padStart(5)} | ${r.co2.toFixed(4).padStart(8)} | ${r.rCO2.toFixed(2).padStart(5)} | ${r.maxR.toFixed(2).padStart(5)} | ${dominant}${marker}`,
      );
    }

    // NH₃/lim = H₂S/lim kesişim noktasını bul (minimax denge)
    console.log('\n  ─── NH₃/lim = H₂S/lim KESİŞİM NOKTASI (minimax dengesi) ───');
    let eqPH = 7.0;
    let eqDiff = Infinity;
    for (let pH = 6.0; pH <= 8.5; pH += 0.001) {
      const r = riskAt(pH, alkMeq);
      const diff = Math.abs(r.rNH3 - r.rH2S);
      if (diff < eqDiff) {
        eqDiff = diff;
        eqPH = pH;
      }
    }
    const eq = riskAt(eqPH, alkMeq);
    console.log(`  Kesişim pH  : ${eqPH.toFixed(3)}`);
    console.log(`  NH₃ oranı   : ${eq.rNH3.toFixed(3)}x limit`);
    console.log(`  H₂S oranı   : ${eq.rH2S.toFixed(3)}x limit`);
    console.log(`  CO₂ oranı   : ${eq.rCO2.toFixed(3)}x limit`);
    console.log(`  NH₃         : ${eq.nh3.toFixed(6)} mg/L`);
    console.log(`  H₂S         : ${eq.h2s.toFixed(4)} µg/L`);
    console.log(`  CO₂         : ${eq.co2.toFixed(4)} mg/L`);
  });

  it('Dozlama: mevcut pH → optimal pH için kaç gram ne eklemeliyiz', () => {
    // Optimal pH'yı hassas bul
    let optPH = 7.0;
    let optMax = Infinity;
    for (let pH = 6.0; pH <= 8.5; pH += 0.001) {
      const r = riskAt(pH, alkMeq);
      if (r.maxR < optMax) {
        optMax = r.maxR;
        optPH = pH;
      }
    }

    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('  DOZLAMA HESABI — pH %.2f → %.3f', S.pH, optPH);
    console.log('══════════════════════════════════════════════════════════════════');

    // === CO₂ ile ===
    console.log('\n  --- Seçenek A: CO₂ Ekleme ---');
    let co2Dose = 0;
    for (let g = 0.1; g <= 200; g += 0.1) {
      const res = calcForwardDosing(
        { dic: currentDIC, alk: alkMeq, tempC: S.tempC, salinity: S.sal },
        S.vol,
        [{ reagentKey: 'Add CO₂', amountGrams: g }],
      );
      const f = res[res.length - 1];
      if (!f) throw new Error('calcForwardDosing returned no dosing steps');
      if (Math.abs(f.ph - optPH) < 0.01) {
        co2Dose = g;
        break;
      }
    }
    if (co2Dose > 0) {
      const res = calcForwardDosing(
        { dic: currentDIC, alk: alkMeq, tempC: S.tempC, salinity: S.sal },
        S.vol,
        [{ reagentKey: 'Add CO₂', amountGrams: co2Dose }],
      );
      const f = res[res.length - 1];
      if (!f) throw new Error('calcForwardDosing returned no dosing steps');
      const rr = riskAt(f.ph, f.alk);
      console.log(`  CO₂ miktarı  : ${co2Dose.toFixed(1)} gram`);
      console.log(`  pH sonuç     : ${f.ph.toFixed(4)}`);
      console.log(`  NH₃          : ${rr.nh3.toFixed(6)} mg/L (${rr.rNH3.toFixed(2)}x limit)`);
      console.log(`  H₂S          : ${rr.h2s.toFixed(4)} µg/L (${rr.rH2S.toFixed(2)}x limit)`);
      console.log(`  CO₂          : ${f.co2.toFixed(4)} mg/L (${rr.rCO2.toFixed(2)}x limit)`);
      console.log(`  Alkalinite   : ${alkMeqToMg(f.alk).toFixed(1)} mg/L CaCO₃ (değişmez)`);
    }

    // === HCl ile ===
    console.log('\n  --- Seçenek B: HCl Ekleme ---');
    let hclDose = 0;
    for (let g = 0.1; g <= 200; g += 0.1) {
      const res = calcForwardDosing(
        { dic: currentDIC, alk: alkMeq, tempC: S.tempC, salinity: S.sal },
        S.vol,
        [{ reagentKey: 'Muriatic Acid', amountGrams: g }],
      );
      const f = res[res.length - 1];
      if (!f) throw new Error('calcForwardDosing returned no dosing steps');
      if (Math.abs(f.ph - optPH) < 0.01) {
        hclDose = g;
        break;
      }
    }
    if (hclDose > 0) {
      const res = calcForwardDosing(
        { dic: currentDIC, alk: alkMeq, tempC: S.tempC, salinity: S.sal },
        S.vol,
        [{ reagentKey: 'Muriatic Acid', amountGrams: hclDose }],
      );
      const f = res[res.length - 1];
      if (!f) throw new Error('calcForwardDosing returned no dosing steps');
      const rr = riskAt(f.ph, f.alk);
      console.log(`  HCl miktarı  : ${hclDose.toFixed(1)} gram`);
      console.log(`  pH sonuç     : ${f.ph.toFixed(4)}`);
      console.log(`  NH₃          : ${rr.nh3.toFixed(6)} mg/L (${rr.rNH3.toFixed(2)}x limit)`);
      console.log(`  H₂S          : ${rr.h2s.toFixed(4)} µg/L (${rr.rH2S.toFixed(2)}x limit)`);
      console.log(`  CO₂          : ${f.co2.toFixed(4)} mg/L (${rr.rCO2.toFixed(2)}x limit)`);
      console.log(`  Alkalinite   : ${alkMeqToMg(f.alk).toFixed(1)} mg/L CaCO₃`);
    }

    // === Su değişimi + CO₂ kombine ===
    console.log('\n  --- Seçenek C: Su Değişimi + pH Ayarı (kombine) ---');
    const dilutions = [0.25, 0.5, 0.75];
    for (const frac of dilutions) {
      const newTAN = S.tan * (1 - frac);
      const newTotalSulfide = totalSulfide * (1 - frac);

      // Bu TAN için optimal pH bul
      let bpH = 7.0,
        bMax = Infinity;
      for (let pH = 6.0; pH <= 8.5; pH += 0.001) {
        const nh3 = calcNH3(newTAN, pH, S.tempC, S.sal);
        const h2s = calcH2S(newTotalSulfide, pH, S.tempC, S.sal);
        const co2 = co2Level(alkMeq, pH, S.tempC, S.sal);
        const mx = Math.max(nh3 / S.nh3Lim, h2s / S.h2sLim, co2 / S.co2Lim);
        if (mx < bMax) {
          bMax = mx;
          bpH = pH;
        }
      }

      const nh3 = calcNH3(newTAN, bpH, S.tempC, S.sal);
      const h2s = calcH2S(newTotalSulfide, bpH, S.tempC, S.sal);
      const co2 = co2Level(alkMeq, bpH, S.tempC, S.sal);
      const allSafe = nh3 <= S.nh3Lim && h2s <= S.h2sLim && co2 <= S.co2Lim;

      // Dozlama
      let dose = 0;
      if (bpH < S.pH) {
        for (let g = 0.1; g <= 200; g += 0.1) {
          const res = calcForwardDosing(
            { dic: currentDIC, alk: alkMeq, tempC: S.tempC, salinity: S.sal },
            S.vol,
            [{ reagentKey: 'Add CO₂', amountGrams: g }],
          );
          const lastStep = res[res.length - 1];
          if (lastStep && Math.abs(lastStep.ph - bpH) < 0.01) {
            dose = g;
            break;
          }
        }
      }

      console.log(
        `\n  %${(frac * 100).toFixed(0)} su değişimi (${(frac * S.vol * 1000).toFixed(0)}L):`,
      );
      console.log(`    TAN: ${S.tan} → ${newTAN.toFixed(2)} mg/L`);
      console.log(`    Optimal pH : ${bpH.toFixed(3)}`);
      console.log(
        `    NH₃        : ${nh3.toFixed(6)} mg/L (${(nh3 / S.nh3Lim).toFixed(2)}x limit)`,
      );
      console.log(
        `    H₂S        : ${h2s.toFixed(4)} µg/L (${(h2s / S.h2sLim).toFixed(2)}x limit)`,
      );
      console.log(
        `    CO₂        : ${co2.toFixed(4)} mg/L (${(co2 / S.co2Lim).toFixed(2)}x limit)`,
      );
      console.log(`    CO₂ dozlama: ${dose > 0 ? dose.toFixed(1) + ' gram' : 'gerekmiyor'}`);
      console.log(
        `    ${allSafe ? '✅ TÜM LİMİTLER ALTINDA — GÜVENLİ' : '⚠️  Hala limit aşımı var'}`,
      );
    }
  });

  it("TAN dilüsyon eğrisi — kaç mg/L TAN'da güvenli bölge açılır", () => {
    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log("  TAN DİLÜSYON EĞRİSİ — hangi TAN'da güvenli bölge var?");
    console.log('══════════════════════════════════════════════════════════════════');
    console.log(
      '  TAN mg/L | opt pH | NH₃ mg/L   | NH₃/lim | H₂S µg/L | H₂S/lim | CO₂ mg/L | maxR  | Durum',
    );
    console.log(
      '  ────────|────────|────────────|─────────|──────────|─────────|──────────|───────|──────',
    );

    for (let tan = 4.0; tan >= 0.1; tan -= 0.25) {
      // Bu TAN için tam minimax pH bul
      let bpH = 7.0,
        bMax = Infinity;
      for (let pH = 5.5; pH <= 9.0; pH += 0.001) {
        const nh3 = calcNH3(tan, pH, S.tempC, S.sal);
        const h2s = calcH2S(totalSulfide, pH, S.tempC, S.sal);
        const co2 = co2Level(alkMeq, pH, S.tempC, S.sal);
        const mx = Math.max(nh3 / S.nh3Lim, h2s / S.h2sLim, co2 / S.co2Lim);
        if (mx < bMax) {
          bMax = mx;
          bpH = pH;
        }
      }
      const nh3 = calcNH3(tan, bpH, S.tempC, S.sal);
      const h2s = calcH2S(totalSulfide, bpH, S.tempC, S.sal);
      const co2 = co2Level(alkMeq, bpH, S.tempC, S.sal);
      const safe = bMax <= 1.0;
      console.log(
        `  ${tan.toFixed(2).padStart(8)} | ${bpH.toFixed(3).padStart(6)} | ${nh3.toFixed(6).padStart(10)} | ${(nh3 / S.nh3Lim).toFixed(2).padStart(7)} | ${h2s.toFixed(4).padStart(8)} | ${(h2s / S.h2sLim).toFixed(2).padStart(7)} | ${co2.toFixed(4).padStart(8)} | ${bMax.toFixed(2).padStart(5)} | ${safe ? '✅ GÜVENLİ' : '⚠️  risk'}`,
      );
    }
  });

  it('SONUÇ RAPORU', () => {
    // Optimal pH (sabit alk)
    let optPH = 7.0,
      optMax = Infinity;
    for (let pH = 6.0; pH <= 8.5; pH += 0.001) {
      const r = riskAt(pH, alkMeq);
      if (r.maxR < optMax) {
        optMax = r.maxR;
        optPH = pH;
      }
    }
    const opt = riskAt(optPH, alkMeq);

    // Güvenli TAN eşiği
    const tanRiskGrid: Array<{
      nh3Fraction: number;
      h2sRisk: number;
      co2Risk: number;
    }> = [];
    for (let pH = 5.5; pH <= 9.0; pH += 0.002) {
      tanRiskGrid.push({
        nh3Fraction: fractionNH3(pH, S.tempC, S.sal),
        h2sRisk: calcH2S(totalSulfide, pH, S.tempC, S.sal) / S.h2sLim,
        co2Risk: co2Level(alkMeq, pH, S.tempC, S.sal) / S.co2Lim,
      });
    }

    let safeTAN = 4.0;
    for (let tan = 4.0; tan >= 0.01; tan -= 0.01) {
      let bMax = Infinity;
      for (const point of tanRiskGrid) {
        const mx = Math.max((tan * point.nh3Fraction) / S.nh3Lim, point.h2sRisk, point.co2Risk);
        if (mx < bMax) bMax = mx;
      }
      if (bMax <= 1.0) {
        safeTAN = tan;
        break;
      }
    }

    // Su değişimi oranı
    const waterChange = ((S.tan - safeTAN) / S.tan) * 100;

    // Güvenli TAN'da optimal pH
    let safePH = 7.0,
      safeMax = Infinity;
    for (let pH = 5.5; pH <= 9.0; pH += 0.001) {
      const nh3 = calcNH3(safeTAN, pH, S.tempC, S.sal);
      const h2s = calcH2S(totalSulfide, pH, S.tempC, S.sal);
      const co2 = co2Level(alkMeq, pH, S.tempC, S.sal);
      const mx = Math.max(nh3 / S.nh3Lim, h2s / S.h2sLim, co2 / S.co2Lim);
      if (mx < safeMax) {
        safeMax = mx;
        safePH = pH;
      }
    }

    // Dozlama
    let co2Dose = 0;
    for (let g = 0.1; g <= 200; g += 0.1) {
      const res = calcForwardDosing(
        { dic: currentDIC, alk: alkMeq, tempC: S.tempC, salinity: S.sal },
        S.vol,
        [{ reagentKey: 'Add CO₂', amountGrams: g }],
      );
      const lastStep = res[res.length - 1];
      if (lastStep && Math.abs(lastStep.ph - safePH) < 0.01) {
        co2Dose = g;
        break;
      }
    }

    const safeNH3 = calcNH3(safeTAN, safePH, S.tempC, S.sal);
    const safeH2S = calcH2S(totalSulfide, safePH, S.tempC, S.sal);
    const safeCO2 = co2Level(alkMeq, safePH, S.tempC, S.sal);

    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════════════╗');
    console.log('║                  RİSK MİNİMİZASYONU SONUÇ RAPORU                  ║');
    console.log('╠════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                   ║');
    console.log('║  📊 MEVCUT DURUM (pH 8.5, TAN 4 mg/L)                             ║');
    console.log(
      `║     NH₃: ${opt.nh3.toFixed(4)} mg/L → ${(calcNH3(S.tan, S.pH, S.tempC, S.sal) / S.nh3Lim).toFixed(1)}x limit aşımı                      ║`,
    );
    console.log('║                                                                   ║');
    console.log('║  📍 SADECE pH AYARI İLE (su değişimi yok):                        ║');
    console.log(
      `║     Optimal pH     : ${optPH.toFixed(3)}                                        ║`,
    );
    console.log(
      `║     NH₃            : ${opt.nh3.toFixed(6)} mg/L (${opt.rNH3.toFixed(2)}x limit)             ║`,
    );
    console.log(
      `║     H₂S            : ${opt.h2s.toFixed(4)} µg/L (${opt.rH2S.toFixed(2)}x limit)               ║`,
    );
    console.log(
      `║     CO₂            : ${opt.co2.toFixed(4)} mg/L (${opt.rCO2.toFixed(2)}x limit)               ║`,
    );
    console.log(
      `║     Risk azalma    : ${((1 - optMax / (calcNH3(S.tan, S.pH, S.tempC, S.sal) / S.nh3Lim)) * 100).toFixed(0)}%                                       ║`,
    );
    console.log('║                                                                   ║');
    console.log('║  ✅ GÜVENLİ BÖLGEYE GİRMEK İÇİN:                                 ║');
    console.log(
      `║     TAN eşiği      : ≤ ${safeTAN.toFixed(2)} mg/L                                  ║`,
    );
    console.log(
      `║     Su değişimi    : %${waterChange.toFixed(0)} (${((waterChange / 100) * S.vol * 1000).toFixed(0)} litre)                              ║`,
    );
    console.log(
      `║     Sonra pH ayarı : ${safePH.toFixed(3)} (${co2Dose.toFixed(1)} g CO₂ ekle)                      ║`,
    );
    console.log(
      `║     Sonuç NH₃      : ${safeNH3.toFixed(6)} mg/L (${(safeNH3 / S.nh3Lim).toFixed(2)}x limit)             ║`,
    );
    console.log(
      `║     Sonuç H₂S      : ${safeH2S.toFixed(4)} µg/L (${(safeH2S / S.h2sLim).toFixed(2)}x limit)               ║`,
    );
    console.log(
      `║     Sonuç CO₂      : ${safeCO2.toFixed(4)} mg/L (${(safeCO2 / S.co2Lim).toFixed(2)}x limit)               ║`,
    );
    console.log('║                                                                   ║');
    console.log('║  🔧 ACİL AKSİYON PLANI:                                           ║');
    console.log(
      `║     1. %${waterChange.toFixed(0)} su değişimi yap (${((waterChange / 100) * S.vol * 1000).toFixed(0)}L temiz su)                  ║`,
    );
    console.log(
      `║     2. ${co2Dose.toFixed(1)} gram CO₂ ekle (pH ${S.pH} → ${safePH.toFixed(2)})                      ║`,
    );
    console.log('║     3. Biyofiltre kontrol et / güçlendir                          ║');
    console.log('║     4. Yemlemeyi %50 azalt (TAN üretimini düşür)                  ║');
    console.log('║                                                                   ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝');
  });
});
