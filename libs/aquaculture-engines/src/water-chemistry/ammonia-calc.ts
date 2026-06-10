/**
 * Ammonia Calculator - Ported from Python Tan class
 *
 * Calculates NH3/NH4+ equilibrium, toxic NH3 levels,
 * and critical pH boundaries for given TAN concentrations.
 */

import { DEFFEYES_LEGACY_PH_DOMAIN } from './domains.js';
import { getKNH4, getKH2S, phNbsToFree, swsToFree, totToFree } from './water-quality.js';

/**
 * Calculate the fraction of un-ionized NH3 at given conditions
 * NH4+ ⇌ NH3 + H+  →  fraction_NH3 = KNH4 / (KNH4 + [H+])
 *
 * Uses Millero KNH4 (SWS scale), converts to Free scale for calculation
 */
export function fractionNH3(pHnbs: number, tempC: number, S: number): number {
  const pHfree = phNbsToFree(pHnbs, tempC, S);
  const H = Math.pow(10, -pHfree);
  const KNH4_sws = getKNH4(tempC, S);
  const KNH4_free = swsToFree(KNH4_sws, tempC, S);
  return KNH4_free / (KNH4_free + H);
}

/**
 * Calculate un-ionized NH3-N concentration (mg/L) from TAN (mg/L)
 */
export function calcNH3(tan: number, pHnbs: number, tempC: number, S: number): number {
  return tan * fractionNH3(pHnbs, tempC, S);
}

/**
 * Calculate NH4+ concentration (mg/L) from TAN (mg/L)
 */
export function calcNH4(tan: number, pHnbs: number, tempC: number, S: number): number {
  return tan * (1 - fractionNH3(pHnbs, tempC, S));
}

/**
 * Percentage of un-ionized NH3-N at given conditions
 */
export function percentNH3(pHnbs: number, tempC: number, S: number): number {
  return fractionNH3(pHnbs, tempC, S) * 100;
}

/**
 * Find the critical pH (NBS) where NH3 reaches the toxic limit
 * Uses bisection to find pH where TAN * fraction_NH3 = nh3Limit
 *
 * @param tan - Total ammonia nitrogen (mg/L)
 * @param nh3Limit - Toxic NH3-N limit (mg/L)
 * @param tempC - Temperature in Celsius
 * @param S - Salinity in ppt
 * @returns pH on NBS scale where NH3 = nh3Limit, or NaN if not reachable
 */
export function criticalPHforNH3(
  tan: number,
  nh3Limit: number,
  tempC: number,
  S: number
): number {
  if (tan <= 0 || nh3Limit <= 0 || nh3Limit >= tan) return NaN;

  // Target fraction
  const targetFraction = nh3Limit / tan;

  // Bisection on NBS pH
  let lo = DEFFEYES_LEGACY_PH_DOMAIN.minPH;
  let hi = DEFFEYES_LEGACY_PH_DOMAIN.maxPH;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const f = fractionNH3(mid, tempC, S);
    if (f < targetFraction) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-8) break;
  }
  return (lo + hi) / 2;
}

/**
 * Calculate the maximum safe TAN at given pH/T/S conditions
 * safeTAN = nh3Limit / fractionNH3  (i.e. how much TAN can you have before NH3 exceeds limit)
 */
export function calcSafeTAN(
  pHnbs: number,
  nh3Limit: number,
  tempC: number,
  S: number
): number {
  const f = fractionNH3(pHnbs, tempC, S);
  if (f <= 0) return Infinity;
  return nh3Limit / f;
}

/**
 * Determine UIA safety status based on current vs critical pH
 * Returns 'safe' (green), 'alert' (yellow within 0.2 pH of critical), or 'danger' (red)
 */
export function uiaStatus(
  currentPH: number,
  criticalPH: number
): 'safe' | 'alert' | 'danger' {
  if (isNaN(criticalPH)) return 'safe'; // no critical pH means NH3 limit can never be reached
  if (currentPH >= criticalPH) return 'danger';
  if (currentPH >= criticalPH - 0.2) return 'alert';
  return 'safe';
}

/**
 * Generate UIA percentage vs pH data for charting with zone colors
 * Returns data points and zone boundaries for green/yellow/red areas
 */
export function generateUIAvsPHData(
  tempC: number,
  S: number,
  tan: number,
  nh3Limit: number,
  pHmin = 6.0,
  pHmax = 9.5,
  step = 0.05
): Array<{ pH: number; UIA: number; limit: number }> {
  const data: Array<{ pH: number; UIA: number; limit: number }> = [];
  for (let pH = pHmin; pH <= pHmax + 0.001; pH += step) {
    const nh3 = tan * fractionNH3(pH, tempC, S);
    data.push({
      pH: parseFloat(pH.toFixed(2)),
      UIA: parseFloat(nh3.toFixed(6)),
      limit: nh3Limit,
    });
  }
  return data;
}

/**
 * Generate NH3 vs pH data for charting
 * Uses Millero equations instead of simple Henderson-Hasselbalch
 */
export function generateNH3vsPHData(
  tempC: number,
  S: number,
  tan = 1.0,
  pHmin = 6.0,
  pHmax = 9.5,
  step = 0.1
): Array<{ pH: number; NH3: number; NH4: number }> {
  const data: Array<{ pH: number; NH3: number; NH4: number }> = [];
  for (let pH = pHmin; pH <= pHmax + 0.001; pH += step) {
    const f = fractionNH3(pH, tempC, S);
    data.push({
      pH: parseFloat(pH.toFixed(2)),
      NH3: parseFloat((tan * f).toFixed(6)),
      NH4: parseFloat((tan * (1 - f)).toFixed(6)),
    });
  }
  return data;
}

