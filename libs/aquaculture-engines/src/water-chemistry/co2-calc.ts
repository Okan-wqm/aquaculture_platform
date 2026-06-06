/**
 * CO2 Calculator - Ported from Python Co2 class
 *
 * Calculates CO2 levels, toxic boundaries, and carbonate equilibrium
 * using Millero thermodynamic constants.
 */

import {
  alphaZero,
  alphaOne,
  alphaTwo,
  phNbsToFree,
  calcDicOfAlk,
  calcCo2OfDic,
  co2MmToMg,
  calcKspCalcite,
  calcKspAragonite,
} from './water-quality.js';
import { DEFFEYES_LEGACY_PH_DOMAIN } from './domains.js';

/**
 * Calculate CO2 level (mg/L) from alkalinity and pH
 */
export function co2Level(
  alkMeq: number,
  pHnbs: number,
  tempC: number,
  S: number
): number {
  const dic = calcDicOfAlk(alkMeq, pHnbs, tempC, S);
  const co2mm = calcCo2OfDic(dic, pHnbs, tempC, S);
  return co2MmToMg(co2mm);
}

/**
 * Find pH (NBS) where CO2 reaches the toxic level for a given alkalinity
 * Traces along the constant-alkalinity line on the Deffeyes diagram
 *
 * @param alkMeq - Alkalinity in meq/L
 * @param co2CritMg - Critical CO2 in mg/L
 * @param tempC - Temperature in Celsius
 * @param S - Salinity in ppt
 * @returns pH on NBS scale
 */
export function criticalPHforCO2(
  alkMeq: number,
  co2CritMg: number,
  tempC: number,
  S: number
): number {
  // At constant alkalinity, as pH decreases, CO2 increases
  // Find pH where CO2(alk, pH) = co2CritMg
  let lo = DEFFEYES_LEGACY_PH_DOMAIN.minPH;
  let hi = DEFFEYES_LEGACY_PH_DOMAIN.maxPH;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const co2 = co2Level(alkMeq, mid, tempC, S);
    if (co2 > co2CritMg) {
      lo = mid; // Need higher pH to reduce CO2
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-8) break;
  }
  return (lo + hi) / 2;
}

/**
 * Generate CO2/HCO3/CO3 vs pH data for charting
 * Uses Millero equations with proper salinity and temperature corrections
 */
export function generateCarbonateVsPHData(
  tempC: number,
  S: number,
  _dicMM = 2.0,
  pHmin = 6.0,
  pHmax = 9.5,
  step = 0.1
): Array<{ pH: number; CO2: number; HCO3: number; CO3: number }> {
  const data: Array<{ pH: number; CO2: number; HCO3: number; CO3: number }> = [];
  for (let pH = pHmin; pH <= pHmax + 0.001; pH += step) {
    const pHfree = phNbsToFree(pH, tempC, S);
    const a0 = alphaZero(pHfree, tempC, S);
    const a1 = alphaOne(pHfree, tempC, S);
    const a2 = alphaTwo(pHfree, tempC, S);
    data.push({
      pH: parseFloat(pH.toFixed(2)),
      CO2: parseFloat(a0.toFixed(6)),
      HCO3: parseFloat(a1.toFixed(6)),
      CO3: parseFloat(a2.toFixed(6)),
    });
  }
  return data;
}

/**
 * Generate Calcite/Aragonite saturation index vs pH
 * Uses Mucci (1983) T/S-dependent Ksp and Millero alpha fractions
 *
 * @param tempC - Temperature in Celsius
 * @param S - Salinity in ppt
 * @param dicMM - DIC in mmol/L (from current alkalinity & pH)
 * @param caMgL - Calcium concentration in mg/L
 */
export function generateSaturationVsPHData(
  tempC: number,
  S: number,
  dicMM: number,
  caMgL: number,
  pHmin = 6.0,
  pHmax = 9.5,
  step = 0.1
): Array<{ pH: number; Calcite: number; Aragonite: number }> {
  // Mucci (1983) T/S-dependent Ksp
  const KspCa = calcKspCalcite(tempC, S);
  const KspAr = calcKspAragonite(tempC, S);

  // Convert Ca from mg/L to mol/kg (approx mol/L for dilute solutions)
  // Ca atomic weight = 40.078 g/mol
  const CaMol = (caMgL / 40078); // mg/L → mol/L (divide by MW*1000)

  const data: Array<{ pH: number; Calcite: number; Aragonite: number }> = [];
  for (let pH = pHmin; pH <= pHmax + 0.001; pH += step) {
    const pHfree = phNbsToFree(pH, tempC, S);
    const a2 = alphaTwo(pHfree, tempC, S);
    const CO3mol = a2 * dicMM * 1e-3; // mmol/L → mol/L

    const IAP = CaMol * CO3mol;
    const siCalcite = IAP > 0 ? Math.log10(IAP / KspCa) : -10;
    const siAragonite = IAP > 0 ? Math.log10(IAP / KspAr) : -10;

    data.push({
      pH: parseFloat(pH.toFixed(2)),
      Calcite: parseFloat(siCalcite.toFixed(3)),
      Aragonite: parseFloat(siAragonite.toFixed(3)),
    });
  }
  return data;
}
