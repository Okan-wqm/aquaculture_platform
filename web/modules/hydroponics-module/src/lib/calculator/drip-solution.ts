import type { NutrientProfile } from '../../types/modes.types';
import type { NutrientVector, DripSolution } from './types';
import { emptyVector } from './types';

/**
 * Step 1: Calculate target drip solution composition from profile + preferences.
 *
 * Uses the ratio method:
 *  1. Get total cation budget from EC (empirical: totalCat ≈ EC * 10 / 2 meq/L)
 *  2. Distribute K, Ca, Mg by their ratios
 *  3. Derive NO3 from N/K ratio, then NH4 from NH4 ratio
 *  4. P, Cl, Si, micros directly from profile
 *  5. SO4 as residual anion (≥ minSO4)
 */
export function calculateDripSolution(
  profile: NutrientProfile,
  preferenceMultipliers: Record<string, number>
): DripSolution {
  const ec = profile.ec * (preferenceMultipliers['ec'] ?? 1);
  // BUG-HYD-004: pH is logarithmic — multiplying it linearly produces agronomically
  // wrong acid targets (e.g. 5.5 * 1.3 = 7.15). pH is always taken from the profile
  // directly; preference adjustments do not apply to pH.
  const ph = profile.ph;

  // Total cation budget (meq/L) — empirical: EC (mS/cm) ≈ 0.1 * total ion (meq/L)
  // totalCat ≈ EC * 10 / 2  (half cations, half anions)
  const totalCatMeq = ec * 10 / 2;

  // Distribute cations by ratios (ratios sum to 1)
  const kMeq = totalCatMeq * profile.kRatio;
  const caMeq = totalCatMeq * profile.caRatio;
  const mgMeq = totalCatMeq * profile.mgRatio;

  // Convert meq/L to mmol/L (K:1, Ca:2, Mg:2)
  const K = kMeq;            // valence 1
  const Ca = caMeq / 2;      // valence 2
  const Mg = mgMeq / 2;      // valence 2

  // N/K ratio: totalN = K * nkRatio
  const totalN = K * profile.nkRatio;
  const NH4 = totalN * profile.nh4Ratio;
  const NO3 = totalN - NH4;

  // Direct values from profile, apply preference
  const H2PO4 = profile.p * (preferenceMultipliers['p'] ?? 1);
  const Cl = profile.cl * (preferenceMultipliers['cl'] ?? 1);
  const Si = profile.si * (preferenceMultipliers['si'] ?? 1);

  // Micro (umol/L)
  const Fe = profile.fe * (preferenceMultipliers['fe'] ?? 1);
  const Mn = profile.mn * (preferenceMultipliers['mn'] ?? 1);
  const Zn = profile.zn * (preferenceMultipliers['zn'] ?? 1);
  const Cu = profile.cu * (preferenceMultipliers['cu'] ?? 1);
  const B = profile.b * (preferenceMultipliers['b'] ?? 1);
  const Mo = profile.mo * (preferenceMultipliers['mo'] ?? 1);

  // SO4 as residual anion
  // Total cations (meq): K*1 + Ca*2 + Mg*2 + NH4*1
  const totalCatActual = K + Ca * 2 + Mg * 2 + NH4;
  // Total anions (meq): NO3*1 + H2PO4*1 + Cl*1 + SO4*2
  const anionsWithoutSO4 = NO3 + H2PO4 + Cl;
  const so4Meq = Math.max(totalCatActual - anionsWithoutSO4, 0);
  const SO4 = Math.max(so4Meq / 2, profile.minSO4 * (preferenceMultipliers['so4_min'] ?? 1));

  const nutrients: NutrientVector = {
    ...emptyVector(),
    K, Ca, Mg, NH4, NO3, H2PO4, SO4, Cl, Si,
    Fe, Mn, Zn, Cu, B, Mo,
  };

  return { ec, ph, nutrients };
}
