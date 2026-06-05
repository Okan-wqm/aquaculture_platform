/**
 * Deffeyes Diagram Data Generator
 * Ported from Python PlotCanvas.tanolustur()
 *
 * Generates all data needed for the Deffeyes (Alkalinity vs DIC) diagram:
 * - pH isolines (4.25 - 12.50)
 * - NH3 toxic zone
 * - CO2 toxic zone
 * - Safe operating zone (green)
 * - Current and target operating points
 */

import { calcTotalSulfide, fractionH2S, fractionNH3, criticalPHforNH3 } from './ammonia-calc.js';
import { criticalPHforCO2 } from './co2-calc.js';
import {
  PHIsoline,
  ToxicZone,
  SafeZone,
  OperatingPoint,
  OmegaIsopleth,
  DeffeyesChartData,
  DeffeyesPHChartData,
  DeffeyesPHLimits,
  DicPhSegment,
  DicPhLine,
  DicPhPoint,
  DicPhSafeBand,
  DicPhToxicZone,
  ProjectionLayerStats,
  ProjectionStats,
  WaterParams,
  TargetParams,
  ToxicLimits,
} from './types.js';
import {
  phLineSlope,
  phLineIntercept,
  phNbsToFree,
  calcDicOfAlk,
  calcCo2OfDic,
  calcAlkOfDicPh,
  alphaTwo,
  calcKspCalcite,
  calcKspAragonite,
} from './water-quality.js';

// ============================================================================
// PH ISOLINE GENERATION
// ============================================================================

/** pH values for isolines: 4.25 to 12.50, step 0.25 */
const PH_ISOLINE_VALUES: number[] = [];
for (let pH = 4.25; pH <= 12.50; pH += 0.25) {
  PH_ISOLINE_VALUES.push(parseFloat(pH.toFixed(2)));
}

/** Color palette for pH isolines */
function phIsolineColor(pH: number): string {
  // Gradient from red (low pH) through green (neutral) to purple (high pH)
  if (pH < 6.0) return '#dc2626';      // red
  if (pH < 6.5) return '#ef4444';      // light red
  if (pH < 7.0) return '#f97316';      // orange
  if (pH < 7.5) return '#eab308';      // yellow
  if (pH < 8.0) return '#22c55e';      // green
  if (pH < 8.5) return '#06b6d4';      // cyan
  if (pH < 9.0) return '#3b82f6';      // blue
  if (pH < 9.5) return '#6366f1';      // indigo
  if (pH < 10.0) return '#a855f7';     // purple
  return '#7c3aed';                      // deep purple
}

/**
 * Generate pH isolines for the Deffeyes diagram
 * Each isoline: AT = slope * CT + intercept
 *
 * DIC range: 0 to maxDIC (mmol/L)
 */
export function generatePHIsolines(
  tempC: number,
  S: number,
  maxDIC = 6,
  step = maxDIC / 100
): PHIsoline[] {
  const isolines: PHIsoline[] = [];

  for (const pH of PH_ISOLINE_VALUES) {
    const pHfree = phNbsToFree(pH, tempC, S);
    const slope = phLineSlope(pHfree, tempC, S);
    const intercept = phLineIntercept(pHfree, tempC, S);

    const points: Array<{ CT: number; AT: number }> = [];
    for (let ct = 0; ct <= maxDIC; ct += step) {
      const at = ct * slope + intercept;
      points.push({
        CT: parseFloat(ct.toFixed(4)),
        AT: parseFloat(at.toFixed(4)),
      });
    }

    isolines.push({
      pH,
      color: phIsolineColor(pH),
      points,
    });
  }

  return isolines;
}

// ============================================================================
// TOXIC ZONES
// ============================================================================

/**
 * Generate NH3 toxic zone boundary on Deffeyes diagram.
 * Above this pH line, NH3 exceeds the toxic limit.
 * Returns points tracing the boundary and filling upward.
 */
export function generateNH3ToxicZone(
  tempC: number,
  S: number,
  tan: number,
  nh3Limit: number,
  alkMin: number,
  alkMax: number,
  maxDIC = 6
): ToxicZone | null {
  const critPH = criticalPHforNH3(tan, nh3Limit, tempC, S);
  if (isNaN(critPH)) return null;

  const pHfree = phNbsToFree(critPH, tempC, S);
  const slope = phLineSlope(pHfree, tempC, S);
  const intercept = phLineIntercept(pHfree, tempC, S);

  // The toxic boundary is the pH isoline at critPH
  // Generate raw boundary line points (including negative AT for interpolation)
  const boundaryPoints: Array<{ CT: number; AT: number }> = [];
  const scanMax = maxDIC * 3;
  for (let ct = 0; ct <= scanMax; ct += scanMax / 200) {
    const at = ct * slope + intercept;
    boundaryPoints.push({ CT: parseFloat(ct.toFixed(4)), AT: parseFloat(at.toFixed(4)) });
  }

  return {
    label: `NH₃ Toxic (pH > ${critPH.toFixed(2)})`,
    color: 'rgba(239, 68, 68, 0.15)',
    points: boundaryPoints,
  };
}

/**
 * Generate CO2 toxic zone boundary on Deffeyes diagram.
 * Below this pH line, CO2 exceeds the toxic limit.
 * Returns points tracing the boundary and filling downward.
 */
