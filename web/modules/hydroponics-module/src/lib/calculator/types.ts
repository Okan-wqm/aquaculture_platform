import type { NutrientProfile, DrainageComposition, CurrentNsFormula, ReadjustmentSettings } from '../../types/modes.types';
import type { SolutionSettings } from '../../types/solution.types';

// ============================================================================
// Calculator Input
// ============================================================================

export interface CalcInput {
  settings: SolutionSettings;
  profile: NutrientProfile;
  preferenceMultipliers: Record<string, number>;
}

// ============================================================================
// Intermediate Structures
// ============================================================================

/** Nutrient concentrations in mmol/L (macro) and umol/L (micro) */
export interface NutrientVector {
  K: number;
  Ca: number;
  Mg: number;
  NH4: number;
  NO3: number;
  H2PO4: number;
  SO4: number;
  Cl: number;
  Na: number;
  HCO3: number;
  Si: number;
  // Micro in umol/L
  Fe: number;
  Mn: number;
  Zn: number;
  Cu: number;
  B: number;
  Mo: number;
}

export function emptyVector(): NutrientVector {
  return {
    K: 0, Ca: 0, Mg: 0, NH4: 0, NO3: 0, H2PO4: 0, SO4: 0,
    Cl: 0, Na: 0, HCO3: 0, Si: 0,
    Fe: 0, Mn: 0, Zn: 0, Cu: 0, B: 0, Mo: 0,
  };
}

export interface DripSolution {
  ec: number;
  ph: number;
  nutrients: NutrientVector;
}

export interface SubtractResult {
  toAdd: NutrientVector;
  warnings: string[];
}

// ============================================================================
// Fertilizer Allocation
// ============================================================================

export interface FertilizerAmount {
  name: string;
  formula: string;
  tank: string;          // A, B, Acid, Micro, Silicon
  mmolPerLiter: number;  // per liter of final solution
  gramsPerLiter: number; // per liter of stock (after concentration factor)
}

// ============================================================================
// Final Result
// ============================================================================

export interface IonBalance {
  totalCations: number; // meq/L
  totalAnions: number;  // meq/L
  balancePercent: number;
}

export interface CalcResult {
  dripSolution: NutrientVector;
  irrigationWater: NutrientVector;
  addedSolution: NutrientVector;      // For closed: AS = (Drip - DS*DF)/(1-DF)
  toAdd: NutrientVector;              // After subtracting water
  fertilizers: FertilizerAmount[];
  ionBalance: IonBalance;
  warnings: string[];
  ec: number;
  ph: number;
}
