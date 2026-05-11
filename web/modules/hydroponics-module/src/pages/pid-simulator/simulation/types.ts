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

  // Target setpoints (midpoint of range)
  targetEC: number;
  targetPH: number;

  // Reagent selection
  acidReagent: string;
  baseReagent: string;
  acidConc: number;        // g/L
  baseConc: number;        // g/L

  // Freshwater (makeup water) properties
  freshwaterALK: number;   // meq/L - incoming water alkalinity
  freshwaterPH: number;    // pH of incoming water (determines dissolved CO2)

}

export type SimStateName =
  | 'IDLE'
  | 'EC'
  | 'EC_WAIT'
  | 'CHEM_DT'
  | 'PH'
  | 'PH_WAIT'
  | 'DILUTE'
  | 'ALARM';

export interface PIDState {
  integral: number;
  prevError: number;
  prevMeasurement?: number;
  prevPV: number;
  prevDerivative: number;
  output: number;
}

export interface PIDParams {
  Kp: number;
  Ki: number;
  Kd: number;
  N: number;
  rateMax: number;
}

export interface PumpConfig {
  maxFlowRate_mL_min: number;
  concentration_g_L: number;
}

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
  stateTimer: number;

  // Alarm
  alarmLatched: boolean;

  // PID state for pH control
  phPID: PIDState;

  // Sensor history for safety checks
  phHistory: number[];
  ecHistory: number[];
  hourlyResetTick: number;

  // Totals (for display)
  acidTotalGrams: number;
  baseTotalGrams: number;
  nutTotalML: number;

  // CO2 equilibrium tracking
  co2Eq: number;      // atmospheric equilibrium CO2 (mg/L)

  // Equilibrium pH (pH when CO2 reaches atmospheric equilibrium)
  eqPH: number;

  // Gain scheduling
  gainSchedule: number;
  bufferCapacity: number;
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
  eqPH: number;
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
  targetEC: 1.8,
  targetPH: 5.8,
  dt: 0.1,
  speedMultiplier: 1,
  acidReagent: 'Nitric Acid',
  baseReagent: 'Potassium Hydroxide',
  acidConc: 100,
  baseConc: 100,
  freshwaterALK: 3.0,    // typical well water
  freshwaterPH: 7.2,     // typical well water (may have high CO₂)
};

// Pump max flow rates (mL/min)
export const ACID_PUMP_MAX = 50;
export const BASE_PUMP_MAX = 50;
export const NUT_PUMP_MAX = 100;
export const DIL_PUMP_MAX = 500;

// Atmospheric CO2 equilibrium (Henry's law, ~415 ppm, 22 C)
// KH ~ 0.034 mol/(L atm), pCO2 ~ 415e-6 atm -> ~0.014 mmol/L -> ~0.6 mg/L
export const CO2_EQ_MMOL = 0.014;

// Alarm codes for safety system
export const ALARM_CODES = {
  NONE: 0,
  WATCHDOG: 1,
  STUCK_PH: 2,
  STUCK_EC: 3,
  DRIFT: 4,
  DOSE_LIMIT_ACID: 5,
  DOSE_LIMIT_BASE: 6,
  DOSE_LIMIT_NUT: 7,
  PH_OUT_OF_RANGE: 8,
} as const;

/** Create initial PID state with measurement as starting point */
export function createInitialPIDState(measurement: number): PIDState {
  return {
    integral: 0,
    prevError: 0,
    prevMeasurement: measurement,
    prevPV: measurement,
    prevDerivative: 0,
    output: 0,
  };
}
