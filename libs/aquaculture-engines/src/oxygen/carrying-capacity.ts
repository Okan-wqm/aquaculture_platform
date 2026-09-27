/**
 * Tank carrying capacity under two independent limits — stocking density and
 * the oxygen the water can hold above the safe floor. Pure arithmetic.
 *
 * REFERENCES: Weiss (1970); Colt (2006); Timmons & Ebeling (2013).
 */
import { doSaturationWeiss, O2_DEMAND_COEFFICIENTS } from './do-saturation.js';
import { MIN_SAFE_DO_MG_L } from './oxygen-budget.js';

export type CapacityLimitingFactor = 'density' | 'oxygen';

export interface CarryingCapacityInput {
  tankVolumeM3: number;
  temperatureC: number;
  salinityPpt?: number;
  minSafeDoMgL?: number;
  /** Species/system stocking ceiling (kg/m³). */
  maxDensityKgM3: number;
  avgFishWeightG: number;
  /** Daily feeding rate as % of body weight. */
  dailyFeedingRatePercent: number;
  hasBiofilter?: boolean;
}

export interface CarryingCapacityResult {
  maxBiomassKg: number;
  maxFishCount: number;
  effectiveMaxDensityKgM3: number;
  limitingFactor: CapacityLimitingFactor;
  density: { maxBiomassKg: number };
  oxygen: {
    /** null when the feeding rate is 0 (no oxygen demand → unbounded). */
    maxBiomassKg: number | null;
    doSaturationMgL: number;
    doAvailableMgL: number;
    o2PerKgBiomassPerDayKg: number;
    breakdownPerKg: { fish: number; organic: number; biofilter: number };
  };
}

export function carryingCapacity(input: CarryingCapacityInput): CarryingCapacityResult {
  const salinity = input.salinityPpt ?? 0;
  const minSafe = input.minSafeDoMgL ?? MIN_SAFE_DO_MG_L;
  const c = O2_DEMAND_COEFFICIENTS;

  const densityLimitKg = input.maxDensityKgM3 * input.tankVolumeM3;

  const doSaturationMgL = doSaturationWeiss(input.temperatureC, salinity);
  const doAvailableMgL = Math.max(0, doSaturationMgL - minSafe);

  const feedPerKgBiomass = input.dailyFeedingRatePercent / 100;
  const fish = feedPerKgBiomass * c.fishPerKgFeed;
  const organic = feedPerKgBiomass * c.organicPerKgFeed;
  const biofilter = input.hasBiofilter
    ? feedPerKgBiomass * c.defaultTanPerKgFeed * c.nitrificationPerKgTan
    : 0;
  const o2PerKgBiomassPerDayKg = fish + organic + biofilter;

  // Oxygen held above the floor, expressed in kg: mg/L × m³ × 1000 L/m³ / 1e6 mg/kg.
  const doAvailableKg = (doAvailableMgL * input.tankVolumeM3 * 1000) / 1_000_000;
  const oxygenLimitKg =
    o2PerKgBiomassPerDayKg > 0 ? doAvailableKg / o2PerKgBiomassPerDayKg : Infinity;

  const maxBiomassKg = Math.min(densityLimitKg, oxygenLimitKg);
  const limitingFactor: CapacityLimitingFactor =
    densityLimitKg <= oxygenLimitKg ? 'density' : 'oxygen';

  return {
    maxBiomassKg,
    maxFishCount: Math.floor((maxBiomassKg * 1000) / input.avgFishWeightG),
    effectiveMaxDensityKgM3: maxBiomassKg / input.tankVolumeM3,
    limitingFactor,
    density: { maxBiomassKg: densityLimitKg },
    oxygen: {
      maxBiomassKg: Number.isFinite(oxygenLimitKg) ? oxygenLimitKg : null,
      doSaturationMgL,
      doAvailableMgL,
      o2PerKgBiomassPerDayKg,
      breakdownPerKg: { fish, organic, biofilter },
    },
  };
}
