/**
 * Water Quality Engine - Core Thermodynamic Calculations
 * Ported from Python wq class (v1.py)
 *
 * Implements Millero equations for carbonate chemistry,
 * pH scale conversions (Free/SWS/NBS/Total),
 * ionic strength corrections, and borate/sulfate/fluoride contributions.
 */

import { DEFFEYES_SOLVER_PH_DOMAIN } from './domains.js';
import { tempCToK } from './types.js';

// ============================================================================
// SEAWATER COMPOSITION CONSTANTS
// ============================================================================

/** Total boron concentration in mol/kg-SW from salinity (Uppstrom 1974) */
export function totalBoron(S: number): number {
  return 0.000232 * (S / 1.80655) / 10.811;
}

/** Total sulfate concentration in mol/kg-SW from salinity (Morris & Riley 1966) */
export function totalSulfate(S: number): number {
  return (0.1400 / 96.062) * (S / 1.80655);
}

/** Total fluoride concentration in mol/kg-SW from salinity (Riley 1965) */
export function totalFluoride(S: number): number {
  return (0.000067 / 18.998) * (S / 1.80655);
}

// ============================================================================
// THERMODYNAMIC DISSOCIATION CONSTANTS (on appropriate pH scales)
// ============================================================================

/**
 * K1 - First dissociation constant of carbonic acid (Millero 2010, SWS scale)
 * H2CO3 ⇌ H+ + HCO3-
 * Valid for S=0-50, T=0-50°C (estuarine waters — full freshwater→seawater range)
 * Returns K1 in mol/kg-SW
 *
 * WHY this exact fit: the pure-water term (-126.34048 + 6320.813/T +
 * 19.568224·lnT) reproduces the thermodynamic freshwater constant
 * (pK1(25°C,S=0) ≈ 6.355), and the √S salinity terms carry the fit smoothly
 * down to S=0. The previous linear-in-S ("Millero 2010 Table 2") coefficients
 * were a SEAWATER-ONLY fit: accurate at S≈35 but ~0.23 pK low at S=0, which
 * shifted every Deffeyes isoline / DIC / CO₂ readout in fresh & brackish water.
 * The √S terms are load-bearing — do not drop them.
 */
export function getK1(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const lnT = Math.log(T);
  const sqrtS = Math.sqrt(S);

  // Millero (2010) estuarine fit — pK1 on SWS scale
  const pK1 =
    -126.34048 +
    6320.813 / T +
    19.568224 * lnT +
    (13.4191 * sqrtS + 0.0331 * S - 0.0000533 * S * S) +
    (-530.123 * sqrtS - 6.103 * S) / T +
    -2.06950 * sqrtS * lnT;

  return Math.pow(10, -pK1);
}

/**
 * K2 - Second dissociation constant of carbonic acid (Millero 2010, SWS scale)
 * HCO3- ⇌ H+ + CO3²-
 * Valid for S=0-50, T=0-50°C (estuarine waters — full freshwater→seawater range)
 * Returns K2 in mol/kg-SW
 *
 * WHY this exact fit: reproduces the thermodynamic freshwater constant
 * (pK2(25°C,S=0) ≈ 10.329). The previous linear-in-S fit was ~0.9 pK LOW at
 * S=0 — i.e. K2 ~8× too high — which grossly distorted CO₃²⁻/alkalinity
 * speciation (α₂, isoline slope, Ω isopleths) in fresh & brackish water. The
 * √S terms are load-bearing — do not drop them.
 */
export function getK2(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const lnT = Math.log(T);
  const sqrtS = Math.sqrt(S);

  // Millero (2010) estuarine fit — pK2 on SWS scale
  const pK2 =
    -90.18333 +
    5143.692 / T +
    14.613358 * lnT +
    (21.0894 * sqrtS + 0.1248 * S - 0.0003687 * S * S) +
    (-772.483 * sqrtS - 20.051 * S) / T +
    -3.3336 * sqrtS * lnT;

  return Math.pow(10, -pK2);
}

/**
 * Kw - Ion product of water (Millero 1995 in Dickson & Goyet 1994, ch.5 p.18)
 * H2O ⇌ H+ + OH-
 * pH scale: Total, returned as-is (convert to Free at point of use)
 */
export function calcKw(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const lnT = Math.log(T);
  const S2 = Math.sqrt(S);

  const lnKw =
    148.9652 -
    13847.26 / T -
    23.6521 * lnT +
    (-5.977 + 118.67 / T + 1.0495 * lnT) * S2 -
    0.01615 * S;

  return Math.exp(lnKw);  // Total scale
}