/**
 * H2S dissociation - fraction of toxic H2S
 * H2S ⇌ HS- + H+
 * Uses Millero KH2S constant
 */
export function fractionH2S(pHnbs: number, tempC: number, S: number): number {
  const pHfree = phNbsToFree(pHnbs, tempC, S);
  const H = Math.pow(10, -pHfree);
  const KH2S = totToFree(getKH2S(tempC, S), tempC, S);
  return H / (KH2S + H);
}

/**
 * Calculate H₂S concentration (µg/L) from total sulfide at given pH
 * totalSulfide in µg/L, returns H₂S in µg/L
 */
export function calcH2S(totalSulfide: number, pHnbs: number, tempC: number, S: number): number {
  return totalSulfide * fractionH2S(pHnbs, tempC, S);
}

/**
 * Calculate total sulfide from measured H₂S at the measurement pH
 * h2sMeasured in µg/L → totalSulfide in µg/L
 */
export function calcTotalSulfide(h2sMeasured: number, pHnbs: number, tempC: number, S: number): number {
  const f = fractionH2S(pHnbs, tempC, S);
  if (f <= 0) return Infinity;
  return h2sMeasured / f;
}

/**
 * Find the critical pH (NBS) where H₂S reaches the toxic limit.
 * Logic: from measured H₂S at its measurement pH, compute total sulfide,
 * then find pH where totalSulfide × fractionH2S(pH) = h2sLimit.
 *
 * H₂S fraction DECREASES with rising pH (opposite of NH3).
 * So critical pH is the pH BELOW which H₂S exceeds the limit.
 *
 * @param h2sMeasured - Measured H₂S at the measurement pH (µg/L)
 * @param h2sMeasuredAtPH - pH where h2sMeasured was sampled (NBS)
 * @param h2sLimit - Toxic H₂S limit (µg/L)
 * @param tempC - Temperature in Celsius
 * @param S - Salinity in ppt
 * @returns pH on NBS scale where H₂S = h2sLimit, or NaN if not reachable
 */
export function criticalPHforH2S(
  h2sMeasured: number,
  h2sMeasuredAtPH: number,
  h2sLimit: number,
  tempC: number,
  S: number
): number {
  if (h2sMeasured <= 0 || h2sLimit <= 0) return NaN;

  // Calculate total sulfide from the measurement
  const totalSulfide = calcTotalSulfide(h2sMeasured, h2sMeasuredAtPH, tempC, S);
  if (!isFinite(totalSulfide) || totalSulfide <= 0) return NaN;

  // Target fraction: at critical pH, totalSulfide * fraction = h2sLimit
  const targetFraction = h2sLimit / totalSulfide;
  if (targetFraction >= 1) return NaN; // limit can never be reached (limit > total)

  // H₂S fraction decreases with increasing pH
  // Bisection: find pH where fractionH2S = targetFraction
  let lo = DEFFEYES_LEGACY_PH_DOMAIN.minPH;
  let hi = DEFFEYES_LEGACY_PH_DOMAIN.maxPH;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const f = fractionH2S(mid, tempC, S);
    if (f > targetFraction) {
      lo = mid; // fraction still too high, need higher pH
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-8) break;
  }
  return (lo + hi) / 2;
}

/**
 * Calculate the maximum safe total sulfide at given pH/T/S conditions
 * safeTotalSulfide = h2sLimit / fractionH2S
 */
export function calcSafeTotalSulfide(
  pHnbs: number,
  h2sLimit: number,
  tempC: number,
  S: number
): number {
  const f = fractionH2S(pHnbs, tempC, S);
  if (f <= 0) return Infinity;
  return h2sLimit / f;
}

/**
 * Determine H₂S safety status based on current vs critical pH.
 * NOTE: H₂S is toxic at LOW pH (opposite of NH3 which is toxic at HIGH pH).
 * So danger = currentPH <= criticalPH.
 */
export function h2sStatus(
  currentPH: number,
  criticalPH: number
): 'safe' | 'alert' | 'danger' {
  if (isNaN(criticalPH)) return 'safe';
  if (currentPH <= criticalPH) return 'danger';
  if (currentPH <= criticalPH + 0.2) return 'alert';
  return 'safe';
}

/**
 * Generate H₂S / HS⁻ percentage distribution vs pH data for charting.
 * Also includes a H₂S toxic limit line (as % of total sulfide).
 *
 * @param tempC - Temperature
 * @param S - Salinity
 * @param h2sMeasured - Measured H₂S at the measurement pH (µg/L)
 * @param h2sMeasuredAtPH - pH where h2sMeasured was sampled
 * @param h2sLimit - Toxic H₂S limit (µg/L)
 */
export function generateH2SvsPHData(
  tempC: number,
  S: number,
  h2sMeasured: number,
  h2sMeasuredAtPH: number,
  h2sLimit: number,
  pHmin = 5.0,
  pHmax = 9.5,
  step = 0.05
): Array<{ pH: number; H2S_pct: number; HS_pct: number; H2S_ugL: number; limit: number }> {
  const totalSulfide = calcTotalSulfide(h2sMeasured, h2sMeasuredAtPH, tempC, S);
  const data: Array<{ pH: number; H2S_pct: number; HS_pct: number; H2S_ugL: number; limit: number }> = [];
  for (let pH = pHmin; pH <= pHmax + 0.001; pH += step) {
    const f = fractionH2S(pH, tempC, S);
    data.push({
      pH: parseFloat(pH.toFixed(2)),
      H2S_pct: parseFloat((f * 100).toFixed(4)),
      HS_pct: parseFloat(((1 - f) * 100).toFixed(4)),
      H2S_ugL: parseFloat((totalSulfide * f).toFixed(4)),
      limit: h2sLimit,
    });
  }
  return data;
}
