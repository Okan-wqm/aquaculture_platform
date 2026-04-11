import Decimal from 'decimal.js';
import type { NutrientVector, IonBalance } from './types';

// IMPORTANT: Configure Decimal.js for scientific-grade precision in
// nutrient calculations. ROUND_HALF_EVEN (banker's rounding) prevents
// systematic bias in cumulative recipe calculations.
Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_EVEN,
});

/**
 * Calculate cation-anion balance check using exact decimal arithmetic.
 *
 * WHY Decimal instead of native number:
 * Nutrient recipes involve repeated multiply-accumulate operations across
 * 10+ ion species. With IEEE 754 float64, each operation introduces up to
 * 2^-52 relative error. Over a full recipe calculation pipeline (profile ->
 * subtract water -> allocate fertilizers -> compute balance), the cumulative
 * drift can exceed 0.1 meq/L, which is significant for precision hydroponics
 * where ion balance targets are +/- 2%.
 *
 * @param nutrients - Nutrient concentrations in mmol/L (macro) and umol/L (micro)
 * @returns Ion balance with totalCations, totalAnions, and balancePercent
 */
export function calculateIonBalance(nutrients: NutrientVector): IonBalance {
  // ── Cations (meq/L): K*1 + Ca*2 + Mg*2 + NH4*1 + Na*1 ──
  const totalCations = new Decimal(nutrients.K).times(1)
    .plus(new Decimal(nutrients.Ca).times(2))
    .plus(new Decimal(nutrients.Mg).times(2))
    .plus(new Decimal(nutrients.NH4).times(1))
    .plus(new Decimal(nutrients.Na).times(1));

  // ── Anions (meq/L): NO3*1 + H2PO4*1 + SO4*2 + Cl*1 + HCO3*1 ──
  const totalAnions = new Decimal(nutrients.NO3).times(1)
    .plus(new Decimal(nutrients.H2PO4).times(1))
    .plus(new Decimal(nutrients.SO4).times(2))
    .plus(new Decimal(nutrients.Cl).times(1))
    .plus(new Decimal(nutrients.HCO3).times(1));

  const sum = totalCations.plus(totalAnions);
  const balancePercent = sum.isZero()
    ? new Decimal(0)
    : totalCations.minus(totalAnions).dividedBy(sum).times(100);

  return {
    totalCations: totalCations.toNumber(),
    totalAnions: totalAnions.toNumber(),
    balancePercent: balancePercent.toNumber(),
  };
}