export function generateCO2ToxicZone(
  tempC: number,
  S: number,
  alkMeq: number,
  co2CritMg: number,
  maxDIC = 6
): ToxicZone | null {
  // For each DIC, find the pH where CO2 = co2Crit, then get ALK at that pH
  // Scan a wider CT range (up to maxDIC*3) to ensure curve crosses both AT=0 and AT=maxALK
  const scanMax = maxDIC * 3;
  const boundaryPoints: Array<{ CT: number; AT: number }> = [];

  for (let ct = 0.01; ct <= scanMax; ct += scanMax / 200) {
    const critPH = criticalPHforCO2AtDIC(ct, co2CritMg, tempC, S);
    if (!isNaN(critPH)) {
      const at = calcAlkOfDicPh(ct, critPH, tempC, S);
      if (isFinite(at)) {
        boundaryPoints.push({ CT: parseFloat(ct.toFixed(4)), AT: parseFloat(at.toFixed(4)) });
      }
    }
  }

  if (boundaryPoints.length < 2) return null;

  return {
    label: `CO₂ Toxic (>${co2CritMg} mg/L)`,
    color: 'rgba(239, 68, 68, 0.15)',
    points: boundaryPoints,
  };
}

/**
 * Find pH where CO2 = critical level for a given DIC
 */
function criticalPHforCO2AtDIC(
  dicMM: number,
  co2CritMg: number,
  tempC: number,
  S: number,
  minPH = 4.0,
  maxPH = 12.0
): number {
  const co2CritMM = co2CritMg / 44.010;
  if (dicMM <= 0 || co2CritMM >= dicMM) return NaN;

  const co2AtMinPH = calcCo2OfDic(dicMM, minPH, tempC, S);
  const co2AtMaxPH = calcCo2OfDic(dicMM, maxPH, tempC, S);
  if (!isFinite(co2AtMinPH) || !isFinite(co2AtMaxPH)) return NaN;
  if (co2AtMinPH <= co2CritMM) return minPH - 1;
  if (co2AtMaxPH > co2CritMM) return maxPH + 1;

  let lo = minPH;
  let hi = maxPH;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const co2 = calcCo2OfDic(dicMM, mid, tempC, S);
    if (co2 > co2CritMM) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-7) break;
  }
  return (lo + hi) / 2;
}

// ============================================================================
// SAFE ZONE
// ============================================================================

/**
 * Generate the safe operating zone (green rectangle on Deffeyes diagram).
 * Bounded by:
 * - Left/Right: NH3 critical pH line and CO2 critical pH line
 * - Top/Bottom: Max and Min alkalinity
 */
export function generateSafeZone(
  tempC: number,
  S: number,
  tan: number,
  nh3Limit: number,
  co2CritMg: number,
  alkMinMeq: number,
  alkMaxMeq: number
): SafeZone | null {
  const nh3pH = criticalPHforNH3(tan, nh3Limit, tempC, S);
  if (isNaN(nh3pH)) return null;

  const co2pHMax = criticalPHforCO2(alkMaxMeq, co2CritMg, tempC, S);
  const co2pHMin = criticalPHforCO2(alkMinMeq, co2CritMg, tempC, S);
  if (isNaN(co2pHMax) || isNaN(co2pHMin)) return null;

  // Get DIC at the 4 corners
  const dicTopLeft = calcDicOfAlk(alkMaxMeq, nh3pH, tempC, S);
  const dicTopRight = calcDicOfAlk(alkMaxMeq, co2pHMax, tempC, S);
  const dicBottomLeft = calcDicOfAlk(alkMinMeq, nh3pH, tempC, S);
  const dicBottomRight = calcDicOfAlk(alkMinMeq, co2pHMin, tempC, S);

  // Validate all values
  if ([dicTopLeft, dicTopRight, dicBottomLeft, dicBottomRight].some(v => isNaN(v) || !isFinite(v))) {
    return null;
  }

  return {
    topLeft: { DIC: dicTopLeft, ALK: alkMaxMeq },
    topRight: { DIC: dicTopRight, ALK: alkMaxMeq },
    bottomRight: { DIC: dicBottomRight, ALK: alkMinMeq },
    bottomLeft: { DIC: dicBottomLeft, ALK: alkMinMeq },
  };
}

// ============================================================================
// OPERATING POINTS
// ============================================================================

/**
 * Calculate the current operating point (DIC, ALK) on the Deffeyes diagram
 */
export function calcOperatingPoint(
  pHnbs: number,
  alkMeq: number,
  tempC: number,
  S: number
): OperatingPoint {
  const dic = calcDicOfAlk(alkMeq, pHnbs, tempC, S);
  return { DIC: dic, ALK: alkMeq };
}

/**
 * Calculate the target operating point
 */
export function calcTargetPoint(
  targetpH: number,
  targetAlkMeq: number,
  tempC: number,
  S: number
): OperatingPoint {
  const dic = calcDicOfAlk(targetAlkMeq, targetpH, tempC, S);
  return { DIC: dic, ALK: targetAlkMeq };
}

// ============================================================================
// OMEGA (CALCITE/ARAGONITE) ISOPLETHS
// ============================================================================

