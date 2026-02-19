// ============================================================================
// Molar Masses (g/mol)
// ============================================================================

export const MOLAR_MASS: Record<string, number> = {
  K: 39.098,
  Ca: 40.078,
  Mg: 24.305,
  N: 14.007,
  P: 30.974,
  S: 32.065,
  Cl: 35.453,
  Na: 22.990,
  Si: 28.086,
  Fe: 55.845,
  Mn: 54.938,
  Zn: 65.380,
  Cu: 63.546,
  B: 10.811,
  Mo: 95.950,
  // Compound masses for water analysis conversions
  NO3: 62.004,   // NO3-
  NH4: 18.039,   // NH4+
  SO4: 96.063,   // SO4 2-
  H2PO4: 96.987, // H2PO4-
  HCO3: 61.017,  // HCO3-
};

// ============================================================================
// Valences (charge per ion)
// ============================================================================

export const VALENCE: Record<string, number> = {
  K: 1,
  Ca: 2,
  Mg: 2,
  Na: 1,
  NH4: 1,
  NO3: 1,
  H2PO4: 1,
  SO4: 2,
  Cl: 1,
  HCO3: 1,
};

// ============================================================================
// Conversion Functions
// ============================================================================

/** Convert mmol/L to mg/L */
export function mmolToMgL(mmol: number, element: string): number {
  const mass = MOLAR_MASS[element];
  if (!mass) return 0;
  return mmol * mass;
}

/** Convert mg/L to mmol/L */
export function mgLToMmol(mgL: number, element: string): number {
  const mass = MOLAR_MASS[element];
  if (!mass) return 0;
  return mgL / mass;
}

/** Convert mmol/L to meq/L */
export function mmolToMeqL(mmol: number, element: string): number {
  const valence = VALENCE[element];
  if (!valence) return 0;
  return mmol * valence;
}

/** Convert meq/L to mmol/L */
export function meqLToMmol(meqL: number, element: string): number {
  const valence = VALENCE[element];
  if (!valence) return 0;
  return meqL / valence;
}

/** Convert umol/L to ug/L (ppb) */
export function umolToUgL(umol: number, element: string): number {
  const mass = MOLAR_MASS[element];
  if (!mass) return 0;
  return umol * mass;
}

/** Convert ug/L (ppb) to umol/L */
export function ugLToUmol(ugL: number, element: string): number {
  const mass = MOLAR_MASS[element];
  if (!mass) return 0;
  return ugL / mass;
}

/** Convert umol/L to mg/L (ppm) - same as umolToUgL / 1000 */
export function umolToMgL(umol: number, element: string): number {
  return umolToUgL(umol, element) / 1000;
}

/** Convert mg/L (ppm) to umol/L */
export function mgLToUmol(mgL: number, element: string): number {
  const mass = MOLAR_MASS[element];
  if (!mass) return 0;
  return (mgL * 1000) / mass;
}