/**
 * KB - Borate equilibrium constant (Dickson 1990, Total scale)
 * B(OH)3 + H2O ⇌ B(OH)4- + H+
 */
export function calcKB(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const S2 = Math.sqrt(S);

  const lnKB =
    (-8966.90 - 2890.53 * S2 - 77.942 * S + 1.728 * S * S2 - 0.0996 * S * S) / T +
    (148.0248 + 137.1942 * S2 + 1.62142 * S) +
    (-24.4344 - 25.085 * S2 - 0.2474 * S) * Math.log(T) +
    0.053105 * S2 * T;

  return Math.exp(lnKB);
}

/**
 * KS - Bisulfate dissociation constant (Dickson 1990, Free scale)
 * HSO4- ⇌ H+ + SO4²-
 */
export function calcKS(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const I = calcIonicStrength(S);
  const I2 = Math.sqrt(I);

  const lnKS =
    -4276.1 / T +
    141.328 -
    23.093 * Math.log(T) +
    (-13856.0 / T + 324.57 - 47.986 * Math.log(T)) * I2 +
    (35474.0 / T - 771.54 + 114.723 * Math.log(T)) * I +
    (-2698.0 / T) * I * I2 +
    (1776.0 / T) * I * I +
    Math.log(1 - 0.001005 * S);

  return Math.exp(lnKS);
}

/**
 * KF - Hydrogen fluoride dissociation constant (Dickson & Riley 1979, Total scale)
 * HF ⇌ H+ + F-
 */
export function calcKF(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const I = calcIonicStrength(S);
  const I2 = Math.sqrt(I);

  const lnKF = 1590.2 / T - 12.641 + 1.525 * I2 + Math.log(1 - 0.001005 * S);
  return Math.exp(lnKF);
}

/**
 * KNH4 - Ammonium dissociation constant (Millero 1995, SWS scale)
 * NH4+ ⇌ NH3 + H+
 */
export function getKNH4(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const S2 = Math.sqrt(S);

  const lnKNH4 =
    -6285.33 / T +
    0.0001635 * T -
    0.25444 +
    (0.46532 - 123.7184 / T) * S2 +
    (-0.01992 + 3.17556 / T) * S;

  return Math.exp(lnKNH4);
}

/**
 * KH2S - Hydrogen sulfide dissociation constant (Millero 1995, Total scale)
 * H2S ⇌ HS- + H+
 */
export function getKH2S(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const S2 = Math.sqrt(S);

  const lnKH2S =
    225.838 -
    13275.3 / T -
    34.6435 * Math.log(T) +
    0.3449 * S2 -
    0.0274 * S;

  return Math.exp(lnKH2S);
}

// ============================================================================
// IONIC STRENGTH
// ============================================================================

/** Ionic strength from salinity (Millero 1982) */
export function calcIonicStrength(S: number): number {
  return (
    19.924 * S / (1000 - 1.005 * S)
  );
}

// ============================================================================
// pH SCALE CONVERSIONS
// ============================================================================

/**
 * Molal to molin (mol/kg-soln) conversion factor
 * Matches R CarbCalc ahMolalToMolinforSalinity()
 */
export function molalToMolin(S: number): number {
  return 1.0 - 0.001005 * S;
}

/**
 * SWS-to-NBS conversion factor
 * ahSwsToNbs = activityCoeff / molalToMolin
 * Matches R CarbCalc ahSwsToNbsFactor()
 */
export function ahSwsToNbsFactor(tempC: number, S: number): number {
  return calcActivityCoefficientH(tempC, S) / molalToMolin(S);
}

/**
 * Convert pH from NBS scale to Free scale
 * pHfree = pHnbs + log10(ahSwsToNbs) + log10(ahFreeToSws)
 * Matches R CarbCalc phNbsToPhFree()
 */
export function phNbsToFree(pHnbs: number, tempC: number, S: number): number {
  return (
    pHnbs +
    Math.log10(ahSwsToNbsFactor(tempC, S)) +
    Math.log10(ahFreeToSwsFactor(tempC, S))
  );
}

/**
 * Convert pH from Free scale to NBS scale
 */
export function phFreeToNbs(pHfree: number, tempC: number, S: number): number {
  return (
    pHfree -
    Math.log10(ahSwsToNbsFactor(tempC, S)) -
    Math.log10(ahFreeToSwsFactor(tempC, S))
  );
}