/**
 * Generate Omega=1 saturation isopleth on the Deffeyes diagram.
 * For each DIC value, find the pH where Omega = 1 (saturation),
 * then compute ALK at that pH to get the (DIC, ALK) point.
 *
 * Omega = [Ca²⁺] * [CO₃²⁻] / Ksp
 * At Omega=1: [CO₃²⁻] = Ksp / [Ca²⁺]
 * [CO₃²⁻] = DIC * alpha2(pH)
 * So: DIC * alpha2(pH) = Ksp / Ca → find pH by bisection
 *
 * Based on R CarbCalc draw_omega_isopleth_ca() and calc_ph_omega_ca_given_dic()
 *
 * @param tempC - Temperature in Celsius
 * @param S - Salinity in ppt
 * @param caMolKg - Calcium in mol/kg-soln
 * @param ksp - Ksp value (calcite or aragonite)
 * @param maxDIC - Maximum DIC for scan
 */
function generateOmegaIsopleth(
  tempC: number,
  S: number,
  caMolKg: number,
  ksp: number,
  maxDIC = 8
): Array<{ CT: number; AT: number }> {
  const points: Array<{ CT: number; AT: number }> = [];
  if (caMolKg <= 0) return points;

  // Target CO3 concentration for Omega=1: CO3_target = Ksp / Ca (mol/kg)
  const co3Target = ksp / caMolKg;

  // Scan DIC range
  // Minimum DIC must be > co3Target (otherwise alpha2 would need to be > 1)
  const dicStart = co3Target * 1000 + 0.01; // mmol/L (co3Target is mol/kg)
  const dicStep = maxDIC / 200;

  for (let dic = Math.max(dicStart, 0.05); dic <= maxDIC; dic += dicStep) {
    // Find pH where DIC * alpha2(pH) * 1e-3 = co3Target
    // alpha2_target = co3Target / (dic * 1e-3)
    const alpha2Target = co3Target / (dic * 1e-3);
    if (alpha2Target >= 1 || alpha2Target <= 0) continue;

    // Bisection on NBS pH to find alpha2 = alpha2Target
    // alpha2 increases with pH
    let lo = 4.0, hi = 12.0;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const pHfree = phNbsToFree(mid, tempC, S);
      const a2 = alphaTwo(pHfree, tempC, S);
      if (a2 < alpha2Target) {
        lo = mid;
      } else {
        hi = mid;
      }
      if (hi - lo < 1e-7) break;
    }
    const satPH = (lo + hi) / 2;

    // Calculate ALK at this pH and DIC
    const alk = calcAlkOfDicPh(dic, satPH, tempC, S);
    if (isFinite(alk) && alk >= 0 && alk <= maxDIC * 4) {
      points.push({
        CT: parseFloat(dic.toFixed(4)),
        AT: parseFloat(alk.toFixed(4)),
      });
    }
  }

  return points;
}

/**
 * Generate Omega=1 Calcite isopleth for Deffeyes diagram
 */
export function generateCalciteIsopleth(
  tempC: number,
  S: number,
  caMgL: number,
  maxDIC = 8
): OmegaIsopleth | null {
  if (caMgL <= 0) return null;
  const caMolKg = caMgL / 40078; // mg/L → mol/L ≈ mol/kg
  const ksp = calcKspCalcite(tempC, S);
  const points = generateOmegaIsopleth(tempC, S, caMolKg, ksp, maxDIC);
  if (points.length < 2) return null;
  return { label: 'Ω-Calcite = 1', color: '#2563eb', points };
}

/**
 * Generate Omega=1 Aragonite isopleth for Deffeyes diagram
 */
export function generateAragoniteIsopleth(
  tempC: number,
  S: number,
  caMgL: number,
  maxDIC = 8
): OmegaIsopleth | null {
  if (caMgL <= 0) return null;
  const caMolKg = caMgL / 40078;
  const ksp = calcKspAragonite(tempC, S);
  const points = generateOmegaIsopleth(tempC, S, caMolKg, ksp, maxDIC);
  if (points.length < 2) return null;
  return { label: 'Ω-Aragonite = 1', color: '#d946ef', points };
}

// ============================================================================
// FULL CHART DATA ASSEMBLY
// ============================================================================

/**
 * Generate all data needed for the Deffeyes chart
 */
export function generateDeffeyesChartData(
  params: WaterParams,
  target: TargetParams | null,
  limits: ToxicLimits,
  alkMinMeq: number,
  alkMaxMeq: number,
  caMgL = 0,
  showTarget = true
): DeffeyesChartData {
  const { tempC, pH, salinity, alkalinity } = params;
  const maxDIC = 8;

  // pH isolines
  const isolines = generatePHIsolines(tempC, salinity, maxDIC);

  // Toxic zones
  const nh3ToxicZone = generateNH3ToxicZone(
    tempC, salinity, limits.tan, limits.unIonizedNH3,
    alkMinMeq, alkMaxMeq, maxDIC
  );
  const co2ToxicZone = generateCO2ToxicZone(
    tempC, salinity, alkalinity, limits.co2Toxic, maxDIC
  );

  // Safe zone
  const safeZoneData = generateSafeZone(
    tempC, salinity, limits.tan, limits.unIonizedNH3,
    limits.co2Toxic, alkMinMeq, alkMaxMeq
  );

  // Operating points
  const currentPoint = calcOperatingPoint(pH, alkalinity, tempC, salinity);

  let targetPoint: OperatingPoint | null = null;
  if (target && showTarget) {
    targetPoint = calcTargetPoint(target.targetpH, target.targetAlkalinity, tempC, salinity);
  }

  // Omega isopleths (Calcite & Aragonite saturation Ω=1)
  const omegaCalcite = caMgL > 0 ? generateCalciteIsopleth(tempC, salinity, caMgL, maxDIC) : null;
  const omegaAragonite = caMgL > 0 ? generateAragoniteIsopleth(tempC, salinity, caMgL, maxDIC) : null;

  return {
    isolines,
    nh3ToxicZone,
    co2ToxicZone,
    safeZone: safeZoneData,
    currentPoint,
    targetPoint,
    reagentLine: null,
    dosingVisualization: null,
    omegaCalcite,
    omegaAragonite,
  };
}

