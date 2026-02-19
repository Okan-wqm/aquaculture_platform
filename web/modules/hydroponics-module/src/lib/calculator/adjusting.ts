import type { DrainageComposition, CurrentNsFormula, ReadjustmentSettings } from '../../types/modes.types';
import type { NutrientVector } from './types';
import { emptyVector } from './types';

/**
 * Step 3b (Adjusting mode):
 * Adjust the NS formula based on current and previous drainage composition.
 *
 * The basic approach:
 * 1. Compare current drainage to target drip solution
 * 2. For each nutrient, if drainage > target → reduce in new formula
 * 3. If drainage < target → increase in new formula
 * 4. Apply a correction factor based on timeToRestore
 */
export function calculateAdjustment(
  currentDrainage: DrainageComposition,
  previousDrainage: DrainageComposition | undefined,
  currentFormula: CurrentNsFormula,
  target: NutrientVector,
  readjustment: ReadjustmentSettings
): { adjusted: NutrientVector; warnings: string[] } {
  const warnings: string[] = [];
  const adjusted = emptyVector();

  // Correction aggressiveness: shorter restore time = more aggressive correction
  const correctionFactor = Math.min(1, readjustment.timeApplyingCurrentNs / readjustment.timeToRestore);

  const keys = Object.keys(target) as (keyof NutrientVector)[];
  for (const key of keys) {
    const targetVal = target[key];
    const drainageVal = currentDrainage.parameters[key.toLowerCase()] ?? 0;

    // Deviation from target
    const deviation = drainageVal - targetVal;

    // Apply correction: if drainage is too high, reduce; if too low, increase
    let corrected = targetVal - deviation * correctionFactor;

    // If we have previous drainage, use trend for more refined adjustment
    if (previousDrainage) {
      const prevDrainVal = previousDrainage.parameters[key.toLowerCase()] ?? 0;
      const trend = drainageVal - prevDrainVal;
      // If trend is moving away from target, increase correction
      if (Math.sign(trend) === Math.sign(deviation) && Math.abs(trend) > 0) {
        corrected -= trend * correctionFactor * 0.5;
      }
    }

    // Clamp to non-negative
    if (corrected < 0) {
      warnings.push(`${key}: Adjusted value was negative, clamped to 0.`);
      corrected = 0;
    }

    adjusted[key] = corrected;
  }

  return { adjusted, warnings };
}
