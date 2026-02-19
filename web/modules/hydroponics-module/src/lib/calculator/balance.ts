import type { NutrientVector, IonBalance } from './types';

/**
 * Calculate cation-anion balance check.
 * Returns total cations (meq/L), total anions (meq/L), and balance %.
 */
export function calculateIonBalance(nutrients: NutrientVector): IonBalance {
  // Cations (meq/L): K*1 + Ca*2 + Mg*2 + NH4*1 + Na*1
  const totalCations =
    nutrients.K * 1 +
    nutrients.Ca * 2 +
    nutrients.Mg * 2 +
    nutrients.NH4 * 1 +
    nutrients.Na * 1;

  // Anions (meq/L): NO3*1 + H2PO4*1 + SO4*2 + Cl*1 + HCO3*1
  const totalAnions =
    nutrients.NO3 * 1 +
    nutrients.H2PO4 * 1 +
    nutrients.SO4 * 2 +
    nutrients.Cl * 1 +
    nutrients.HCO3 * 1;

  const sum = totalCations + totalAnions;
  const balancePercent = sum > 0 ? ((totalCations - totalAnions) / sum) * 100 : 0;

  return { totalCations, totalAnions, balancePercent };
}