// ============================================================================
// DIC / PH CHART DATA ASSEMBLY
// ============================================================================

const PH_CHART_MIN = 4.0;
const PH_CHART_MAX = 12.5;
const PH_SOLVER_MIN = 0.0;
const PH_SOLVER_MAX = 14.0;
const PH_PROJECTION_TOLERANCE = 0.01;

type ProjectionStatus = 'projected' | 'rejected' | 'clipped';
type ProjectionCounters = ProjectionLayerStats;
type ProjectedDicPhLine = {
  points: DicPhPoint[];
  segments: DicPhSegment[];
  stats: ProjectionCounters;
};

function emptyProjectionCounters(): ProjectionCounters {
  return { projected: 0, rejected: 0, clipped: 0, segments: 0 };
}

function mergeProjectionCounters(layers: ProjectionCounters[]): ProjectionCounters {
  return layers.reduce((sum, layer) => ({
    projected: sum.projected + layer.projected,
    rejected: sum.rejected + layer.rejected,
    clipped: sum.clipped + layer.clipped,
    segments: sum.segments + layer.segments,
  }), emptyProjectionCounters());
}

function segmentLayerStats(segments: DicPhSegment[]): ProjectionCounters {
  return {
    projected: segments.reduce((sum, segment) => sum + segment.length, 0),
    rejected: 0,
    clipped: 0,
    segments: segments.length,
  };
}

function roundedPoint(point: DicPhPoint): DicPhPoint {
  return {
    CT: parseFloat(point.CT.toFixed(4)),
    pH: parseFloat(point.pH.toFixed(4)),
    ...(point.AT == null ? {} : { AT: parseFloat(point.AT.toFixed(4)) }),
    ...(point.sourceIndex == null ? {} : { sourceIndex: point.sourceIndex }),
  };
}

function solvePHForAlkDic(
  alkMeq: number,
  dicMM: number,
  tempC: number,
  S: number,
  minPH = PH_CHART_MIN,
  maxPH = PH_CHART_MAX
): number {
  if (!isFinite(alkMeq) || !isFinite(dicMM) || dicMM <= 0 || alkMeq < 0) return NaN;

  const alkAtMin = calcAlkOfDicPh(dicMM, minPH, tempC, S);
  const alkAtMax = calcAlkOfDicPh(dicMM, maxPH, tempC, S);
  if (!isFinite(alkAtMin) || !isFinite(alkAtMax)) return NaN;
  if (alkMeq < Math.min(alkAtMin, alkAtMax) - PH_PROJECTION_TOLERANCE) return NaN;
  if (alkMeq > Math.max(alkAtMin, alkAtMax) + PH_PROJECTION_TOLERANCE) return NaN;

  let lo = minPH;
  let hi = maxPH;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const calcAlk = calcAlkOfDicPh(dicMM, mid, tempC, S);
    if (calcAlk < alkMeq) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-8) break;
  }

  const pH = (lo + hi) / 2;
  const residual = Math.abs(calcAlkOfDicPh(dicMM, pH, tempC, S) - alkMeq);
  return residual <= PH_PROJECTION_TOLERANCE ? pH : NaN;
}

function solvePHForAlkDicUnbounded(
  alkMeq: number,
  dicMM: number,
  tempC: number,
  S: number
): number {
  return solvePHForAlkDic(alkMeq, dicMM, tempC, S, PH_SOLVER_MIN, PH_SOLVER_MAX);
}

export function criticalPHforNH3PHChartDomain(
  tan: number,
  nh3Limit: number,
  tempC: number,
  S: number,
  minPH = PH_CHART_MIN,
  maxPH = PH_CHART_MAX
): number {
  if (tan <= 0 || nh3Limit <= 0 || nh3Limit >= tan) return NaN;
  if (!isFinite(minPH) || !isFinite(maxPH) || minPH >= maxPH) return NaN;

  const targetFraction = nh3Limit / tan;
  const minFraction = fractionNH3(minPH, tempC, S);
  const maxFraction = fractionNH3(maxPH, tempC, S);
  if (!isFinite(minFraction) || !isFinite(maxFraction)) return NaN;
  if (targetFraction <= minFraction) return minPH - 1;
  if (targetFraction > maxFraction) return maxPH + 1;

  let lo = minPH;
  let hi = maxPH;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const fraction = fractionNH3(mid, tempC, S);
    if (fraction < targetFraction) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-8) break;
  }
  return (lo + hi) / 2;
}