/**
 * Activity coefficient for H+ (Zeebe & Wolf-Gladrow formulation)
 * Temperature-dependent Debye-Huckel A parameter
 * Used in NBS to SWS/Free conversion
 * Matches R CarbCalc calcProtonActivityCoeffZg()
 */
export function calcActivityCoefficientH(tempC: number, S: number): number {
  if (S <= 0) return 1.0;
  const T = tempCToK(tempC);
  const I = calcIonicStrength(S);
  const rootI = Math.sqrt(I);

  // Debye-Huckel A parameter: A = 1820000 * (epsilon * T)^(-3/2)
  // where epsilon ≈ 79 for water (dielectric constant approximation)
  const A = 1820000.0 * Math.pow(79 * T, -1.5);

  const logfH = A * ((rootI / (1 + rootI)) - 0.2 * I);
  return Math.pow(10, -logfH);
}

/**
 * Factor to convert [H+]free to [H+]SWS
 * [H+]SWS = [H+]free * (1 + ST/KS + FT/KF)
 */
export function ahFreeToSwsFactor(tempC: number, S: number): number {
  if (S <= 0) return 1.0;
  const ST = totalSulfate(S);
  const FT = totalFluoride(S);
  const KS = calcKS(tempC, S);
  const KF = calcKF(tempC, S);
  return 1 + ST / KS + FT / KF;
}

/**
 * Factor to convert [H+]free to [H+]Total
 * [H+]Total = [H+]free * (1 + ST/KS)
 */
export function ahFreeToTotFactor(tempC: number, S: number): number {
  if (S <= 0) return 1.0;
  const ST = totalSulfate(S);
  const KS = calcKS(tempC, S);
  return 1 + ST / KS;
}

/**
 * Convert SWS-scale constant to Free-scale
 */
export function swsToFree(K_sws: number, tempC: number, S: number): number {
  return K_sws / ahFreeToSwsFactor(tempC, S);
}

/**
 * Convert Total-scale constant to Free-scale
 * K_free = K_total / ahFreeToTotFactor
 */
export function totToFree(K_tot: number, tempC: number, S: number): number {
  return K_tot / ahFreeToTotFactor(tempC, S);
}

// ============================================================================
// CARBONATE SYSTEM - ALPHA FRACTIONS
// All calculations on Free pH scale internally
// ============================================================================

/**
 * Alpha0 = [CO2] / DIC fraction
 */
export function alphaZero(pHfree: number, tempC: number, S: number): number {
  const H = Math.pow(10, -pHfree);
  const K1 = swsToFree(getK1(tempC, S), tempC, S);
  const K2 = swsToFree(getK2(tempC, S), tempC, S);
  return H * H / (H * H + H * K1 + K1 * K2);
}

/**
 * Alpha1 = [HCO3-] / DIC fraction
 */
export function alphaOne(pHfree: number, tempC: number, S: number): number {
  const H = Math.pow(10, -pHfree);
  const K1 = swsToFree(getK1(tempC, S), tempC, S);
  const K2 = swsToFree(getK2(tempC, S), tempC, S);
  return H * K1 / (H * H + H * K1 + K1 * K2);
}

/**
 * Alpha2 = [CO3²-] / DIC fraction
 */
export function alphaTwo(pHfree: number, tempC: number, S: number): number {
  const H = Math.pow(10, -pHfree);
  const K1 = swsToFree(getK1(tempC, S), tempC, S);
  const K2 = swsToFree(getK2(tempC, S), tempC, S);
  return K1 * K2 / (H * H + H * K1 + K1 * K2);
}

// ============================================================================
// DEFFEYES DIAGRAM FUNCTIONS
// ============================================================================

/**
 * Slope of pH isoline on Deffeyes diagram: dALK/dDIC = alpha1 + 2*alpha2
 */
export function phLineSlope(pHfree: number, tempC: number, S: number): number {
  return alphaOne(pHfree, tempC, S) + 2 * alphaTwo(pHfree, tempC, S);
}

/**
 * Y-intercept of pH isoline on Deffeyes diagram
 * = [OH-] - [H+] + [B(OH)4-]
 * All concentrations in mol/kg, result in meq/L (*1000)
 * Matches R CarbCalc phLineIntercept()
 *
 * NB: Kw is on Total scale, KB is on Total scale → both use totToFree
 */
