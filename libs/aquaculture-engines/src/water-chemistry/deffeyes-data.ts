/**
 * Deffeyes Diagram Data Generator
 * Ported from Python PlotCanvas.tanolustur()
 *
 * Generates all data needed for the Deffeyes (Alkalinity vs DIC) diagram:
 * - pH isolines derived from the chart pH domain
 * - NH3 toxic zone
 * - CO2 toxic zone
 * - Safe operating zone (green)
 * - Current and target operating points
 */

import { calcTotalSulfide, criticalPHforH2S, fractionH2S, fractionNH3, criticalPHforNH3 } from './ammonia-calc.js';
import { criticalPHforCO2 } from './co2-calc.js';
import {
  DEFFEYES_CHART_MAX_DIC,
  DEFFEYES_CHART_PH_DOMAIN,
  DEFFEYES_LEGACY_PH_DOMAIN,
} from './domains.js';
import {
  PHIsoline,
  ToxicZone,
  SafeZone,
  OperatingPoint,
  OmegaIsopleth,
  DeffeyesChartData,
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

function rangeValues(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end + 1e-8; value += step) {
    values.push(parseFloat(value.toFixed(2)));
  }
  return values;
}

/** pH values for isolines, derived from the chart domain and kept off the min edge. */
const PH_ISOLINE_VALUES = rangeValues(
  DEFFEYES_CHART_PH_DOMAIN.minPH + 0.25,
  DEFFEYES_CHART_PH_DOMAIN.maxPH,
  0.25
);

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
  co2CritMg: number,
  maxDIC = 6
): ToxicZone | null {
  // For each DIC, find the pH where CO2 = co2Crit, then get ALK at that pH
  // Scan a wider CT range (up to maxDIC*3) to ensure curve crosses both AT=0 and AT=maxALK
  const scanMax = maxDIC * 3;
  const boundaryPoints: Array<{ CT: number; AT: number }> = [];

  for (let ct = 0.01; ct <= scanMax; ct += scanMax / 200) {
    const critPH = criticalPHforCO2AtDIC(ct, co2CritMg, tempC, S);
    if (critPH >= DEFFEYES_LEGACY_PH_DOMAIN.minPH && critPH <= DEFFEYES_LEGACY_PH_DOMAIN.maxPH) {
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
 * Generate H₂S toxic zone boundary on the Deffeyes (ALK vs DIC) diagram.
 *
 * WHY: Un-ionized H₂S rises as pH falls, so H₂S becomes toxic BELOW a critical
 * pH (the opposite end of the scale from NH₃, and the same low-pH side as CO₂).
 * On a Deffeyes diagram a constant pH is an isoline, so the toxic boundary is
 * the pH isoline at the H₂S critical pH and the danger region is everything
 * below it (lower ALK at a given DIC). This mirrors `generateCO2ToxicZone`; the
 * component fills it downward to the X-axis with `baseValue={0}`.
 *
 * WHAT: Returns the boundary points tracing the critical-pH isoline, or null
 * when H₂S can never reach the limit within the chart's pH domain (whole chart
 * safe) or inputs are non-physical.
 *
 * @param h2sMeasured   Measured H₂S in µg/L
 * @param h2sMeasuredAtPH pH (NBS) at which h2sMeasured was sampled
 * @param h2sLimit      Toxic H₂S limit in µg/L
 */
export function generateH2SToxicZone(
  tempC: number,
  S: number,
  h2sMeasured: number,
  h2sMeasuredAtPH: number,
  h2sLimit: number,
  maxDIC = 6
): ToxicZone | null {
  const critPH = criticalPHforH2S(h2sMeasured, h2sMeasuredAtPH, h2sLimit, tempC, S);
  if (!isFinite(critPH)) return null;
  // critPH below the chart floor → no visible danger band (chart fully safe).
  if (critPH < DEFFEYES_LEGACY_PH_DOMAIN.minPH) return null;
  // Clamp the drawn boundary to the chart ceiling so a very-high critical pH
  // (chart effectively all-toxic) still renders a boundary at the top edge.
  const boundaryPH = Math.min(DEFFEYES_LEGACY_PH_DOMAIN.maxPH, critPH);

  const scanMax = maxDIC * 3;
  const boundaryPoints: Array<{ CT: number; AT: number }> = [];
  for (let ct = 0.01; ct <= scanMax; ct += scanMax / 200) {
    const at = calcAlkOfDicPh(ct, boundaryPH, tempC, S);
    if (isFinite(at)) {
      boundaryPoints.push({ CT: parseFloat(ct.toFixed(4)), AT: parseFloat(at.toFixed(4)) });
    }
  }

  if (boundaryPoints.length < 2) return null;

  return {
    label: `H₂S Toxic (pH < ${critPH.toFixed(2)})`,
    color: 'rgba(185, 28, 28, 0.15)',
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
  minPH = DEFFEYES_LEGACY_PH_DOMAIN.minPH,
  maxPH = DEFFEYES_LEGACY_PH_DOMAIN.maxPH
): number {
  const co2CritMM = co2CritMg / 44.010;
  if (dicMM <= 0 || co2CritMM >= dicMM) return NaN;

  const co2AtMinPH = calcCo2OfDic(dicMM, minPH, tempC, S);
  const co2AtMaxPH = calcCo2OfDic(dicMM, maxPH, tempC, S);
  if (!isFinite(co2AtMinPH) || !isFinite(co2AtMaxPH)) return NaN;
  if (co2AtMinPH <= co2CritMM) return NaN;
  if (co2AtMaxPH > co2CritMM) return maxPH;

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
  maxDIC = DEFFEYES_CHART_MAX_DIC,
  minPH = DEFFEYES_CHART_PH_DOMAIN.minPH,
  maxPH = DEFFEYES_CHART_PH_DOMAIN.maxPH
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
    let lo = minPH;
    let hi = maxPH;
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
  maxDIC = DEFFEYES_CHART_MAX_DIC
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
  maxDIC = DEFFEYES_CHART_MAX_DIC
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
  const maxDIC = DEFFEYES_CHART_MAX_DIC;

  // pH isolines
  const isolines = generatePHIsolines(tempC, salinity, maxDIC);

  // Toxic zones
  const nh3ToxicZone = generateNH3ToxicZone(
    tempC, salinity, limits.tan, limits.unIonizedNH3, maxDIC
  );
  const co2ToxicZone = generateCO2ToxicZone(
    tempC, salinity, limits.co2Toxic, maxDIC
  );
  const h2sToxicZone = generateH2SToxicZone(
    tempC, salinity, limits.h2sMeasuredUgL, limits.h2sMeasuredAtPH, limits.h2sLimitUgL, maxDIC
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
    h2sToxicZone,
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
// PH-DOMAIN CRITICAL-PH HELPERS
//
// Consumed by the water-chemistry status panel (UIA / H₂S status readouts).
// The former DIC/pH Deffeyes chart and its projection machinery were removed
// (single ALK/DIC Deffeyes chart only); just these two pure critical-pH
// solvers remain because the status panel still needs them.
// ============================================================================

const PH_CHART_MIN = DEFFEYES_CHART_PH_DOMAIN.minPH;
const PH_CHART_MAX = DEFFEYES_CHART_PH_DOMAIN.maxPH;

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
  h2sMeasuredAtPH: number,
  h2sLimit: number,
  tempC: number,
  S: number,
  minPH = PH_CHART_MIN,
  maxPH = PH_CHART_MAX
): number {
  if (h2sMeasured <= 0 || h2sLimit <= 0) return NaN;
  if (!isFinite(minPH) || !isFinite(maxPH) || minPH >= maxPH) return NaN;

  const totalSulfide = calcTotalSulfide(h2sMeasured, h2sMeasuredAtPH, tempC, S);
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
