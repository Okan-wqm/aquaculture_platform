import type { CalcInput, CalcResult, NutrientVector } from './types';
import { emptyVector } from './types';
import { calculateDripSolution } from './drip-solution';
import { waterParametersToVector, subtractWater } from './subtract-water';
import { calculateAddedSolution } from './closed-system';
import { calculateAdjustment } from './adjusting';
import { allocateFertilizers } from './fertilizer-allocation';
import { calculateIonBalance } from './balance';

/**
 * Main calculation orchestrator.
 */
export function calculate(input: CalcInput): CalcResult {
  const { settings, profile, preferenceMultipliers } = input;
  const warnings: string[] = [];

  const systemType = settings.generalOptions.serviceDefinition.systemType;
  const nsType = settings.generalOptions.basicOptions.nsType;

  // Step 1: Target drip solution from profile
  const drip = calculateDripSolution(profile, preferenceMultipliers);

  // Step 2: Irrigation water composition
  const irrigationWater = waterParametersToVector(settings.waterAnalysis.parameters);

  let targetForSubtraction: NutrientVector = drip.nutrients;

  // Step 3: Closed system adjustment
  let addedSolution = emptyVector();
  if (systemType === 'closed') {
    const drainageFraction = settings.generalOptions.serviceDefinition.targetDrainagePercent / 100;
    // Use drainage composition if available, otherwise use empty
    const drainageVector = emptyVector();
    if (settings.drainageComposition) {
      const keys = Object.keys(drainageVector) as (keyof NutrientVector)[];
      for (const key of keys) {
        drainageVector[key] = settings.drainageComposition.parameters[key.toLowerCase()] ?? 0;
      }
    }
    const closedResult = calculateAddedSolution(drip.nutrients, drainageVector, drainageFraction);
    addedSolution = closedResult.addedSolution;
    warnings.push(...closedResult.warnings);
    targetForSubtraction = addedSolution;
  }

  // Step 3b: Adjusting mode correction
  if (nsType === 'adjusting' && settings.drainageComposition && settings.readjustmentSettings) {
    const adjustResult = calculateAdjustment(
      settings.drainageComposition,
      settings.previousDrainage,
      settings.currentNsFormula ?? { targetEcDsMixer: 0, targetEcFertigation: 0, parameters: {} },
      targetForSubtraction,
      settings.readjustmentSettings
    );
    targetForSubtraction = adjustResult.adjusted;
    warnings.push(...adjustResult.warnings);
  }

  // Step 4: Subtract irrigation water
  const subtractResult = subtractWater(targetForSubtraction, irrigationWater);
  warnings.push(...subtractResult.warnings);

  // Step 5: Fertilizer allocation
  const fertResult = allocateFertilizers(subtractResult.toAdd, settings.generalOptions);
  warnings.push(...fertResult.warnings);

  // Step 6: Ion balance check
  const ionBalance = calculateIonBalance(drip.nutrients);
  if (Math.abs(ionBalance.balancePercent) > 5) {
    warnings.push(
      `Ion balance deviation: ${ionBalance.balancePercent.toFixed(1)}% ` +
      `(cations: ${ionBalance.totalCations.toFixed(2)} meq/L, anions: ${ionBalance.totalAnions.toFixed(2)} meq/L)`
    );
  }

  return {
    dripSolution: drip.nutrients,
    irrigationWater,
    addedSolution,
    toAdd: subtractResult.toAdd,
    fertilizers: fertResult.fertilizers,
    ionBalance,
    warnings,
    ec: drip.ec,
    ph: drip.ph,
  };
}

export type { CalcInput, CalcResult, NutrientVector, FertilizerAmount, IonBalance } from './types';