export function phLineIntercept(pHfree: number, tempC: number, S: number): number {
  const H = Math.pow(10, -pHfree);
  const Kw = totToFree(calcKw(tempC, S), tempC, S);
  const OH = Kw / H;

  let borate = 0;
  if (S > 0) {
    const BT = totalBoron(S);
    const KB = totToFree(calcKB(tempC, S), tempC, S);
    borate = BT * KB / (KB + H);
  }

  // Return in meq/L (multiply mol/kg by 1000)
  return (OH - H + borate) * 1000;
}

// ============================================================================
// DIC / ALK / CO2 INTERCONVERSIONS
// ============================================================================

/**
 * Calculate DIC from alkalinity and pH
 * DIC = (ALK - intercept) / slope
 * ALK in meq/L, returns DIC in mmol/L
 */
export function calcDicOfAlk(alkMeq: number, pHnbs: number, tempC: number, S: number): number {
  const pHfree = phNbsToFree(pHnbs, tempC, S);
  const slope = phLineSlope(pHfree, tempC, S);
  const intercept = phLineIntercept(pHfree, tempC, S);
  if (slope === 0) return 0;
  return (alkMeq - intercept) / slope;
}

/**
 * Calculate CO2 from DIC and pH
 * CO2 = DIC * alpha0
 * DIC in mmol/L, returns CO2 in mmol/L
 */
export function calcCo2OfDic(dicMM: number, pHnbs: number, tempC: number, S: number): number {
  const pHfree = phNbsToFree(pHnbs, tempC, S);
  return dicMM * alphaZero(pHfree, tempC, S);
}

/**
 * Convert CO2 from mmol/L to mg/L
 * MW of CO2 = 44.0096 g/mol (matches R CarbCalc)
 */
export function co2MmToMg(co2Mm: number): number {
  return co2Mm * 44.0096;
}

/**
 * Convert CO2 from mg/L to mmol/L
 */
export function co2MgToMm(co2Mg: number): number {
  return co2Mg / 44.0096;
}

/**
 * Calculate alkalinity from DIC and pH
 * ALK = DIC * slope + intercept
 * DIC in mmol/L, returns ALK in meq/L
 */
export function calcAlkOfDicPh(dicMM: number, pHnbs: number, tempC: number, S: number): number {
  const pHfree = phNbsToFree(pHnbs, tempC, S);
  const slope = phLineSlope(pHfree, tempC, S);
  const intercept = phLineIntercept(pHfree, tempC, S);
  return dicMM * slope + intercept;
}

/**
 * Find pH for a critical CO2 level given DIC
 * Uses bisection method to find pH where CO2(DIC, pH) = co2CritMg
 * Returns pH on NBS scale
 */
export function calcPhForCritCO2(
  dicMM: number,
  co2CritMg: number,
  tempC: number,
  S: number,
  minPH = DEFFEYES_SOLVER_PH_DOMAIN.minPH,
  maxPH = DEFFEYES_SOLVER_PH_DOMAIN.maxPH
): number {
  const co2CritMM = co2MgToMm(co2CritMg);
  if (dicMM <= 0 || co2CritMM <= 0) return NaN;
  if (!isFinite(minPH) || !isFinite(maxPH) || minPH >= maxPH) return NaN;
  // CO2 = DIC * alpha0 → alpha0 = co2Crit / DIC
  const targetAlpha0 = co2CritMM / dicMM;
  if (targetAlpha0 >= 1) return minPH;
  if (targetAlpha0 <= 0) return maxPH;

  // Bisection on NBS pH
  let lo = minPH;
  let hi = maxPH;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const pHfree = phNbsToFree(mid, tempC, S);
    const a0 = alphaZero(pHfree, tempC, S);
    if (a0 > targetAlpha0) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-8) break;
  }
  return (lo + hi) / 2;
}

/**
 * Find pH (NBS) given alkalinity (meq/L) and DIC (mmol/L)
 * Uses bisection method
 */
export function calcPhForAlkDic(
  alkMeq: number,
  dicMM: number,
  tempC: number,
  S: number,
  minPH = DEFFEYES_SOLVER_PH_DOMAIN.minPH,
  maxPH = DEFFEYES_SOLVER_PH_DOMAIN.maxPH
): number {
  if (!isFinite(alkMeq) || !isFinite(dicMM) || dicMM <= 0) return NaN;
  if (!isFinite(minPH) || !isFinite(maxPH) || minPH >= maxPH) return NaN;

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
  return (lo + hi) / 2;
}

