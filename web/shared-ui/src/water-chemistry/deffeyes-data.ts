/**
 * Pure Deffeyes chart-data builder (SSoT).
 *
 * Extracted verbatim from farm-module WaterChemistryPage's `deffeyesData` +
 * `deffeyesDataWithReagent` useMemos. Engine-only, deterministic. `opts.onError`
 * keeps the farm-specific DOM-event diagnostic OUT of shared-ui — the farm page
 * passes its reporter; sensor cards pass nothing (silent fallback).
 */
import {
  alkMgToMeq,
  calcDosingVisualization,
  generateDeffeyesChartData,
  reagentDirectionLine,
  REAGENTS,
} from '@platform/aquaculture-engines';
import type { DeffeyesChartData } from '@platform/aquaculture-engines';

import type { WaterChemistryInputs } from './types';

export const REAGENT_COLORS: Record<string, string> = {
  'Sodium Bicarbonate': '#2563eb',
  'Sodium Carbonate': '#7c3aed',
  'Sodium Hydroxide': '#059669',
  'Calcium Carbonate': '#0891b2',
  'Calcium Hydroxide': '#65a30d',
  'Calcium Oxide': '#ca8a04',
  'Add CO₂': '#ea580c',
  'De-gas CO₂': '#dc2626',
  'Muriatic Acid': '#be185d',
};

const EMPTY_DEFFEYES: DeffeyesChartData = {
  isolines: [],
  nh3ToxicZone: null,
  co2ToxicZone: null,
  h2sToxicZone: null,
  safeZone: null,
  currentPoint: { DIC: 0, ALK: 0 },
  targetPoint: null,
  reagentLine: null,
  dosingVisualization: null,
  omegaCalcite: null,
  omegaAragonite: null,
};

export interface BuildDeffeyesOptions {
  onError?: (stage: string, err: unknown) => void;
}

export function buildDeffeyesData(
  inputs: WaterChemistryInputs,
  selectedReagents: string[],
  opts?: BuildDeffeyesOptions,
): DeffeyesChartData {
  const alkMeq = alkMgToMeq(inputs.alkalinityMg);
  const targetAlkMeq = alkMgToMeq(inputs.targetAlkalinityMg);
  const alkMinMeq = alkMgToMeq(inputs.alkMinMg);
  const alkMaxMeq = alkMgToMeq(inputs.alkMaxMg);
  const h2sMeasuredAtPH = inputs.pH;

  let base: DeffeyesChartData;
  try {
    base = generateDeffeyesChartData(
      { tempC: inputs.tempC, pH: inputs.pH, salinity: inputs.salinity, alkalinity: alkMeq },
      inputs.showTarget ? { targetpH: inputs.targetpH, targetAlkalinity: targetAlkMeq } : null,
      {
        tan: inputs.tan,
        unIonizedNH3: inputs.unIonizedNH3,
        co2Toxic: inputs.co2Toxic,
        h2sMeasuredUgL: inputs.h2sUgL,
        h2sLimitUgL: inputs.h2sLimitUgL,
        h2sMeasuredAtPH,
      },
      alkMinMeq,
      alkMaxMeq,
      inputs.caMgL,
    );
  } catch (e) {
    opts?.onError?.('deffeyes-data-generation', e);
    base = { ...EMPTY_DEFFEYES };
  }

  // Add reagent visualization.
  const result: DeffeyesChartData = { ...base };

  if (selectedReagents.length === 1) {
    const reagent = REAGENTS.find((r) => r.name === selectedReagents[0]);
    if (reagent) {
      result.reagentLine = reagentDirectionLine(base.currentPoint.DIC, base.currentPoint.ALK, reagent, 8);
    }
  } else if (selectedReagents.length === 2) {
    if (base.targetPoint) {
      result.dosingVisualization = calcDosingVisualization(
        base.currentPoint.DIC,
        base.currentPoint.ALK,
        base.targetPoint.DIC,
        base.targetPoint.ALK,
        selectedReagents[0],
        selectedReagents[1],
      );
    }

    if (!result.dosingVisualization) {
      const r1 = REAGENTS.find((r) => r.name === selectedReagents[0]);
      const r2 = REAGENTS.find((r) => r.name === selectedReagents[1]);
      if (r1 && r2) {
        const line1 = reagentDirectionLine(base.currentPoint.DIC, base.currentPoint.ALK, r1, 8);
        const line2 = reagentDirectionLine(base.currentPoint.DIC, base.currentPoint.ALK, r2, 8);
        result.dosingVisualization = {
          reagentLine1: { points: line1, label: r1.formula, color: REAGENT_COLORS[r1.name] || '#6b7280' },
          reagentLine2: { points: line2, label: r2.formula, color: REAGENT_COLORS[r2.name] || '#6b7280' },
          step1Path: [],
          step2Path: [],
          intermediatePoint: { DIC: 0, ALK: 0 },
          step1Label: '',
          step2Label: '',
        };
      }
    }
  }

  return result;
}
