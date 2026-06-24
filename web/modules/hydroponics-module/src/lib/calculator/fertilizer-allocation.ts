import type { NutrientVector, FertilizerAmount } from './types';
import type { GeneralOptions } from '../../types/solution.types';

/**
 * Step 4: Sequential fertilizer allocation.
 *
 * Order:
 * 1. Ca → Ca(NO3)2 → Tank A  (also contributes NO3)
 * 2. K  → KNO3 (split A/B), K2SO4, KH2PO4
 * 3. Mg → MgSO4 or Mg(NO3)2
 * 4. P  → selected P fertilizer (MKP/MAP/H3PO4)
 * 5. Remaining NO3 → HNO3 (acid) or NH4NO3
 * 6. SO4 → residual from MgSO4 + K2SO4
 * 7. Micro → gram amounts
 * 8. Purity correction: actual = theoretical / (purity/100)
 * 9. Concentration factor multiplication
 */

// Molecular weights of fertilizers (g/mol)
const MW = {
  'Ca(NO3)2·4H2O': 236.15,
  'KNO3': 101.10,
  'K2SO4': 174.26,
  'KH2PO4': 136.09,
  'MgSO4·7H2O': 246.47,
  'Mg(NO3)2·6H2O': 256.41,
  'NH4NO3': 80.04,
  'NH4H2PO4': 115.03,
  '(NH4)2SO4': 132.14,
  'CaCl2·2H2O': 147.02,
  'H3PO4': 98.00,
  'HNO3': 63.01,
  'H2SO4': 98.08,
  'K2SiO3': 154.28,
  // Micro
  'Fe-DTPA': 468.20,
  'Fe-EDDHA': 932.00,
  'Fe-EDTA': 367.05,
  'MnSO4·H2O': 169.02,
  'ZnSO4·7H2O': 287.56,
  'CuSO4·5H2O': 249.69,
  'H3BO3': 61.83,
  'Na2MoO4·2H2O': 241.95,
  'Mn-EDTA': 381.24,
  'Zn-EDTA': 399.60,
  'Cu-EDTA': 393.78,
  'Mn-DTPA': 505.27,
  'Zn-DTPA': 523.63,
  'Borax': 381.37,
  '(NH4)6Mo7O24·4H2O': 1235.86,
  'KCl': 74.55,
};

// BUG-HYD-015: getPurity was dead code (always returned 100, never called). Removed.

