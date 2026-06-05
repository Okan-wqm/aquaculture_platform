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

export interface DicPhPoint {
  CT: number;       // DIC / CT in mmol/L
  pH: number;       // pH on NBS scale
  AT?: number;      // Source alkalinity in meq/L, when projected from ALK/DIC space
  sourceIndex?: number;
}

export type DicPhSegment = DicPhPoint[];

export interface DicPhLine {
  label: string;
  color: string;
  points: DicPhPoint[];
  segments?: DicPhSegment[];
  value?: number;
}

export interface DicPhToxicZone {
  label: string;
  color: string;
  fillColor: string;
  boundary: DicPhPoint[];
  boundarySegments?: DicPhSegment[];
  polygons: DicPhPoint[][];
  criticalPH?: number;
}

export interface DicPhSafeBand {
  label: string;
  color: string;
  polygons: DicPhPoint[][];
}

export interface DicPhDosingVisualization {
  reagentLine1: { points: DicPhPoint[]; label: string; color: string };
  reagentLine2: { points: DicPhPoint[]; label: string; color: string };
  reagentLine1Segments?: DicPhSegment[];
  reagentLine2Segments?: DicPhSegment[];
  step1Path: DicPhPoint[];
  step2Path: DicPhPoint[];
  step1PathSegments?: DicPhSegment[];
  step2PathSegments?: DicPhSegment[];
  intermediatePoint: DicPhPoint | null;
  step1Label: string;
  step2Label: string;
}

export interface DeffeyesPHLimits {
  tanMgL: number;
  unIonizedNH3MgL: number;
  co2ToxicMgL: number;
  h2sMeasuredUgL: number;
  h2sLimitUgL: number;
  currentPH: number;
}

export interface ProjectionLayerStats {
  projected: number;
  rejected: number;
  clipped: number;
  segments: number;
}

/**
 * Projection diagnostics for the DIC/pH Deffeyes chart.
 *
 * Top-level counters aggregate only ALK/DIC-rendered projection layers, such as
 * alkalinity, omega, and target path lines. The `layers` map contains per-layer
 * diagnostics for every render layer, including pH references and toxic fills.
 */
export interface ProjectionStats extends ProjectionLayerStats {
  toxicSegments: number;
  layers: Record<string, ProjectionLayerStats>;
}

export interface DeffeyesPHChartData {
  domain: { maxDIC: number; minPH: number; maxPH: number };
  pHReferences: DicPhLine[];
  alkalinityLines: DicPhLine[];
  nh3ToxicZone: DicPhToxicZone | null;
  co2ToxicZone: DicPhToxicZone | null;
  h2sToxicZone: DicPhToxicZone | null;
  safeBands: DicPhSafeBand[];
  currentPoint: DicPhPoint;
  targetPoint: DicPhPoint | null;
  targetPath?: DicPhPoint[];
  targetPathSegments?: DicPhSegment[];
  reagentLine: DicPhPoint[] | null;
  reagentLineSegments?: DicPhSegment[];
  dosingVisualization: DicPhDosingVisualization | null;
  omegaCalcite: DicPhLine | null;
  omegaAragonite: DicPhLine | null;
  projectionStats: ProjectionStats;
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

// ============================================================================
// ION BALANCE (meq/L based)
// ============================================================================

/**
 * Ion concentration in milliequivalents per liter (meq/L).
 *
 * WHY meq/L not mg/L or %:
 * Ion balance must account for ionic charge. A simple percentage of
 * mg/L concentrations is misleading for mixed-valence solutions
 * (e.g., Ca²⁺ contributes 2 equivalents per mole vs Na⁺ at 1).
 * meq/L normalizes by charge, giving a physically meaningful balance.
 *
 * @see PLAT-MEDIUM-006 (ion balance uses % instead of meq/L)
 */
export interface IonConcentrationMeqL {
  /** Ion name (e.g. 'Ca2+', 'Mg2+', 'Na+', 'K+', 'HCO3-', 'SO42-', 'Cl-') */
  ion: string;
  /** Concentration in milliequivalents per liter */
  meqL: number;
}

/**
 * Result of an ion balance calculation in meq/L.
 */
export interface IonBalanceResult {
  /** Sum of cation concentrations (meq/L) */
  totalCationsMeqL: number;
  /** Sum of anion concentrations (meq/L) */
  totalAnionsMeqL: number;
  /**
   * Ion balance error as a percentage:
   *   IBE = ((cations - anions) / (cations + anions)) * 100
   *
   * Acceptable range: -5% to +5% (APHA Standard Methods 1030E)
   */
  ionBalanceErrorPercent: number;
  /** Whether the balance is within acceptable limits (|IBE| <= 5%) */
  isAcceptable: boolean;
}

/**
 * Convert mg/L to meq/L for a given ion.
 *
 * @param mgL     - Concentration in mg/L
 * @param molarMass - Molar mass of the ion (g/mol)
 * @param charge    - Absolute ionic charge (e.g. 2 for Ca²⁺, 1 for Na⁺)
 * @returns Concentration in meq/L
 */
export function mgLToMeqL(mgL: number, molarMass: number, charge: number): number {
  if (molarMass <= 0 || charge <= 0) return 0;
  return (mgL / molarMass) * charge;
}

/**
 * Calculate ion balance using milliequivalent concentrations.
 *
 * This is the correct method for aquaculture water chemistry per
 * APHA Standard Methods 1030E. Simple percentage-based balance
 * is inaccurate for mixed-valence ion solutions.
 *
 * @param cations - Array of cation concentrations in meq/L
 * @param anions  - Array of anion concentrations in meq/L
 * @returns Ion balance result with error percentage and acceptability
 */
export function calcIonBalance(
  cations: IonConcentrationMeqL[],
  anions: IonConcentrationMeqL[],
): IonBalanceResult {
  const totalCationsMeqL = cations.reduce((sum, c) => sum + c.meqL, 0);
  const totalAnionsMeqL = anions.reduce((sum, a) => sum + a.meqL, 0);

  const denominator = totalCationsMeqL + totalAnionsMeqL;
  const ionBalanceErrorPercent = denominator > 0
    ? ((totalCationsMeqL - totalAnionsMeqL) / denominator) * 100
    : 0;

  return {
    totalCationsMeqL,
    totalAnionsMeqL,
    ionBalanceErrorPercent,
    isAcceptable: Math.abs(ionBalanceErrorPercent) <= 5,
  };
}

/**
 * Common aquaculture ion molar masses and charges for convenience.
 * Use with `mgLToMeqL()` for converting field measurements.
 */
export const COMMON_IONS = {
  // Cations
  'Ca2+':  { molarMass: 40.078,  charge: 2 },
  'Mg2+':  { molarMass: 24.305,  charge: 2 },
  'Na+':   { molarMass: 22.990,  charge: 1 },
  'K+':    { molarMass: 39.098,  charge: 1 },
  'Fe2+':  { molarMass: 55.845,  charge: 2 },
  'Fe3+':  { molarMass: 55.845,  charge: 3 },
  'NH4+':  { molarMass: 18.039,  charge: 1 },
  // Anions
  'HCO3-': { molarMass: 61.017,  charge: 1 },
  'CO32-': { molarMass: 60.009,  charge: 2 },
  'SO42-': { molarMass: 96.062,  charge: 2 },
  'Cl-':   { molarMass: 35.453,  charge: 1 },
  'NO3-':  { molarMass: 62.004,  charge: 1 },
  'F-':    { molarMass: 18.998,  charge: 1 },
} as const;