export function criticalPHforH2SPHChartDomain(
  h2sMeasured: number,
  currentPH: number,
  h2sLimit: number,
  tempC: number,
  S: number,
  minPH = PH_CHART_MIN,
  maxPH = PH_CHART_MAX
): number {
  if (h2sMeasured <= 0 || h2sLimit <= 0) return NaN;
  if (!isFinite(minPH) || !isFinite(maxPH) || minPH >= maxPH) return NaN;

  const totalSulfide = calcTotalSulfide(h2sMeasured, currentPH, tempC, S);
  if (!isFinite(totalSulfide) || totalSulfide <= 0) return NaN;

  const targetFraction = h2sLimit / totalSulfide;
  if (targetFraction >= 1) return NaN;

  const minFraction = fractionH2S(minPH, tempC, S);
  const maxFraction = fractionH2S(maxPH, tempC, S);
  if (!isFinite(minFraction) || !isFinite(maxFraction)) return NaN;
  if (targetFraction > minFraction) return minPH - 1;
  if (targetFraction <= maxFraction) return maxPH + 1;

  let lo = minPH;
  let hi = maxPH;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const fraction = fractionH2S(mid, tempC, S);
    if (fraction > targetFraction) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-8) break;
  }
  return (lo + hi) / 2;
}

/** @deprecated Use criticalPHforNH3PHChartDomain. */
export function criticalPHforNH3InPHRange(
  tan: number,
  nh3Limit: number,
  tempC: number,
  S: number,
  minPH = PH_CHART_MIN,
  maxPH = PH_CHART_MAX
): number {
  return criticalPHforNH3PHChartDomain(tan, nh3Limit, tempC, S, minPH, maxPH);
}

/** @deprecated Use criticalPHforH2SPHChartDomain. */
export function criticalPHforH2SInPHRange(
  h2sMeasured: number,
  currentPH: number,
  h2sLimit: number,
  tempC: number,
  S: number,
  minPH = PH_CHART_MIN,
  maxPH = PH_CHART_MAX
): number {
  return criticalPHforH2SPHChartDomain(h2sMeasured, currentPH, h2sLimit, tempC, S, minPH, maxPH);
}

export function projectAlkDicPointToDicPh(
  point: { CT: number; AT: number },
  tempC: number,
  S: number,
  options: { minPH?: number; maxPH?: number; sourceIndex?: number; tolerance?: number } = {}
): DicPhPoint | null {
  const minPH = options.minPH ?? PH_CHART_MIN;
  const maxPH = options.maxPH ?? PH_CHART_MAX;
  const tolerance = options.tolerance ?? PH_PROJECTION_TOLERANCE;

  if (!isFinite(point.CT) || !isFinite(point.AT) || point.CT <= 0 || point.AT < 0) {
    return null;
  }

  const pH = solvePHForAlkDic(point.AT, point.CT, tempC, S, minPH, maxPH);
  if (!isFinite(pH) || pH < minPH - 1e-8 || pH > maxPH + 1e-8) return null;

  const residual = Math.abs(calcAlkOfDicPh(point.CT, pH, tempC, S) - point.AT);
  if (residual > tolerance) return null;

  return roundedPoint({
    CT: point.CT,
    pH,
    AT: point.AT,
    sourceIndex: options.sourceIndex,
  });
}

export function projectAlkDicLineToDicPh(
  points: Array<{ CT: number; AT: number }>,
  tempC: number,
  S: number,
  options: { minPH?: number; maxPH?: number; truncateOnInvalid?: boolean } = {}
): DicPhPoint[] {
  return projectAlkDicLineWithStats(points, tempC, S, options).points;
}

export function projectAlkDicLineSegmentsToDicPh(
  points: Array<{ CT: number; AT: number }>,
  tempC: number,
  S: number,
  options: { minPH?: number; maxPH?: number; truncateOnInvalid?: boolean } = {}
): DicPhSegment[] {
  return projectAlkDicLineWithStats(points, tempC, S, options).segments;
}

function projectAlkDicPointWithStatus(
  point: { CT: number; AT: number },
  tempC: number,
  S: number,
  options: { minPH?: number; maxPH?: number; sourceIndex?: number; tolerance?: number } = {}
): { point: DicPhPoint | null; status: ProjectionStatus } {
  const minPH = options.minPH ?? PH_CHART_MIN;
  const maxPH = options.maxPH ?? PH_CHART_MAX;

  if (!isFinite(point.CT) || !isFinite(point.AT) || point.CT <= 0 || point.AT < 0) {
    return { point: null, status: 'rejected' };
  }

  const fullDomainPH = solvePHForAlkDicUnbounded(point.AT, point.CT, tempC, S);
  if (!isFinite(fullDomainPH)) {
    return { point: null, status: 'rejected' };
  }
  if (fullDomainPH < minPH - 1e-8 || fullDomainPH > maxPH + 1e-8) {
    return { point: null, status: 'clipped' };
  }

  const projected = projectAlkDicPointToDicPh(point, tempC, S, options);
  if (!projected) {
    return { point: null, status: 'rejected' };
  }

  return { point: projected, status: 'projected' };
}

function projectAlkDicLineWithStats(
  points: Array<{ CT: number; AT: number }>,
  tempC: number,
  S: number,
  options: { minPH?: number; maxPH?: number; truncateOnInvalid?: boolean } = {}
): ProjectedDicPhLine {
  const segments: DicPhSegment[] = [];
  let currentSegment: DicPhPoint[] = [];
  const stats = emptyProjectionCounters();
  const flush = () => {
    if (currentSegment.length >= 2) {
      segments.push(currentSegment);
    }
    currentSegment = [];
  };

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!point) continue;
    const mapped = projectAlkDicPointWithStatus(point, tempC, S, {
      minPH: options.minPH,
      maxPH: options.maxPH,
      sourceIndex: i,
    });
    stats[mapped.status] += 1;
    if (!mapped.point) {
      const hadVisibleSegment = currentSegment.length > 0 || segments.length > 0;
      flush();
      if (options.truncateOnInvalid && hadVisibleSegment) break;
      continue;
    }
    currentSegment.push(mapped.point);
  }
  flush();
  stats.segments = segments.length;
  return { points: segments.flat(), segments, stats };
}

