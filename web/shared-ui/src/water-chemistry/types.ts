/**
 * Water-chemistry shared types (SSoT).
 *
 * Promoted from farm-module so BOTH the farm calculator page and the sensor-module
 * monitoring cards consume ONE contract. The pure engine (`@platform/aquaculture-engines`)
 * owns the numeric types (CalculatedOutputs, FishType, FishSize); this file owns the
 * UI-facing input shape + the Deffeyes layer keys.
 */
import type { CalculatedOutputs, FishSize, FishType } from '@platform/aquaculture-engines';

export type { CalculatedOutputs };

/** The single realtime + target + limits input set the water-chemistry UI edits. */
export interface WaterChemistryInputs {
  tempC: number;
  pH: number;
  salinity: number;
  alkalinityMg: number;
  targetpH: number;
  targetAlkalinityMg: number;
  alkMinMg: number;
  alkMaxMg: number;
  tan: number;
  unIonizedNH3: number;
  co2Toxic: number;
  h2sUgL: number; // Measured H₂S in µg/L (at the single realtime pH)
  h2sLimitUgL: number; // Toxic H₂S limit in µg/L
  caMgL: number;
  volume: number;
  fishType: FishType;
  fishSize: FishSize;
  showTarget: boolean;
}

/** The toggleable overlay layers on the Deffeyes chart. */
export type DeffeyesLayerKey =
  | 'isolines'
  | 'safeZone'
  | 'nh3Zone'
  | 'co2Zone'
  | 'h2sZone'
  | 'omega'
  | 'currentPoint'
  | 'target'
  | 'dosing'
  | 'onDemand';
