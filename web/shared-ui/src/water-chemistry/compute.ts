/**
 * Pure water-chemistry output computation (SSoT).
 *
 * Extracted verbatim from farm-module WaterChemistryPage's `outputs` useMemo so the
 * farm calculator and the sensor-module cards produce IDENTICAL numbers. Engine-only,
 * deterministic (no React, no DOM) — safe to call from any component or a Node test.
 */
import {
  alkMgToMeq,
  calcCo2OfDic,
  calcDicOfAlk,
  calcH2S,
  calcNH3,
  calcSafeTAN,
  calcSafeTotalSulfide,
  calcTotalSulfide,
  calculateDosingRecipes,
  co2MmToMg,
  criticalPHforCO2,
  criticalPHforH2SPHChartDomain,
  criticalPHforNH3,
  DEFFEYES_CHART_PH_DOMAIN,
  h2sStatus,
  percentNH3,
  uiaStatus,
} from '@platform/aquaculture-engines';

import type { CalculatedOutputs, WaterChemistryInputs } from './types';

export function computeWaterChemistryOutputs(
  inputs: WaterChemistryInputs,
  selectedReagents: string[],
): CalculatedOutputs {
  const alkMeq = alkMgToMeq(inputs.alkalinityMg);
  const targetAlkMeq = alkMgToMeq(inputs.targetAlkalinityMg);
  // H₂S is measured in-situ, so its measurement pH IS the single realtime pH.
  const h2sMeasuredAtPH = inputs.pH;

  const toxicNH3pH = criticalPHforNH3(inputs.tan, inputs.unIonizedNH3, inputs.tempC, inputs.salinity);
  const toxicCO2pH = criticalPHforCO2(alkMeq, inputs.co2Toxic, inputs.tempC, inputs.salinity);
  const uiaNPercent = isNaN(toxicNH3pH) ? NaN : percentNH3(toxicNH3pH, inputs.tempC, inputs.salinity);

  const currentDIC = calcDicOfAlk(alkMeq, inputs.pH, inputs.tempC, inputs.salinity);
  const currentCO2mm = calcCo2OfDic(currentDIC, inputs.pH, inputs.tempC, inputs.salinity);
  const currentCO2 = co2MmToMg(currentCO2mm);

  const targetDIC = calcDicOfAlk(targetAlkMeq, inputs.targetpH, inputs.tempC, inputs.salinity);
  const targetCO2mm = calcCo2OfDic(targetDIC, inputs.targetpH, inputs.tempC, inputs.salinity);
  const targetCO2 = co2MmToMg(targetCO2mm);

  const dosingRecipes = calculateDosingRecipes(
    currentDIC,
    alkMeq,
    targetDIC,
    targetAlkMeq,
    inputs.volume,
    selectedReagents,
  );

  // UIA safety calculations (from R Shiny UIA module)
  const currentUIA = calcNH3(inputs.tan, inputs.pH, inputs.tempC, inputs.salinity);
  const safeTAN = calcSafeTAN(inputs.pH, inputs.unIonizedNH3, inputs.tempC, inputs.salinity);
  const uiaStatusLevel = uiaStatus(inputs.pH, toxicNH3pH);
  const deltaPH = isNaN(toxicNH3pH) ? NaN : toxicNH3pH - inputs.pH;

  // H₂S safety calculations
  const toxicH2SpH = criticalPHforH2SPHChartDomain(
    inputs.h2sUgL,
    h2sMeasuredAtPH,
    inputs.h2sLimitUgL,
    inputs.tempC,
    inputs.salinity,
    DEFFEYES_CHART_PH_DOMAIN.minPH,
    DEFFEYES_CHART_PH_DOMAIN.maxPH,
  );
  const totalSulfide = calcTotalSulfide(inputs.h2sUgL, h2sMeasuredAtPH, inputs.tempC, inputs.salinity);
  const currentH2S = calcH2S(totalSulfide, inputs.pH, inputs.tempC, inputs.salinity);
  const safeTotalSulfide = calcSafeTotalSulfide(inputs.pH, inputs.h2sLimitUgL, inputs.tempC, inputs.salinity);
  const h2sStatusLevel = h2sStatus(inputs.pH, toxicH2SpH);
  const h2sDeltaPH = isNaN(toxicH2SpH) ? NaN : inputs.pH - toxicH2SpH; // positive = safe (above critical)

  return {
    toxicNH3pH,
    toxicCO2pH,
    uiaNPercent,
    targetCO2,
    currentCO2,
    currentDIC,
    targetDIC,
    dosingRecipes,
    currentUIA,
    safeTAN,
    uiaStatusLevel,
    deltaPH,
    toxicH2SpH,
    currentH2S,
    totalSulfide,
    safeTotalSulfide,
    h2sStatusLevel,
    h2sDeltaPH,
  };
}