export function sampleAlkDicSegmentToDicPh(
  start: { CT: number; AT: number },
  end: { CT: number; AT: number },
  tempC: number,
  S: number,
  options: { steps?: number; minPH?: number; maxPH?: number } = {}
): DicPhPoint[] {
  return sampleAlkDicSegmentSegmentsToDicPh(start, end, tempC, S, options).flat();
}

export function sampleAlkDicSegmentSegmentsToDicPh(
  start: { CT: number; AT: number },
  end: { CT: number; AT: number },
  tempC: number,
  S: number,
  options: { steps?: number; minPH?: number; maxPH?: number } = {}
): DicPhSegment[] {
  const steps = options.steps ?? 32;
  const samples: Array<{ CT: number; AT: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    samples.push({
      CT: start.CT + (end.CT - start.CT) * t,
      AT: start.AT + (end.AT - start.AT) * t,
    });
  }
  return projectAlkDicLineWithStats(samples, tempC, S, {
    minPH: options.minPH,
    maxPH: options.maxPH,
  }).segments;
}

function lineFromPoints(label: string, color: string, points: DicPhPoint[], value?: number, segments?: DicPhSegment[]): DicPhLine {
  return { label, color, points, ...(segments == null ? {} : { segments }), ...(value == null ? {} : { value }) };
}

function makeHorizontalZone(
  label: string,
  color: string,
  fillColor: string,
  criticalPH: number,
  direction: 'above' | 'below',
  maxDIC: number,
  minPH: number,
  maxPH: number
): DicPhToxicZone | null {
  if (!isFinite(criticalPH)) return null;

  if (direction === 'above' && criticalPH > maxPH) return null;
  if (direction === 'below' && criticalPH < minPH) return null;

  const boundaryPH = Math.max(minPH, Math.min(maxPH, criticalPH));
  const boundary = [
    roundedPoint({ CT: 0, pH: boundaryPH }),
    roundedPoint({ CT: maxDIC, pH: boundaryPH }),
  ];

  const polygon = direction === 'above'
    ? [
        roundedPoint({ CT: 0, pH: boundaryPH }),
        roundedPoint({ CT: maxDIC, pH: boundaryPH }),
        roundedPoint({ CT: maxDIC, pH: maxPH }),
        roundedPoint({ CT: 0, pH: maxPH }),
      ]
    : [
        roundedPoint({ CT: 0, pH: minPH }),
        roundedPoint({ CT: maxDIC, pH: minPH }),
        roundedPoint({ CT: maxDIC, pH: boundaryPH }),
        roundedPoint({ CT: 0, pH: boundaryPH }),
      ];

  return { label, color, fillColor, boundary, polygons: [polygon], criticalPH };
}

function generateCO2PHToxicZone(
  tempC: number,
  S: number,
  co2CritMg: number,
  maxDIC: number,
  minPH: number,
  maxPH: number
): DicPhToxicZone | null {
  const boundarySegments: DicPhSegment[] = [];
  let currentSegment: DicPhPoint[] = [];
  const flush = () => {
    if (currentSegment.length >= 2) {
      boundarySegments.push(currentSegment);
    }
    currentSegment = [];
  };

  const step = maxDIC / 200;
  for (let ct = Math.max(step, 0.01); ct <= maxDIC + 1e-8; ct += step) {
    const pH = criticalPHforCO2AtDIC(ct, co2CritMg, tempC, S, minPH, maxPH);
    if (!isFinite(pH) || pH < minPH) {
      flush();
      continue;
    }
    const boundaryPH = Math.min(maxPH, pH);
    currentSegment.push(roundedPoint({
      CT: ct,
      pH: boundaryPH,
      AT: calcAlkOfDicPh(ct, boundaryPH, tempC, S),
    }));
  }
  flush();

  if (boundarySegments.length === 0) return null;

  const polygons = boundarySegments.map(segment => [
    ...segment.map(p => roundedPoint({ CT: p.CT, pH: minPH })),
    ...[...segment].reverse(),
  ]);

  return {
    label: `CO₂ Toxic (>${co2CritMg} mg/L)`,
    color: '#f97316',
    fillColor: 'rgba(249, 115, 22, 0.15)',
    boundary: boundarySegments.flat(),
    boundarySegments,
    polygons,
  };
}

function generateAlkalinityLines(
  tempC: number,
  S: number,
  alkalinities: Array<{ label: string; value: number; color: string }>,
  maxDIC: number,
  minPH: number,
  maxPH: number
): { lines: DicPhLine[]; stats: ProjectionCounters } {
  const stats = emptyProjectionCounters();
  const lines = alkalinities.map(({ label, value, color }) => {
    const rawPoints: Array<{ CT: number; AT: number }> = [];
    const step = maxDIC / 160;
    for (let ct = step; ct <= maxDIC + 1e-8; ct += step) {
      rawPoints.push({ CT: ct, AT: value });
    }
    const projected = projectAlkDicLineWithStats(rawPoints, tempC, S, { minPH, maxPH });
    stats.projected += projected.stats.projected;
    stats.rejected += projected.stats.rejected;
    stats.clipped += projected.stats.clipped;
    stats.segments += projected.stats.segments;
    return lineFromPoints(label, color, projected.points, value, projected.segments);
  }).filter(line => line.points.length >= 2);
  return { lines, stats };
}

