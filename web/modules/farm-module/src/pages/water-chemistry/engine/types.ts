/**
 * Water Chemistry Engine - Type Definitions
 * Ported from Python v1.py water quality calculator
 */

export interface WaterParams {
  tempC: number;        // Temperature in Celsius
  pH: number;           // pH on NBS scale
  salinity: number;     // Salinity in ppt
  alkalinity: number;   // Alkalinity in meq/L (convert from mg/L CaCO3 by dividing by 50.04345)
}

export interface TargetParams {
  targetpH: number;           // Target pH on NBS scale
  targetAlkalinity: number;   // Target alkalinity in meq/L
}

export interface ToxicLimits {
  tan: number;             // Total Ammonia Nitrogen in mg/L
  unIonizedNH3: number;    // Un-ionized NH3-N limit in mg/L
  co2Toxic: number;        // CO2 toxic level in mg/L
  h2s: number;             // H2S in mg/L
}

export interface SystemParams {
  volume: number;          // System volume in m3
  fishType: FishType;
  fishSize: FishSize;
}

export type FishType =
  | 'Arctic Charr'
  | 'Atlantic Salmon'
  | 'Rainbow Trout'
  | 'Brown Trout'
  | 'Sea Bass'
  | 'Sea Bream'
  | 'Turbot'
  | 'Tilapia';

export type FishSize =
  | '0-5 gram'
  | '5-20 gram'
  | '20-100 gram'
  | '100-500 gram'
  | '500+ gram';

export interface ReagentInfo {
  name: string;
  formula: string;
  mw: number;           // Molecular weight g/mol
  meqPerMol: number;    // meq per mol
  slope: number;        // dAlk/dDIC slope (Infinity for vertical)
  radians: number;      // Direction angle in radians
}

export interface DosingResult {
  reagentName: string;
  formula: string;
  amountKg: number;     // Amount in kg
  amountGrams: number;  // Amount in grams
  deltaAlk: number;     // Change in alkalinity meq/L
  deltaDIC: number;     // Change in DIC mmol/L
}

export interface DosingRecipe {
  description: string;
  steps: DosingResult[];
}

export interface OperatingPoint {
  DIC: number;   // mmol/L (mM)
  ALK: number;   // meq/L
}

export interface SafeZone {
  topLeft: OperatingPoint;
  topRight: OperatingPoint;
  bottomRight: OperatingPoint;
  bottomLeft: OperatingPoint;
}

export interface PHIsoline {
  pH: number;
  color: string;
  points: Array<{ CT: number; AT: number }>;
}

export interface ToxicZone {
  label: string;
  color: string;
  points: Array<{ CT: number; AT: number }>;
}

export interface OmegaIsopleth {
  label: string;
  color: string;
  points: Array<{ CT: number; AT: number }>;
}

/** Two-reagent dosing visualization on Deffeyes diagram */
export interface DosingVisualization {
  /** Direction line of reagent 1 from current point */
  reagentLine1: { points: Array<{ CT: number; AT: number }>; label: string; color: string };
  /** Direction line of reagent 2 from current point */
  reagentLine2: { points: Array<{ CT: number; AT: number }>; label: string; color: string };
  /** Step 1 path: current → intermediate */
  step1Path: Array<{ CT: number; AT: number }>;
  /** Step 2 path: intermediate → target */
  step2Path: Array<{ CT: number; AT: number }>;
  /** Intermediate point (intersection of two reagent lines) */
  intermediatePoint: OperatingPoint;
  /** Labels */
  step1Label: string;
  step2Label: string;
}

export interface DeffeyesChartData {
  isolines: PHIsoline[];
  nh3ToxicZone: ToxicZone | null;
  co2ToxicZone: ToxicZone | null;
  safeZone: SafeZone | null;
  currentPoint: OperatingPoint;
  targetPoint: OperatingPoint | null;
  reagentLine: Array<{ CT: number; AT: number }> | null;
  dosingVisualization: DosingVisualization | null;
  omegaCalcite: OmegaIsopleth | null;
  omegaAragonite: OmegaIsopleth | null;
}

export interface CalculatedOutputs {
  toxicNH3pH: number;          // pH where NH3 becomes toxic
  toxicCO2pH: number;          // pH where CO2 becomes toxic
  uiaNPercent: number;         // UIA-N % at TAN-pH border
  targetCO2: number;           // CO2 at target point mg/L
  currentCO2: number;          // CO2 at current point mg/L
  currentDIC: number;          // Current DIC mmol/L
  targetDIC: number;           // Target DIC mmol/L
  dosingRecipes: DosingRecipe[];
  // UIA safety fields (from R Shiny UIA module)
  currentUIA: number;          // Current NH3-N at operating conditions (mg/L)
  safeTAN: number;             // Max safe TAN at current pH/T/S (mg/L)
  uiaStatusLevel: 'safe' | 'alert' | 'danger';  // Green/yellow/red
  deltaPH: number;             // criticalPH - currentPH (positive = safe margin)
  // H₂S safety fields
  toxicH2SpH: number;          // pH where H₂S reaches toxic limit (below this = danger)
  currentH2S: number;          // Current H₂S at operating conditions (µg/L)
  totalSulfide: number;        // Calculated total sulfide (µg/L)
  safeTotalSulfide: number;    // Max safe total sulfide at current pH/T/S (µg/L)
  h2sStatusLevel: 'safe' | 'alert' | 'danger';
  h2sDeltaPH: number;          // currentPH - criticalPH (positive = safe margin, opposite of NH3)
}

/** Single step in the on-demand forward dosing path */
export interface OnDemandStep {
  label: string;     // e.g. "Start", "After NaHCO₃", "Final"
  dic: number;       // mmol/L
  alk: number;       // meq/L
  ph: number;
  co2: number;       // mg/L
  amountKg: number;  // amount added (0 for start)
}

/** One chemical + amount entry for on-demand dosing */
export interface OnDemandInput {
  reagentKey: string;  // reagent name (matches ReagentInfo.name)
  amountGrams: number;
}

/** Convert alkalinity from mg/L CaCO3 to meq/L */
export function alkMgToMeq(mgPerL: number): number {
  return mgPerL / 50.04345;
}

/** Convert alkalinity from meq/L to mg/L CaCO3 */
export function alkMeqToMg(meqPerL: number): number {
  return meqPerL * 50.04345;
}

/** Celsius to Kelvin */
export function tempCToK(tempC: number): number {
  return tempC + 273.15;
}
