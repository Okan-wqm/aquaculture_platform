/**
 * Hydroponics Deffeyes Diagram Data Generator
 * pH 4.0-9.0 range (hydroponic focused)
 */

import { colors } from '@aquaculture/shared-ui';

import {
  phNbsToFree,
  phLineSlope,
  phLineIntercept,
  calcDicOfAlk,
} from './carbonate-chemistry';
import { HydroReagent, reagentDirectionLine } from './reagents';

export interface PHIsoline {
  pH: number;
  color: string;
  points: Array<{ CT: number; AT: number }>;
}

/**
 * Isoline colour by pH band — a diverging scale on the theme's tokens:
 * acid bands in the error reds, the approach to neutral in the warning
 * ambers, the neutral bands in the success greens, alkaline bands in the
 * info and primary blues. Each band is a step apart from its neighbours,
 * which is all an isoline needs (its label carries the value); one palette
 * across charts is what the raw-hex ratchet asks for.
 */
const PH_BANDS: ReadonlyArray<readonly [upperBound: number, colour: string]> = [
  [4.5, colors.error[700]],
  [5.0, colors.error[600]],
  [5.5, colors.error[500]],
  [6.0, colors.warning[600]],
  [6.5, colors.warning[500]],
  [7.0, colors.success[500]],
  [7.5, colors.success[700]],
  [8.0, colors.info[500]],
  [8.5, colors.primary[600]],
];
const PH_ALKALINE_COLOR = colors.primary[800];

function phIsolineColor(pH: number): string {
  const band = PH_BANDS.find(([upperBound]) => pH < upperBound);
  return band ? band[1] : PH_ALKALINE_COLOR;
}

/**
 * Generate pH isolines for the Deffeyes diagram
 * pH range: 4.0-9.0, step 0.25 (hydroponic focus)
 */
export function generatePHIsolines(
  tempC: number,
  S: number,
  maxDIC: number = 5,
): PHIsoline[] {
  const isolines: PHIsoline[] = [];

  for (let pH = 4.0; pH <= 9.0; pH += 0.25) {
    const pHVal = parseFloat(pH.toFixed(2));
    const pHfree = phNbsToFree(pHVal, tempC, S);
    const slope = phLineSlope(pHfree, tempC, S);
    const intercept = phLineIntercept(pHfree, tempC, S);

    const points: Array<{ CT: number; AT: number }> = [];
    for (let ct = 0; ct <= maxDIC; ct += maxDIC / 100) {
      const at = ct * slope + intercept;
      points.push({
        CT: parseFloat(ct.toFixed(4)),
        AT: parseFloat(at.toFixed(4)),
      });
    }

    isolines.push({ pH: pHVal, color: phIsolineColor(pHVal), points });
  }

  return isolines;
}

/**
 * Calculate operating point (DIC, ALK) from pH and ALK
 */
export function calcOperatingPoint(
  pHnbs: number,
  alkMeq: number,
  tempC: number,
  S: number,
): { DIC: number; ALK: number } {
  const dic = calcDicOfAlk(alkMeq, pHnbs, tempC, S);
  return { DIC: dic, ALK: alkMeq };
}

export interface HydroDeffeysData {
  isolines: PHIsoline[];
  currentPoint: { DIC: number; ALK: number };
  targetPoint: { DIC: number; ALK: number } | null;
  reagentLines: Array<{
    reagent: HydroReagent;
    points: Array<{ CT: number; AT: number }>;
  }>;
  trail: Array<{ CT: number; AT: number }>;
}

/**
 * Generate full Deffeyes data for the simulator
 */
export function generateHydroDeffeysData(
  tempC: number,
  S: number,
  currentPH: number,
  currentAlk: number,
  targetPH: number | null,
  targetAlk: number | null,
  reagents: HydroReagent[],
  trail: Array<{ CT: number; AT: number }>,
  maxDIC: number = 5,
): HydroDeffeysData {
  const isolines = generatePHIsolines(tempC, S, maxDIC);
  const currentPoint = calcOperatingPoint(currentPH, currentAlk, tempC, S);

  let targetPoint: { DIC: number; ALK: number } | null = null;
  if (targetPH != null && targetAlk != null) {
    targetPoint = calcOperatingPoint(targetPH, targetAlk, tempC, S);
  }

  const reagentLines = reagents.map(r => ({
    reagent: r,
    points: reagentDirectionLine(currentPoint.DIC, currentPoint.ALK, r, 3),
  }));

  return { isolines, currentPoint, targetPoint, reagentLines, trail };
}