function generatePHReferenceLines(maxDIC: number, minPH: number, maxPH: number): DicPhLine[] {
  const lines: DicPhLine[] = [];
  for (const pH of PH_ISOLINE_VALUES) {
    if (pH < minPH || pH > maxPH || Math.abs(pH * 2 - Math.round(pH * 2)) > 1e-8) continue;
    lines.push(lineFromPoints(`pH ${pH.toFixed(1)}`, '#94a3b8', [
      roundedPoint({ CT: 0, pH }),
      roundedPoint({ CT: maxDIC, pH }),
    ], pH));
  }
  return lines;
}

function generateSafeBands(
  tempC: number,
  S: number,
  limits: DeffeyesPHLimits,
  alkMinMeq: number,
  alkMaxMeq: number,
  maxDIC: number,
  minPH: number,
  maxPH: number
): DicPhSafeBand[] {
  const nh3Critical = criticalPHforNH3PHChartDomain(limits.tanMgL, limits.unIonizedNH3MgL, tempC, S, minPH, maxPH);
  const h2sCritical = criticalPHforH2SPHChartDomain(
    limits.h2sMeasuredUgL,
    limits.currentPH,
    limits.h2sLimitUgL,
    tempC,
    S,
    minPH,
    maxPH
  );

  const bands: DicPhPoint[][] = [];
  let lower: DicPhPoint[] = [];
  let upper: DicPhPoint[] = [];
  const step = maxDIC / 160;

  const flush = () => {
    if (lower.length >= 2 && upper.length >= 2) {
      bands.push([...lower, ...upper.reverse()]);
    }
    lower = [];
    upper = [];
  };

  for (let ct = step; ct <= maxDIC + 1e-8; ct += step) {
    const alkMinPH = solvePHForAlkDic(alkMinMeq, ct, tempC, S, minPH, maxPH);
    const alkMaxPH = solvePHForAlkDic(alkMaxMeq, ct, tempC, S, minPH, maxPH);
    const co2PH = criticalPHforCO2AtDIC(ct, limits.co2ToxicMgL, tempC, S, minPH, maxPH);

    if (!isFinite(alkMinPH) || !isFinite(alkMaxPH)) {
      flush();
      continue;
    }

    const lowerPH = Math.max(
      minPH,
      alkMinPH,
      isFinite(co2PH) ? co2PH : minPH,
      isFinite(h2sCritical) ? h2sCritical : minPH
    );
    const upperPH = Math.min(maxPH, alkMaxPH, isFinite(nh3Critical) ? nh3Critical : maxPH);

    if (!isFinite(lowerPH) || !isFinite(upperPH) || lowerPH > upperPH) {
      flush();
      continue;
    }

    lower.push(roundedPoint({ CT: ct, pH: lowerPH, AT: calcAlkOfDicPh(ct, lowerPH, tempC, S) }));
    upper.push(roundedPoint({ CT: ct, pH: upperPH, AT: calcAlkOfDicPh(ct, upperPH, tempC, S) }));
  }
  flush();

  return bands.length > 0 ? [{ label: 'Safe Zone', color: '#22c55e', polygons: bands }] : [];
}