// ============================================================================
// SEAWATER DENSITY
// ============================================================================

/**
 * Fresh water density (kg/m3) - UNESCO 1983
 */
export function calcRhoFW(tempC: number): number {
  const t = tempC;
  return (
    999.842594 +
    6.793952e-2 * t -
    9.09529e-3 * t * t +
    1.001685e-4 * t * t * t -
    1.120083e-6 * t * t * t * t +
    6.536336e-9 * t * t * t * t * t
  );
}

// ============================================================================
// CALCITE & ARAGONITE SOLUBILITY PRODUCTS (Mucci 1983)
// ============================================================================

/**
 * Ksp for Calcite - Mucci (1983)
 * Temperature and salinity dependent
 * concentration scale: mol²/kg-soln²
 * @param tempC - Temperature in Celsius (converted to Kelvin internally)
 * @param S - Salinity in ppt
 */
export function calcKspCalcite(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const sqrtS = Math.sqrt(S);

  let logKsp = -171.9065;
  logKsp += -0.77712 * sqrtS;
  logKsp += -0.07711 * S;
  logKsp += 0.0041249 * S * sqrtS;
  logKsp += (2839.319 + 178.34 * sqrtS) / T;
  logKsp += 71.595 * Math.log10(T);
  logKsp += (-0.077993 + 0.0028426 * sqrtS) * T;

  return Math.pow(10, logKsp);
}

/**
 * Ksp for Aragonite - Mucci (1983)
 * Temperature and salinity dependent
 * concentration scale: mol²/kg-soln²
 * @param tempC - Temperature in Celsius (converted to Kelvin internally)
 * @param S - Salinity in ppt
 */
export function calcKspAragonite(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const sqrtS = Math.sqrt(S);

  let logKsp = -171.945;
  logKsp += -0.068393 * sqrtS;
  logKsp += -0.10018 * S;
  logKsp += 0.0059415 * S * sqrtS;
  logKsp += (2903.293 + 88.135 * sqrtS) / T;
  logKsp += 71.595 * Math.log10(T);
  logKsp += (-0.077993 + 0.0017276 * sqrtS) * T;

  return Math.pow(10, logKsp);
}

/**
 * Calculate CO3²⁻ concentration from DIC and pH
 * @param dicMM - DIC in mmol/L
 * @param pHnbs - pH on NBS scale
 * @returns CO3²⁻ in mmol/L
 */
export function calcCO3(dicMM: number, pHnbs: number, tempC: number, S: number): number {
  const pHfree = phNbsToFree(pHnbs, tempC, S);
  return dicMM * alphaTwo(pHfree, tempC, S);
}

/**
 * Calculate Omega for Calcite: Ω = [Ca²⁺] × [CO₃²⁻] / Ksp
 * @param dicMM - DIC in mmol/L
 * @param caMolKg - Ca²⁺ in mol/kg-soln
 * @param pHnbs - pH on NBS scale
 */
export function calcOmegaCalcite(dicMM: number, caMolKg: number, pHnbs: number, tempC: number, S: number): number {
  const co3MolKg = calcCO3(dicMM, pHnbs, tempC, S) * 1e-3; // mmol/L → mol/kg approx
  return (caMolKg * co3MolKg) / calcKspCalcite(tempC, S);
}

/**
 * Calculate Omega for Aragonite: Ω = [Ca²⁺] × [CO₃²⁻] / Ksp
 */
export function calcOmegaAragonite(dicMM: number, caMolKg: number, pHnbs: number, tempC: number, S: number): number {
  const co3MolKg = calcCO3(dicMM, pHnbs, tempC, S) * 1e-3;
  return (caMolKg * co3MolKg) / calcKspAragonite(tempC, S);
}

// ============================================================================
// SEAWATER DENSITY
// ============================================================================

/**
 * Seawater density (kg/m3) - UNESCO 1983
 */
export function calcRhoSW(tempC: number, S: number): number {
  const t = tempC;
  const rhoFW = calcRhoFW(t);
  const A =
    8.24493e-1 -
    4.0899e-3 * t +
    7.6438e-5 * t * t -
    8.2467e-7 * t * t * t +
    5.3875e-9 * t * t * t * t;
  const B = -5.72466e-3 + 1.0227e-4 * t - 1.6546e-6 * t * t;
  const C = 4.8314e-4;
  return rhoFW + A * S + B * S * Math.sqrt(S) + C * S * S;
}
