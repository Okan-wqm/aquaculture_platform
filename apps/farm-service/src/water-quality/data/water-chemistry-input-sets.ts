import { measuredQuantity, type QuantityId } from '@aquaculture/shared-contracts';

import { SystemType } from '../../system/entities/system.entity';

import type { MeasurementPointKind } from '../services/parameter-sources';

/**
 * What the water-chemistry engine needs measured, and where (plan rev2 D3).
 *
 * The engine (`@platform/aquaculture-engines`, driven through shared-ui's
 * `computeWaterChemistryOutputs`) takes one `WaterChemistryInputs` record. Two
 * of its calculations read measured inputs at a point of the farm:
 *
 * - DOSING, at a system (a recirculating loop): the carbonate state of the
 *   loop — pH, alkalinity, temperature, salinity, calcium — and the loop's
 *   water volume (`System.totalVolumeM3`), from which the reagent recipe is
 *   scaled. A recipe for a flow-through or open system doses water that leaves.
 * - TOXICITY, at a tank: un-ionized ammonia and H2S from pH, temperature,
 *   salinity, TAN and H2S. The engine back-calculates total sulfide from the
 *   H2S value at the pH it is given, so H2S is paired with its pH: read at the
 *   same point, and within PAIRING_TOLERANCE_MS of it (one water sample).
 *
 * Each input is a measured quantity of the registry, in the registry's
 * canonical unit — which is the unit the engine computes in (°C, pH, ppt,
 * mg/L CaCO3, mg/L as N, µg/L, mg/L as Ca); the spec pins that. Whether an
 * input may be read from the system or site a point belongs to is the
 * registry's `loopHomogeneous` property (D2), not decided here.
 *
 * Coherence (D3): the inputs of one calculation must describe one state of
 * the water. pH, TAN, H2S and temperature move within hours (feeding,
 * photosynthesis, degassing, the speciation of ammonia and sulfide follows
 * them); alkalinity, salinity and calcium move over days. A dosing recipe is
 * computed from alkalinity, and a dose applied after the last alkalinity
 * sample is invisible to it, so DOSING reads alkalinity within a day. Each
 * input is read no older than its window, measured back from the instant the
 * set is resolved, so the inputs of one class lie within one window of each
 * other.
 */
export const WATER_CHEMISTRY_INPUT_SET = {
  DOSING: 'DOSING',
  TOXICITY: 'TOXICITY',
} as const;

export type WaterChemistryInputSet =
  (typeof WATER_CHEMISTRY_INPUT_SET)[keyof typeof WATER_CHEMISTRY_INPUT_SET];

export const COHERENCE_WINDOW = {
  /** pH, temperature, TAN, H2S. */
  SHORT: 'SHORT',
  /** Alkalinity a dosing recipe is computed from (a dose since then is invisible to it). */
  DAILY: 'DAILY',
  /** Salinity, calcium (and alkalinity outside a dosing recipe). */
  LONG: 'LONG',
} as const;

export type CoherenceWindow = (typeof COHERENCE_WINDOW)[keyof typeof COHERENCE_WINDOW];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How old an input of each class may be when its set is resolved. */
export const COHERENCE_WINDOW_MS: Readonly<Record<CoherenceWindow, number>> = {
  SHORT: 4 * HOUR_MS,
  DAILY: 24 * HOUR_MS,
  LONG: 48 * HOUR_MS,
};

/**
 * How far apart two paired inputs may be observed and still count as one
 * water sample (H2S and the pH it is converted at).
 */
export const PAIRING_TOLERANCE_MS = 15 * MINUTE_MS;

/** A field of shared-ui's `WaterChemistryInputs` that is measured at a point. */
export type EngineInput = 'pH' | 'tempC' | 'salinity' | 'alkalinityMg' | 'caMgL' | 'tan' | 'h2sUgL';

export interface WaterChemistryInputSpec {
  readonly engineInput: EngineInput;
  readonly quantity: QuantityId;
  readonly window: CoherenceWindow;
  /**
   * Another input of the set this one must be read with: at the same point,
   * observed within PAIRING_TOLERANCE_MS of it.
   */
  readonly pairedWith?: EngineInput;
}

export interface WaterChemistryInputSetSpec {
  /** The kind of point the set is resolved at. */
  readonly point: Extract<MeasurementPointKind, 'system' | 'tank'>;
  /** Whether the set scales by the loop's water volume (and so needs a recirculating loop). */
  readonly needsLoopVolume: boolean;
  readonly inputs: readonly WaterChemistryInputSpec[];
}