export function generateDeffeyesPHChartData(
  params: WaterParams,
  target: TargetParams | null,
  limits: DeffeyesPHLimits,
  alkMinMeq: number,
  alkMaxMeq: number,
  caMgL = 0,
  showTarget = true
): DeffeyesPHChartData {
  const { tempC, pH, salinity, alkalinity } = params;
  const maxDIC = 8;
  const minPH = PH_CHART_MIN;
  const maxPH = PH_CHART_MAX;

  const legacyData = generateDeffeyesChartData(
    params,
    target,
    {
      tan: limits.tanMgL,
      unIonizedNH3: limits.unIonizedNH3MgL,
      co2Toxic: limits.co2ToxicMgL,
      h2s: 0,
    },
    alkMinMeq,
    alkMaxMeq,
    caMgL,
    showTarget
  );

  const currentPoint = roundedPoint({
    CT: legacyData.currentPoint.DIC,
    pH,
    AT: legacyData.currentPoint.ALK,
  });

  const targetPoint = legacyData.targetPoint && target && showTarget
    ? roundedPoint({ CT: legacyData.targetPoint.DIC, pH: target.targetpH, AT: legacyData.targetPoint.ALK })
    : null;
  const targetPathProjection: ProjectedDicPhLine = legacyData.targetPoint && targetPoint
    ? projectAlkDicLineWithStats(
        Array.from({ length: 49 }, (_, i) => {
          const t = i / 48;
          return {
            CT: legacyData.currentPoint.DIC + (legacyData.targetPoint!.DIC - legacyData.currentPoint.DIC) * t,
            AT: legacyData.currentPoint.ALK + (legacyData.targetPoint!.ALK - legacyData.currentPoint.ALK) * t,
          };
        }),
        tempC,
        salinity,
        { minPH, maxPH }
      )
    : { points: [], segments: [], stats: emptyProjectionCounters() };
  const targetPath = targetPathProjection.points;
  const targetPathSegments = targetPathProjection.segments;

  const h2sCritical = criticalPHforH2SPHChartDomain(
    limits.h2sMeasuredUgL,
    limits.currentPH,
    limits.h2sLimitUgL,
    tempC,
    salinity,
    minPH,
    maxPH
  );

  const alkalinityValues = [
    { label: `Alk min ${alkMinMeq.toFixed(2)} meq/L`, value: alkMinMeq, color: '#16a34a' },
    { label: `Current Alk ${alkalinity.toFixed(2)} meq/L`, value: alkalinity, color: '#2563eb' },
    { label: `Alk max ${alkMaxMeq.toFixed(2)} meq/L`, value: alkMaxMeq, color: '#16a34a' },
    ...(target && showTarget ? [{ label: `Target Alk ${target.targetAlkalinity.toFixed(2)} meq/L`, value: target.targetAlkalinity, color: '#111827' }] : []),
  ];

  const omegaCalciteProjection: ProjectedDicPhLine = legacyData.omegaCalcite
    ? projectAlkDicLineWithStats(legacyData.omegaCalcite.points, tempC, salinity, { minPH, maxPH })
    : { points: [], segments: [], stats: emptyProjectionCounters() };
  const omegaAragoniteProjection: ProjectedDicPhLine = legacyData.omegaAragonite
    ? projectAlkDicLineWithStats(legacyData.omegaAragonite.points, tempC, salinity, { minPH, maxPH })
    : { points: [], segments: [], stats: emptyProjectionCounters() };
  const omegaCalcitePoints = omegaCalciteProjection.points;
  const omegaAragonitePoints = omegaAragoniteProjection.points;

  const nh3Critical = criticalPHforNH3PHChartDomain(limits.tanMgL, limits.unIonizedNH3MgL, tempC, salinity, minPH, maxPH);
  const nh3ToxicZone = makeHorizontalZone(
    isFinite(nh3Critical) ? `NH₃ Toxic (pH > ${nh3Critical.toFixed(2)})` : 'NH₃ Toxic',
    '#ef4444',
    'rgba(239, 68, 68, 0.18)',
    nh3Critical,
    'above',
    maxDIC,
    minPH,
    maxPH
  );

  const h2sToxicZone = makeHorizontalZone(
    isFinite(h2sCritical) ? `H₂S Toxic (pH < ${h2sCritical.toFixed(2)})` : 'H₂S Toxic',
    '#b91c1c',
    'rgba(185, 28, 28, 0.16)',
    h2sCritical,
    'below',
    maxDIC,
    minPH,
    maxPH
  );

  const co2ToxicZone = generateCO2PHToxicZone(
    tempC,
    salinity,
    limits.co2ToxicMgL,
    maxDIC,
    minPH,
    maxPH
  );

  const pHReferences = generatePHReferenceLines(maxDIC, minPH, maxPH);
  const alkalinityProjection = generateAlkalinityLines(tempC, salinity, alkalinityValues, maxDIC, minPH, maxPH);
  const alkalinityLines = alkalinityProjection.lines;
  const safeBands = generateSafeBands(tempC, salinity, limits, alkMinMeq, alkMaxMeq, maxDIC, minPH, maxPH);

  const omegaCalciteStats = omegaCalciteProjection.stats;
  const omegaAragoniteStats = omegaAragoniteProjection.stats;
  const layers: Record<string, ProjectionLayerStats> = {
    alkalinity: alkalinityProjection.stats,
    omegaCalcite: omegaCalciteStats,
    omegaAragonite: omegaAragoniteStats,
    targetPath: targetPathProjection.stats,
    pHReferences: {
      projected: pHReferences.reduce((sum, line) => sum + line.points.length, 0),
      rejected: 0,
      clipped: 0,
      segments: pHReferences.length,
    },
    safeBands: segmentLayerStats(safeBands.flatMap(band => band.polygons)),
    co2Toxic: segmentLayerStats(co2ToxicZone?.polygons ?? []),
    h2sToxic: segmentLayerStats(h2sToxicZone?.polygons ?? []),
    nh3Toxic: segmentLayerStats(nh3ToxicZone?.polygons ?? []),
  };
  const aggregateProjectionStats = mergeProjectionCounters([
    alkalinityProjection.stats,
    omegaCalciteStats,
    omegaAragoniteStats,
    targetPathProjection.stats,
  ]);

  const stats: ProjectionStats = {
    ...aggregateProjectionStats,
    toxicSegments: (nh3ToxicZone?.polygons.length ?? 0) + (co2ToxicZone?.polygons.length ?? 0) + (h2sToxicZone?.polygons.length ?? 0),
    layers,
  };

  return {
    domain: { maxDIC, minPH, maxPH },
    pHReferences,
    alkalinityLines,
    nh3ToxicZone,
    co2ToxicZone,
    h2sToxicZone,
    safeBands,
    currentPoint,
    targetPoint,
    targetPath,
    targetPathSegments,
    reagentLine: null,
    dosingVisualization: null,
    omegaCalcite: omegaCalcitePoints.length >= 2 ? lineFromPoints('Ω-Calcite=1', '#2563eb', omegaCalcitePoints, undefined, omegaCalciteProjection.segments) : null,
    omegaAragonite: omegaAragonitePoints.length >= 2 ? lineFromPoints('Ω-Aragonite=1', '#d946ef', omegaAragonitePoints, undefined, omegaAragoniteProjection.segments) : null,
    projectionStats: stats,
  };
}
