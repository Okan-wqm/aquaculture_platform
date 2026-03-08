/**
 * Dosing Simulator Type Definitions
 * Range-based control: calculate exact dose when outside target range.
 */

export interface SimConfig {
  volumeL: number;
  tempC: number;
  salinity: number;
  initialPH: number;
  initialAlkMeq: number;
  initialEC: number;
  phMin: number;
  phMax: number;
  ecMin: number;
  ecMax: number;
  dt: number;
  speedMultiplier: number;

  // Freshwater (makeup water) properties
  freshwaterALK: number;   // meq/L - incoming water alkalinity
  freshwaterPH: number;    // pH of incoming water (determines dissolved CO₂)

}

export type SimStateName = 'IDLE' | 'DOSING_EC' | 'DOSING_PH' | 'DILUTE';

export interface SimState {
  tick: number;
  DIC: number;        // mmol/L
  ALK: number;        // meq/L
  pH: number;         // NBS
  EC: number;         // mS/cm
  co2: number;        // mg/L

  // Pump outputs (0-100%)
  acidPump: number;
  basePump: number;
  nutPump: number;
  dilPump: number;

  // Current controller state
  state: SimStateName;

  // Totals (for display)
  acidTotalGrams: number;
  baseTotalGrams: number;
  nutTotalML: number;

  // CO₂ equilibrium tracking
  co2Eq: number;      // atmospheric equilibrium CO₂ (mg/L)
}

export interface SimSnapshot {
  tick: number;
  DIC: number;
  ALK: number;
  pH: number;
  EC: number;
  co2: number;
  acidPump: number;
  basePump: number;
  nutPump: number;
  dilPump: number;
  state: SimStateName;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  volumeL: 100,
  tempC: 22,
  salinity: 0,
  initialPH: 6.5,
  initialAlkMeq: 2.0,
  initialEC: 1.3,
  phMin: 5.6,
  phMax: 6.0,
  ecMin: 1.6,
  ecMax: 2.0,
  dt: 0.1,
  speedMultiplier: 1,
  freshwaterALK: 3.0,    // typical well water
  freshwaterPH: 7.2,     // typical well water (may have high CO₂)
};

// Pump max flow rates (mL/min)
export const ACID_PUMP_MAX = 50;
export const BASE_PUMP_MAX = 50;
export const NUT_PUMP_MAX = 100;
export const DIL_PUMP_MAX = 500;

// Reagent concentrations (g/L)
export const ACID_CONC = 100;  // ~10% HNO3
export const BASE_CONC = 100;  // ~10% KOH

// Atmospheric CO₂ equilibrium (Henry's law, ~415 ppm, 22°C)
// KH ≈ 0.034 mol/(L·atm), pCO₂ ≈ 415e-6 atm → ~0.014 mmol/L → ~0.6 mg/L
export const CO2_EQ_MMOL = 0.014;