export const WATER_CHEMISTRY_INPUT_SETS: Readonly<
  Record<WaterChemistryInputSet, WaterChemistryInputSetSpec>
> = {
  DOSING: {
    point: 'system',
    needsLoopVolume: true,
    inputs: [
      { engineInput: 'pH', quantity: 'ph', window: 'SHORT' },
      { engineInput: 'alkalinityMg', quantity: 'alkalinity', window: 'DAILY' },
      { engineInput: 'tempC', quantity: 'temperature', window: 'SHORT' },
      { engineInput: 'salinity', quantity: 'salinity', window: 'LONG' },
      { engineInput: 'caMgL', quantity: 'calcium', window: 'LONG' },
    ],
  },
  TOXICITY: {
    point: 'tank',
    needsLoopVolume: false,
    inputs: [
      { engineInput: 'pH', quantity: 'ph', window: 'SHORT' },
      { engineInput: 'tempC', quantity: 'temperature', window: 'SHORT' },
      { engineInput: 'salinity', quantity: 'salinity', window: 'LONG' },
      { engineInput: 'tan', quantity: 'tan', window: 'SHORT' },
      { engineInput: 'h2sUgL', quantity: 'h2s', window: 'SHORT', pairedWith: 'pH' },
    ],
  },
};

/** The unit an input is handed to the engine in: its quantity's canonical unit. */
export function engineUnit(spec: WaterChemistryInputSpec): string {
  return measuredQuantity(spec.quantity).unit;
}

/**
 * What a system's type says about its water, for every type (a `Record` over
 * the enum: a new SystemType does not compile until it is classified here).
 *
 * - RECIRCULATING: one loop volume isolated from the site's water. A dose
 *   computed for `totalVolumeM3` stays in the water it was computed for, and
 *   nitrification, make-up and the loop's own heating make its alkalinity,
 *   calcium, salinity and temperature its own — so neither the loop nor its
 *   units inherit a value from the site (D2, FARM-HIGH-381).
 * - OPEN: the water is the site's water passing through or standing in it
 *   (flow-through, raceway, pond, cage), so a unit may inherit the site's value.
 * - UNDECLARED: the type says nothing about recirculation (a hatchery, a
 *   nursery and "other" are often recirculating — a smolt hatchery loop at
 *   12 °C fed by a 6 °C intake). Neither dosed nor inherited from the site
 *   until the system is typed (FARM-MEDIUM-383).
 */
export const SYSTEM_WATER = {
  RECIRCULATING: 'RECIRCULATING',
  OPEN: 'OPEN',
  UNDECLARED: 'UNDECLARED',
} as const;

export type SystemWater = (typeof SYSTEM_WATER)[keyof typeof SYSTEM_WATER];

export const SYSTEM_WATER_OF_TYPE: Readonly<Record<SystemType, SystemWater>> = {
  [SystemType.RAS]: SYSTEM_WATER.RECIRCULATING,
  [SystemType.AQUAPONICS]: SYSTEM_WATER.RECIRCULATING,
  [SystemType.BIOFLOC]: SYSTEM_WATER.RECIRCULATING,
  [SystemType.FLOW_THROUGH]: SYSTEM_WATER.OPEN,
  [SystemType.POND]: SYSTEM_WATER.OPEN,
  [SystemType.CAGE]: SYSTEM_WATER.OPEN,
  [SystemType.RACEWAY]: SYSTEM_WATER.OPEN,
  [SystemType.HATCHERY]: SYSTEM_WATER.UNDECLARED,
  [SystemType.NURSERY]: SYSTEM_WATER.UNDECLARED,
  [SystemType.OTHER]: SYSTEM_WATER.UNDECLARED,
};

/** Whether a system's water recirculates: the only systems a dosing recipe applies to. */
export function isRecirculating(type: SystemType): boolean {
  return SYSTEM_WATER_OF_TYPE[type] === SYSTEM_WATER.RECIRCULATING;
}

/** Whether a system holds the site's water: the only systems whose units inherit from the site. */
export function holdsSiteWater(type: SystemType): boolean {
  return SYSTEM_WATER_OF_TYPE[type] === SYSTEM_WATER.OPEN;
}
