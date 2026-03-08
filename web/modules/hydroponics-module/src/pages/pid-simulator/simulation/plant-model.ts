/**
 * Thermodynamic Plant Model
 * Uses real carbonate chemistry for pH calculation after reagent dosing.
 */

import {
  calcPhForAlkDic,
  calcCo2OfDic,
  co2MmToMg,
  calcAlkOfDicPh,
} from '../engine/carbonate-chemistry';
import { HYDRO_REAGENTS, reagentDeltas } from '../engine/reagents';
import { SimConfig, SimState, PumpConfig } from './types';

const HNO3 = HYDRO_REAGENTS.find(r => r.name === 'Nitric Acid')!;
const KOH = HYDRO_REAGENTS.find(r => r.name === 'Potassium Hydroxide')!;

/**
 * Convert pump output % to grams delivered per tick.
 * flowRate_mL = pumpOutput% / 100 * maxFlowRate * (dt / 60)
 * grams = flowRate_mL * concentration_g_L / 1000
 */
export function pumpToGrams(
  pumpPercent: number,
  pumpConfig: PumpConfig,
  dt: number,
): number {
  const flowRate_mL = (pumpPercent / 100) * pumpConfig.maxFlowRate_mL_min * (dt / 60);
  return flowRate_mL * pumpConfig.concentration_g_L / 1000;
}

/**
 * Convert pump output % to mL delivered per tick.
 */
export function pumpToML(
  pumpPercent: number,
  pumpConfig: PumpConfig,
  dt: number,
): number {
  return (pumpPercent / 100) * pumpConfig.maxFlowRate_mL_min * (dt / 60);
}

/**
 * Environmental disturbances applied each tick
 */
function applyDisturbances(state: SimState, config: SimConfig, dt: number): void {
  // Atmospheric CO2 drift: slow DIC increase (~0.001 mmol/L per minute)
  state.DIC += 0.001 * (dt / 60);

  // Plant root H+ extrusion drift: slow ALK decrease (~0.0005 meq/L per minute)
  state.ALK -= 0.0005 * (dt / 60);

  // Plant nutrient uptake: slow EC decrease (~0.002 mS/cm per minute)
  state.EC -= 0.002 * (dt / 60);
  state.EC = Math.max(0.1, state.EC);
}

/**
 * Calculate gain scheduling factor from buffer capacity.
 * High buffer capacity = low process gain = need higher controller gain.
 * Low buffer capacity = high process gain = need lower controller gain.
 */
export function calcGainSchedule(
  DIC: number,
  ALK: number,
  pH: number,
  tempC: number,
  S: number,
): { gainSchedule: number; bufferCapacity: number } {
  // Buffer capacity: dALK/dpH at current operating point
  // Estimate by finite difference
  const deltaALK = 0.01; // meq/L
  const pH_plus = calcPhForAlkDic(ALK + deltaALK, DIC, tempC, S);
  const dpH = Math.abs(pH_plus - pH);

  // Process gain = dpH / dALK (how much pH changes per unit ALK change)
  const processGain = dpH > 1e-6 ? dpH / deltaALK : 1;

  // Buffer capacity is inverse of process gain
  const bufferCapacity = 1 / processGain;

  // Normalize gain schedule: reference gain at pH 5.8, DIC 2.0
  // At low buffer capacity (high process gain), REDUCE controller gain
  // At high buffer capacity (low process gain), INCREASE controller gain
  // Controller gain * process gain = constant → gainSchedule = ref / actual
  const referenceGain = 0.5; // typical dpH/dALK at pH 5.8
  const gainSchedule = Math.max(0.1, Math.min(5.0, referenceGain / processGain));

  return { gainSchedule, bufferCapacity };
}

/**
 * Run one plant simulation tick.
 */
export function plantStep(
  state: SimState,
  acidGrams: number,
  baseGrams: number,
  nutML: number,
  dilPercent: number,
  config: SimConfig,
): void {
  const dt = config.dt;

  // 1. Apply acid dosing (HNO3)
  if (acidGrams > 0) {
    const { deltaDIC, deltaALK } = reagentDeltas(HNO3, acidGrams, config.volumeL);
    state.DIC += deltaDIC;
    state.ALK += deltaALK;
    state.acidTotalGrams += acidGrams;
  }

  // 2. Apply base dosing (KOH)
  if (baseGrams > 0) {
    const { deltaDIC, deltaALK } = reagentDeltas(KOH, baseGrams, config.volumeL);
    state.DIC += deltaDIC;
    state.ALK += deltaALK;
    state.baseTotalGrams += baseGrams;
  }

  // 3. Apply environmental disturbances
  applyDisturbances(state, config, dt);

  // 4. Clamp to physically valid range
  state.DIC = Math.max(0.001, state.DIC);
  state.ALK = Math.max(-2.0, state.ALK);  // ALK can go slightly negative with strong acids

  // 5. Calculate pH from thermodynamics
  state.pH = calcPhForAlkDic(state.ALK, state.DIC, config.tempC, config.salinity);

  // 6. Calculate CO2
  const co2mm = calcCo2OfDic(state.DIC, state.pH, config.tempC, config.salinity);
  state.co2 = co2MmToMg(co2mm);

  // 7. EC model: nutrient addition increases EC, dilution decreases
  const ecPerML = 0.015; // mS/cm per mL of nutrient solution
  state.EC += nutML * ecPerML;
  state.nutTotalML += nutML;

  // Dilution: reduces EC proportionally
  if (dilPercent > 0) {
    const dilML = (dilPercent / 100) * 500 * (dt / 60); // 500 mL/min max
    const dilFraction = dilML / (config.volumeL * 1000);
    state.EC *= (1 - dilFraction);
    // Dilution also reduces ALK and DIC proportionally
    state.ALK *= (1 - dilFraction);
    state.DIC *= (1 - dilFraction);
    state.pH = calcPhForAlkDic(state.ALK, state.DIC, config.tempC, config.salinity);
    state.co2 = co2MmToMg(calcCo2OfDic(state.DIC, state.pH, config.tempC, config.salinity));
  }

  // 8. Update gain scheduling
  const gs = calcGainSchedule(state.DIC, state.ALK, state.pH, config.tempC, config.salinity);
  state.gainSchedule = gs.gainSchedule;
  state.bufferCapacity = gs.bufferCapacity;

  state.tick++;
}
