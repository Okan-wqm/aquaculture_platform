import type { NutrientVector } from './types';
import { emptyVector } from './types';

/**
 * Step 3 (Closed system only):
 * AS = (DripSolution - DS * DF) / (1 - DF)
 *
 * Where:
 *  - AS = Added Solution (what we need to add to the recirculating system)
 *  - DS = Drainage Solution composition
 *  - DF = Drainage Fraction (targetDrainagePercent / 100)
 *  - DripSolution = target drip composition
 */
export function calculateAddedSolution(
  dripSolution: NutrientVector,
  drainageSolution: NutrientVector,
  drainageFraction: number // 0-1
): { addedSolution: NutrientVector; warnings: string[] } {
  const warnings: string[] = [];
  const addedSolution = emptyVector();

  if (drainageFraction >= 1) {
    warnings.push('Drainage fraction >= 100%. Using drip solution directly.');
    return { addedSolution: { ...dripSolution }, warnings };
  }

  if (drainageFraction <= 0) {
    return { addedSolution: { ...dripSolution }, warnings };
  }

  const keys = Object.keys(dripSolution) as (keyof NutrientVector)[];
  for (const key of keys) {
    const value = (dripSolution[key] - drainageSolution[key] * drainageFraction) / (1 - drainageFraction);
    if (value < 0) {
      warnings.push(`${key}: Added Solution is negative (drainage too concentrated). Set to 0.`);
      addedSolution[key] = 0;
    } else {
      addedSolution[key] = value;
    }
  }

  return { addedSolution, warnings };
}