export function allocateFertilizers(
  toAdd: NutrientVector,
  generalOptions: GeneralOptions
): { fertilizers: FertilizerAmount[]; warnings: string[] } {
  const result: FertilizerAmount[] = [];
  const warnings: string[] = [];

  // BUG-HYD-006: Build a per-tank concentration factor map so each fertiliser uses
  // the correct factor for its assigned tank, not always Tank A's factor.
  const tankFactorMap: Record<string, number> = Object.fromEntries(
    generalOptions.stockSolutions.tanks.map((t) => [t.tankLabel, t.concentrationFactor])
  );
  // Helper: resolve concentration factor for a given tank label with a fallback.
  const cfFor = (tank: string): number => tankFactorMap[tank] ?? generalOptions.stockSolutions.tanks[0]?.concentrationFactor ?? 100;

  // SEC-HYD-003: Clamp purity to a minimum of 1% to prevent divide-by-zero (Infinity).
  const safePurity = (pct: number): number => Math.max(1, pct) / 100;

  // Remaining amounts to allocate (mmol/L for macro, umol/L for micro)
  let remainK = toAdd.K;
  let remainCa = toAdd.Ca;
  let remainMg = toAdd.Mg;
  let remainNH4 = toAdd.NH4;
  let remainNO3 = toAdd.NO3;
  let remainP = toAdd.H2PO4;
  let remainSO4 = toAdd.SO4;
  let remainCl = toAdd.Cl;
  const remainSi = toAdd.Si;

  const fertOpts = generalOptions.fertilizerOptions;
  const purePercents = generalOptions.pureFertilizerPercents;

  // ── 1. Calcium: Ca(NO3)2 → Tank A ────────────────────────────────
  if (remainCa > 0) {
    // Ca(NO3)2 provides 1 Ca + 2 NO3
    const caNeeded = remainCa;
    const no3FromCa = caNeeded * 2;

    result.push({
      name: 'Calcium Nitrate',
      formula: 'Ca(NO3)2·4H2O',
      tank: 'A',
      mmolPerLiter: caNeeded,
      gramsPerLiter: (caNeeded * MW['Ca(NO3)2·4H2O'] / 1000) * cfFor('A'),
    });

    remainCa = 0;
    remainNO3 = Math.max(0, remainNO3 - no3FromCa);
  }

  // ── 2. Chloride: CaCl2 or KCl ────────────────────────────────────
  if (remainCl > 0 && fertOpts.chloride.fertilizer !== 'none') {
    if (fertOpts.chloride.fertilizer === 'cacl2') {
      const clMmol = remainCl;
      const caMmol = clMmol / 2; // CaCl2 → 1 Ca + 2 Cl
      result.push({
        name: 'Calcium Chloride',
        formula: 'CaCl2·2H2O',
        tank: 'A',
        mmolPerLiter: caMmol,
        gramsPerLiter: (caMmol * MW['CaCl2·2H2O'] / 1000) * cfFor('A') / safePurity(fertOpts.chloride.purityPercent),
      });
      remainCl = 0;
    } else if (fertOpts.chloride.fertilizer === 'kcl') {
      const clMmol = remainCl;
      result.push({
        name: 'Potassium Chloride',
        formula: 'KCl',
        tank: 'B',
        mmolPerLiter: clMmol,
        gramsPerLiter: (clMmol * MW['KCl'] / 1000) * cfFor('B') / safePurity(fertOpts.chloride.purityPercent),
      });
      remainK = Math.max(0, remainK - clMmol);
      remainCl = 0;
    }
  }

  // ── 3. Phosphorus ─────────────────────────────────────────────────
  if (remainP > 0) {
    const pFert = fertOpts.phosphorus.fertilizer;
    const pPurity = safePurity(fertOpts.phosphorus.purityPercent);

    if (pFert === 'mkp') {
      // KH2PO4: 1K + 1P
      result.push({
        name: 'Mono Potassium Phosphate',
        formula: 'KH2PO4',
        tank: 'B',
        mmolPerLiter: remainP,
        gramsPerLiter: (remainP * MW['KH2PO4'] / 1000) * cfFor('B') / pPurity,
      });
      remainK = Math.max(0, remainK - remainP);
    } else if (pFert === 'map') {
      // NH4H2PO4: 1NH4 + 1P
      result.push({
        name: 'Mono Ammonium Phosphate',
        formula: 'NH4H2PO4',
        tank: 'B',
        mmolPerLiter: remainP,
        gramsPerLiter: (remainP * MW['NH4H2PO4'] / 1000) * cfFor('B') / pPurity,
      });
      remainNH4 = Math.max(0, remainNH4 - remainP);
    } else if (pFert === 'h3po4') {
      result.push({
        name: 'Phosphoric Acid',
        formula: 'H3PO4',
        tank: 'Acid',
        mmolPerLiter: remainP,
        gramsPerLiter: (remainP * MW['H3PO4'] / 1000) * cfFor('Acid') / safePurity(purePercents.h3po4),
      });
    }
    remainP = 0;
  }

  // ── 4. Potassium: KNO3 (using remaining K and NO3) ────────────────
  if (remainK > 0 && remainNO3 > 0) {
    // KNO3: 1K + 1NO3
    const kno3 = Math.min(remainK, remainNO3);
    result.push({
      name: 'Potassium Nitrate',
      formula: 'KNO3',
      tank: 'B',
      mmolPerLiter: kno3,
      gramsPerLiter: (kno3 * MW['KNO3'] / 1000) * cfFor('B'),
    });
    remainK -= kno3;
    remainNO3 -= kno3;
  }

  // Remaining K → K2SO4
  if (remainK > 0 && remainSO4 > 0) {
    // K2SO4: 2K + 1SO4
    const k2so4SO4 = Math.min(remainK / 2, remainSO4);
    const k2so4K = k2so4SO4 * 2;
    result.push({
      name: 'Potassium Sulfate',
      formula: 'K2SO4',
      tank: 'B',
      mmolPerLiter: k2so4SO4,
      gramsPerLiter: (k2so4SO4 * MW['K2SO4'] / 1000) * cfFor('B'),
    });
    remainK -= k2so4K;
    remainSO4 -= k2so4SO4;
  }

  // ── 5. Magnesium ──────────────────────────────────────────────────
  if (remainMg > 0) {
    if (remainSO4 > 0) {
      // MgSO4: 1Mg + 1SO4
      const mgso4 = Math.min(remainMg, remainSO4);
      result.push({
        name: 'Magnesium Sulfate',
        formula: 'MgSO4·7H2O',
        tank: 'B',
        mmolPerLiter: mgso4,
        gramsPerLiter: (mgso4 * MW['MgSO4·7H2O'] / 1000) * cfFor('B'),
      });
      remainMg -= mgso4;
      remainSO4 -= mgso4;
    }
    if (remainMg > 0 && remainNO3 > 0) {
      // Mg(NO3)2: 1Mg + 2NO3
      const mgno3 = Math.min(remainMg, remainNO3 / 2);
      result.push({
        name: 'Magnesium Nitrate',
        formula: 'Mg(NO3)2·6H2O',
        tank: 'A',
        mmolPerLiter: mgno3,
        gramsPerLiter: (mgno3 * MW['Mg(NO3)2·6H2O'] / 1000) * cfFor('A'),
      });
      remainMg -= mgno3;
      remainNO3 -= mgno3 * 2;
    }
  }

  // ── 6. Ammonium ───────────────────────────────────────────────────
  if (remainNH4 > 0) {
    if (fertOpts.useAmmoniumNitrate && remainNO3 > 0) {
      // NH4NO3: 1NH4 + 1NO3
      const nh4no3 = Math.min(remainNH4, remainNO3);
      result.push({
        name: 'Ammonium Nitrate',
        formula: 'NH4NO3',
        tank: 'B',
        mmolPerLiter: nh4no3,
        gramsPerLiter: (nh4no3 * MW['NH4NO3'] / 1000) * cfFor('B'),
      });
      remainNH4 -= nh4no3;
      remainNO3 -= nh4no3;
    }
    if (remainNH4 > 0 && remainSO4 > 0) {
      // (NH4)2SO4: 2NH4 + 1SO4
      const as = Math.min(remainNH4 / 2, remainSO4);
      result.push({
        name: 'Ammonium Sulfate',
        formula: '(NH4)2SO4',
        tank: 'B',
        mmolPerLiter: as,
        gramsPerLiter: (as * MW['(NH4)2SO4'] / 1000) * cfFor('B'),
      });
      remainNH4 -= as * 2;
      remainSO4 -= as;
    }
  }

  // ── 7. Remaining NO3 via HNO3 ────────────────────────────────────
  if (remainNO3 > 0) {
    result.push({
      name: 'Nitric Acid',
      formula: 'HNO3',
      tank: 'Acid',
      mmolPerLiter: remainNO3,
      gramsPerLiter: (remainNO3 * MW['HNO3'] / 1000) * cfFor('Acid') / safePurity(purePercents.hno3),
    });
    remainNO3 = 0;
  }

  // ── 8. Silicon ────────────────────────────────────────────────────
  if (remainSi > 0) {
    result.push({
      name: 'Potassium Silicate',
      formula: 'K2SiO3',
      tank: 'Silicon',
      mmolPerLiter: remainSi,
      gramsPerLiter: (remainSi * MW['K2SiO3'] / 1000) * cfFor('Silicon') / safePurity(purePercents.k2sio3),
    });
  }

  // ── 9. Micronutrients ─────────────────────────────────────────────
  const microFertMap: Record<string, { amount: number; fertKey: keyof typeof fertOpts; nameMap: Record<string, { name: string; formula: string; mw: number }> }> = {
    Fe: {
      amount: toAdd.Fe,
      fertKey: 'iron' as keyof typeof fertOpts,
      nameMap: {
        fe_dtpa: { name: 'Iron DTPA', formula: 'Fe-DTPA', mw: MW['Fe-DTPA'] },
        fe_eddha: { name: 'Iron EDDHA', formula: 'Fe-EDDHA', mw: MW['Fe-EDDHA'] },
        fe_edta: { name: 'Iron EDTA', formula: 'Fe-EDTA', mw: MW['Fe-EDTA'] },
      },
    },
    Mn: {
      amount: toAdd.Mn,
      fertKey: 'manganese' as keyof typeof fertOpts,
      nameMap: {
        mnso4: { name: 'Manganese Sulfate', formula: 'MnSO4·H2O', mw: MW['MnSO4·H2O'] },
        mn_edta: { name: 'Manganese EDTA', formula: 'Mn-EDTA', mw: MW['Mn-EDTA'] },
        mn_dtpa: { name: 'Manganese DTPA', formula: 'Mn-DTPA', mw: MW['Mn-DTPA'] },
      },
    },
    Zn: {
      amount: toAdd.Zn,
      fertKey: 'zinc' as keyof typeof fertOpts,
      nameMap: {
        znso4: { name: 'Zinc Sulfate', formula: 'ZnSO4·7H2O', mw: MW['ZnSO4·7H2O'] },
        zn_edta: { name: 'Zinc EDTA', formula: 'Zn-EDTA', mw: MW['Zn-EDTA'] },
        zn_dtpa: { name: 'Zinc DTPA', formula: 'Zn-DTPA', mw: MW['Zn-DTPA'] },
      },
    },
    Cu: {
      amount: toAdd.Cu,
      fertKey: 'copper' as keyof typeof fertOpts,
      nameMap: {
        cuso4: { name: 'Copper Sulfate', formula: 'CuSO4·5H2O', mw: MW['CuSO4·5H2O'] },
        cu_edta: { name: 'Copper EDTA', formula: 'Cu-EDTA', mw: MW['Cu-EDTA'] },
      },
    },
    B: {
      amount: toAdd.B,
      fertKey: 'boron' as keyof typeof fertOpts,
      nameMap: {
        h3bo3: { name: 'Boric Acid', formula: 'H3BO3', mw: MW['H3BO3'] },
        borax: { name: 'Borax', formula: 'Borax', mw: MW['Borax'] },
      },
    },
    Mo: {
      amount: toAdd.Mo,
      fertKey: 'molybdenum' as keyof typeof fertOpts,
      nameMap: {
        na2moo4: { name: 'Sodium Molybdate', formula: 'Na2MoO4·2H2O', mw: MW['Na2MoO4·2H2O'] },
        nh4_mo: { name: 'Ammonium Molybdate', formula: '(NH4)6Mo7O24·4H2O', mw: MW['(NH4)6Mo7O24·4H2O'] },
      },
    },
  };

  for (const [element, config] of Object.entries(microFertMap)) {
    if (config.amount <= 0) continue;
    const fertOption = fertOpts[config.fertKey as keyof typeof fertOpts];
    if (typeof fertOption === 'boolean') continue;
    const fert = fertOption as { fertilizer: string; purityPercent: number };
    const info = config.nameMap[fert.fertilizer];
    if (!info) continue;

    // umol/L → grams/L of stock
    const microTank = element === 'Fe' ? 'A' : 'Micro';
    const umol = config.amount;
    const gramsPerLiterFinal = (umol * info.mw / 1_000_000) * cfFor(microTank) / safePurity(fert.purityPercent);

    result.push({
      name: info.name,
      formula: info.formula,
      tank: microTank,
      mmolPerLiter: umol / 1000, // convert to mmol for display
      gramsPerLiter: gramsPerLiterFinal,
    });
  }

  // Warn about remaining unallocated amounts
  if (remainK > 0.01) warnings.push(`${remainK.toFixed(2)} mmol/L K+ could not be allocated.`);
  if (remainMg > 0.01) warnings.push(`${remainMg.toFixed(2)} mmol/L Mg2+ could not be allocated.`);
  if (remainNH4 > 0.01) warnings.push(`${remainNH4.toFixed(2)} mmol/L NH4+ could not be allocated.`);
  if (remainSO4 > 0.01) warnings.push(`${remainSO4.toFixed(2)} mmol/L SO4 2- could not be allocated.`);

  return { fertilizers: result, warnings };
}
