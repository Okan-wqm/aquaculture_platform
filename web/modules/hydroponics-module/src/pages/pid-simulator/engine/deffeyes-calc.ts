/**
 * Hydroponics Deffeyes Diagram Data Generator
 * pH 4.0-9.0 range (hydroponic focused)
 */

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

/** Color palette for hydroponic pH range */
function phIsolineColor(pH: number): string {
  if (pH < 4.5) return '#991b1b';
  if (pH < 5.0) return '#dc2626';
  if (pH < 5.5) return '#ef4444';
  if (pH < 6.0) return '#f97316';
  if (pH < 6.5) return '#eab308';
  if (pH < 7.0) return '#22c55e';
  if (pH < 7.5) return '#06b6d4';
  if (pH < 8.0) return '#3b82f6';
  if (pH < 8.5) return '#6366f1';
  return '#7c3aed';
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
