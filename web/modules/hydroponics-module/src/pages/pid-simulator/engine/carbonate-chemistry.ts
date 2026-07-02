/**
 * Hydroponics Carbonate Chemistry Engine
 * Independent thermodynamic functions derived from water-quality.ts
 * but fully self-contained for the hydroponics module.
 *
 * Implements Millero equations for K1/K2/Kw, pH scale conversions,
 * alpha fractions, and Deffeyes diagram core calculations.
 */

// ============================================================================
// HELPERS
// ============================================================================

function tempCToK(tempC: number): number {
  return tempC + 273.15;
}

// ============================================================================
// THERMODYNAMIC DISSOCIATION CONSTANTS
// ============================================================================

/**
 * K1 - First dissociation constant of carbonic acid (Millero 2010, SWS scale)
 * H2CO3 <-> H+ + HCO3-
 *
 * Estuarine √S fit valid S=0-50 (must match @platform/aquaculture-engines
 * water-quality.ts). Hydroponics runs at S≈0, where the old linear-in-S
 * seawater fit was ~0.23 pK low — the √S terms are load-bearing.
 */
export function getK1(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const lnT = Math.log(T);
  const sqrtS = Math.sqrt(S);
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
 * HCO3- <-> H+ + CO3^2-
 *
 * Estuarine √S fit valid S=0-50 (must match @platform/aquaculture-engines
 * water-quality.ts). The old linear-in-S fit was ~0.9 pK low at S=0 (K2 ~8×
 * too high) — grossly wrong for freshwater hydroponics.
 */
export function getK2(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const lnT = Math.log(T);
  const sqrtS = Math.sqrt(S);
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
 * Kw - Ion product of water (Millero 1995, SWS scale)
 */
export function calcKw(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const lnT = Math.log(T);
  const S2 = Math.sqrt(S);
  const lnKw =
    148.9802 -
    13847.26 / T -
    23.6521 * lnT +
    (-5.977 + 118.67 / T + 1.0495 * lnT) * S2 -
    0.01615 * S;
  return Math.exp(lnKw);
}

// ============================================================================
// IONIC STRENGTH & pH SCALE CONVERSIONS
// ============================================================================

/** Ionic strength from salinity (Millero 1982) */
export function calcIonicStrength(S: number): number {
  return 19.924 * S / (1000 - 1.005 * S);
}

/** Total sulfate (Morris & Riley 1966) */
function totalSulfate(S: number): number {
  return (0.14 / 96.062) * (S / 1.80655);
}

/** Total fluoride (Riley 1965) */
function totalFluoride(S: number): number {
  return (0.000067 / 18.998) * (S / 1.80655);
}

/** Total boron (Uppstrom 1974) */
function totalBoron(S: number): number {
  return 0.000232 * (S / 1.80655) / 10.811;
}

/** KS - Bisulfate dissociation (Dickson 1990, Free scale) */
function calcKS(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const I = calcIonicStrength(S);
  const I2 = Math.sqrt(I);
  const lnKS =
    -4276.1 / T + 141.328 - 23.093 * Math.log(T) +
    (-13856.0 / T + 324.57 - 47.986 * Math.log(T)) * I2 +
    (35474.0 / T - 771.54 + 114.723 * Math.log(T)) * I +
    (-2698.0 / T) * I * I2 +
    (1776.0 / T) * I * I +
    Math.log(1 - 0.001005 * S);
  return Math.exp(lnKS);
}

/** KF - HF dissociation (Dickson & Riley 1979, Total scale) */
function calcKF(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const I = calcIonicStrength(S);
  const I2 = Math.sqrt(I);
  const lnKF = 1590.2 / T - 12.641 + 1.525 * I2 + Math.log(1 - 0.001005 * S);
  return Math.exp(lnKF);
}

/** KB - Borate equilibrium (Dickson 1990, Total scale) */
function calcKB(tempC: number, S: number): number {
  const T = tempCToK(tempC);
  const S2 = Math.sqrt(S);
  const lnKB =
    (-8966.90 - 2890.53 * S2 - 77.942 * S + 1.728 * S * S2 - 0.0996 * S * S) / T +
    (148.0248 + 137.1942 * S2 + 1.62142 * S) +
    (-24.4344 - 25.085 * S2 - 0.2474 * S) * Math.log(T) +
    0.053105 * S2 * T;
  return Math.exp(lnKB);
}

/** Activity coefficient for H+ (Zeebe & Wolf-Gladrow) */
function calcActivityCoefficientH(tempC: number, S: number): number {
  if (S <= 0) return 1.0;
  const T = tempCToK(tempC);
  const I = calcIonicStrength(S);
  const rootI = Math.sqrt(I);
  const A = 1820000.0 * Math.pow(79 * T, -1.5);
  const logfH = A * ((rootI / (1 + rootI)) - 0.2 * I);
  return Math.pow(10, -logfH);
}

function molalToMolin(S: number): number {
  return 1.0 - 0.001005 * S;
}

function ahSwsToNbsFactor(tempC: number, S: number): number {
  return calcActivityCoefficientH(tempC, S) / molalToMolin(S);
}

function ahFreeToSwsFactor(tempC: number, S: number): number {
  if (S <= 0) return 1.0;
  const ST = totalSulfate(S);
  const FT = totalFluoride(S);
  const KS = calcKS(tempC, S);
  const KF = calcKF(tempC, S);
  return 1 + ST / KS + FT / KF;
}

function ahFreeToTotFactor(tempC: number, S: number): number {
  if (S <= 0) return 1.0;
  const ST = totalSulfate(S);
  const KS = calcKS(tempC, S);
  return 1 + ST / KS;
}

function swsToFree(K_sws: number, tempC: number, S: number): number {
  return K_sws / ahFreeToSwsFactor(tempC, S);
}

function totToFree(K_tot: number, tempC: number, S: number): number {
  return K_tot / ahFreeToTotFactor(tempC, S);
}

/** Convert pH from NBS to Free scale */
export function phNbsToFree(pHnbs: number, tempC: number, S: number): number {
  return (
    pHnbs +
    Math.log10(ahSwsToNbsFactor(tempC, S)) +
    Math.log10(ahFreeToSwsFactor(tempC, S))
  );
}

/** Convert pH from Free to NBS scale */
export function phFreeToNbs(pHfree: number, tempC: number, S: number): number {
  return (
    pHfree -
    Math.log10(ahSwsToNbsFactor(tempC, S)) -
    Math.log10(ahFreeToSwsFactor(tempC, S))
  );
}

// ============================================================================
// CARBONATE SYSTEM - ALPHA FRACTIONS
// ============================================================================

/** Alpha0 = [CO2] / DIC */
export function alphaZero(pHfree: number, tempC: number, S: number): number {
  const H = Math.pow(10, -pHfree);
  const K1 = swsToFree(getK1(tempC, S), tempC, S);
  const K2 = swsToFree(getK2(tempC, S), tempC, S);
  return H * H / (H * H + H * K1 + K1 * K2);
}

/** Alpha1 = [HCO3-] / DIC */
export function alphaOne(pHfree: number, tempC: number, S: number): number {
  const H = Math.pow(10, -pHfree);
  const K1 = swsToFree(getK1(tempC, S), tempC, S);
  const K2 = swsToFree(getK2(tempC, S), tempC, S);
  return H * K1 / (H * H + H * K1 + K1 * K2);
}

/** Alpha2 = [CO3^2-] / DIC */
export function alphaTwo(pHfree: number, tempC: number, S: number): number {
  const H = Math.pow(10, -pHfree);
  const K1 = swsToFree(getK1(tempC, S), tempC, S);
  const K2 = swsToFree(getK2(tempC, S), tempC, S);
  return K1 * K2 / (H * H + H * K1 + K1 * K2);
}

// ============================================================================
// DEFFEYES DIAGRAM CORE
// ============================================================================

/** Slope of pH isoline: dALK/dDIC = alpha1 + 2*alpha2 */
export function phLineSlope(pHfree: number, tempC: number, S: number): number {
  return alphaOne(pHfree, tempC, S) + 2 * alphaTwo(pHfree, tempC, S);
}

/** Y-intercept of pH isoline: [OH-] - [H+] + [B(OH)4-] (meq/L) */
export function phLineIntercept(pHfree: number, tempC: number, S: number): number {
  const H = Math.pow(10, -pHfree);
  const Kw = swsToFree(calcKw(tempC, S), tempC, S);
  const OH = Kw / H;

  let borate = 0;
  if (S > 0) {
    const BT = totalBoron(S);
    const KB = totToFree(calcKB(tempC, S), tempC, S);
    borate = BT * KB / (KB + H);
  }

  return (OH - H + borate) * 1000;
}

// ============================================================================
// DIC / ALK / pH INTERCONVERSIONS
// ============================================================================

/** DIC from ALK + pH (ALK meq/L, returns DIC mmol/L) */
export function calcDicOfAlk(alkMeq: number, pHnbs: number, tempC: number, S: number): number {
  const pHfree = phNbsToFree(pHnbs, tempC, S);
  const slope = phLineSlope(pHfree, tempC, S);
  const intercept = phLineIntercept(pHfree, tempC, S);
  if (slope === 0) return 0;
  return (alkMeq - intercept) / slope;
}

/** ALK from DIC + pH (DIC mmol/L, returns ALK meq/L) */
export function calcAlkOfDicPh(dicMM: number, pHnbs: number, tempC: number, S: number): number {
  const pHfree = phNbsToFree(pHnbs, tempC, S);
  const slope = phLineSlope(pHfree, tempC, S);
  const intercept = phLineIntercept(pHfree, tempC, S);
  return dicMM * slope + intercept;
}

/**
 * pH from ALK + DIC (bisection method)
 * ALK meq/L, DIC mmol/L, returns pH NBS
 * Range: [2.0, 12.0] - wider than original for hydroponic acid dosing
 */
export function calcPhForAlkDic(alkMeq: number, dicMM: number, tempC: number, S: number): number {
  let lo = 2.0, hi = 12.0;
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

/**
 * Equilibrium pH: the pH that would result if CO₂ reached atmospheric equilibrium.
 * At equilibrium [CO₂*] = co2EqMmol (constant), so DIC_eq = co2EqMmol / alpha0(pH).
 * Bisection finds pH where calcAlkOfDicPh(DIC_eq, pH) = alkMeq.
 */
export function calcEquilibriumPH(
  alkMeq: number, co2EqMmol: number, tempC: number, S: number
): number {
  let lo = 2.0, hi = 12.0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const pHfree = phNbsToFree(mid, tempC, S);
    const a0 = alphaZero(pHfree, tempC, S);
    if (a0 < 1e-15) { hi = mid; continue; }
    const dicEq = Math.min(co2EqMmol / a0, 1e6);
    const alkCalc = calcAlkOfDicPh(dicEq, mid, tempC, S);
    if (alkCalc < alkMeq) lo = mid; else hi = mid;
    if (hi - lo < 1e-8) break;
  }
  return (lo + hi) / 2;
}

/** CO2 from DIC + pH (returns mmol/L) */
export function calcCo2OfDic(dicMM: number, pHnbs: number, tempC: number, S: number): number {
  const pHfree = phNbsToFree(pHnbs, tempC, S);
  return dicMM * alphaZero(pHfree, tempC, S);
}

/** CO2 mmol/L -> mg/L */
export function co2MmToMg(co2Mm: number): number {
  return co2Mm * 44.0096;
}

/**
 * Find DIC at atmospheric CO₂ equilibrium for a given ALK.
 * Solves: CO2(DIC, pH(ALK, DIC)) = co2EqMmol via bisection.
 * Returns equilibrated { DIC, pH }.
 */
export function equilibrateCo2(
  alkMeq: number,
  co2EqMmol: number,
  tempC: number,
  salinity: number,
): { DIC: number; pH: number } {
  let lo = 0.001, hi = 20.0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const pH = calcPhForAlkDic(alkMeq, mid, tempC, salinity);
    const co2 = calcCo2OfDic(mid, pH, tempC, salinity);
    if (co2 < co2EqMmol) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-8) break;
  }
  const DIC = (lo + hi) / 2;
  const pH = calcPhForAlkDic(alkMeq, DIC, tempC, salinity);
  return { DIC, pH };
}
