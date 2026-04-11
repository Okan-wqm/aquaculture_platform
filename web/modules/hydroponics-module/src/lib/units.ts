import Decimal from 'decimal.js';

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
// Input Validation
// ============================================================================

/**
 * Validates a numeric input and returns a Decimal.
 * Throws a descriptive error instead of silently coercing to 0.
 *
 * WHY: Silent coercion to 0 masks data-entry mistakes and corrupts
 * downstream calculations. A NaN or undefined concentration that becomes 0
 * is indistinguishable from "no nutrient present", leading to under-dosing
 * or overdosing in the final recipe.
 *
 * @param value   - The numeric input to validate
 * @param context - Human-readable label for error messages (e.g. "mmol for K")
 * @returns A validated Decimal instance
 * @throws Error if the value is not a finite number
 */
export function validateNumericInput(value: number, context: string): Decimal {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    throw new Error(
      `Invalid numeric input for ${context}: received ${String(value)}. ` +
      `Expected a finite number.`,
    );
  }
  return new Decimal(value);
}

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Convert mmol/L to mg/L using exact decimal arithmetic.
 *
 * @param mmol    - Concentration in mmol/L
 * @param element - Element or compound key (must exist in MOLAR_MASS)
 * @returns Concentration in mg/L
 * @throws Error if mmol is not a finite number
 */
export function mmolToMgL(mmol: number, element: string): number {
  const mass = MOLAR_MASS[element];
  if (!mass) return 0;
  const d = validateNumericInput(mmol, `mmol for ${element}`);
  return d.times(mass).toNumber();
}

/**
 * Convert mg/L to mmol/L using exact decimal arithmetic.
 *
 * @param mgL     - Concentration in mg/L
 * @param element - Element or compound key
 * @returns Concentration in mmol/L
 * @throws Error if mgL is not a finite number
 */
export function mgLToMmol(mgL: number, element: string): number {
  const mass = MOLAR_MASS[element];
  if (!mass) return 0;
  const d = validateNumericInput(mgL, `mg/L for ${element}`);
  return d.dividedBy(mass).toNumber();
}

/**
 * Convert mmol/L to meq/L using exact decimal arithmetic.
 *
 * @param mmol    - Concentration in mmol/L
 * @param element - Element or compound key (must exist in VALENCE)
 * @returns Concentration in meq/L
 * @throws Error if mmol is not a finite number
 */
export function mmolToMeqL(mmol: number, element: string): number {
  const valence = VALENCE[element];
  if (!valence) return 0;
  const d = validateNumericInput(mmol, `mmol for ${element}`);
  return d.times(valence).toNumber();
}

/**
 * Convert meq/L to mmol/L using exact decimal arithmetic.
 *
 * @param meqL    - Concentration in meq/L
 * @param element - Element or compound key
 * @returns Concentration in mmol/L
 * @throws Error if meqL is not a finite number
 */
export function meqLToMmol(meqL: number, element: string): number {
  const valence = VALENCE[element];
  if (!valence) return 0;
  const d = validateNumericInput(meqL, `meq/L for ${element}`);
  return d.dividedBy(valence).toNumber();
}

/**
 * Convert umol/L to ug/L (ppb) using exact decimal arithmetic.
 *
 * @param umol    - Concentration in umol/L
 * @param element - Element or compound key
 * @returns Concentration in ug/L
 * @throws Error if umol is not a finite number
 */
export function umolToUgL(umol: number, element: string): number {
  const mass = MOLAR_MASS[element];
  if (!mass) return 0;
  const d = validateNumericInput(umol, `umol for ${element}`);
  return d.times(mass).toNumber();
}

/**
 * Convert ug/L (ppb) to umol/L using exact decimal arithmetic.
 *
 * @param ugL     - Concentration in ug/L
 * @param element - Element or compound key
 * @returns Concentration in umol/L
 * @throws Error if ugL is not a finite number
 */
export function ugLToUmol(ugL: number, element: string): number {
  const mass = MOLAR_MASS[element];
  if (!mass) return 0;
  const d = validateNumericInput(ugL, `ug/L for ${element}`);
  return d.dividedBy(mass).toNumber();
}

/**
 * Convert umol/L to mg/L (ppm) using exact decimal arithmetic.
 *
 * @param umol    - Concentration in umol/L
 * @param element - Element or compound key
 * @returns Concentration in mg/L (ppm)
 * @throws Error if umol is not a finite number
 */
export function umolToMgL(umol: number, element: string): number {
  const mass = MOLAR_MASS[element];
  if (!mass) return 0;
  const d = validateNumericInput(umol, `umol for ${element}`);
  return d.times(mass).dividedBy(1000).toNumber();
}

/**
 * Convert mg/L (ppm) to umol/L using exact decimal arithmetic.
 *
 * @param mgL     - Concentration in mg/L
 * @param element - Element or compound key
 * @returns Concentration in umol/L
 * @throws Error if mgL is not a finite number
 */
export function mgLToUmol(mgL: number, element: string): number {
  const mass = MOLAR_MASS[element];
  if (!mass) return 0;
  const d = validateNumericInput(mgL, `mg/L for ${element}`);
  return d.times(1000).dividedBy(mass).toNumber();
}
