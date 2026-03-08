/**
 * PID Simulator Type Definitions
 */

export interface SimConfig {
  volumeL: number;          // Default: 100
  tempC: number;            // Default: 22
  salinity: number;         // Default: 0 (fresh water)
  initialPH: number;        // Default: 6.5
  initialAlkMeq: number;    // Default: 2.0
  initialEC: number;        // Default: 1.3
  targetPH: number;         // Default: 5.8
  targetEC: number;         // Default: 1.8
  dt: number;               // Sim tick duration seconds (default: 0.1)
  speedMultiplier: number;  // Default: 1
}

export interface PIDParams {
  Kp: number;
  Ki: number;
  Kd: number;
  N: number;       // Derivative filter coefficient
  rateMax: number;  // Max output rate of change per second
}

export interface PumpConfig {
  maxFlowRate_mL_min: number;
  concentration_g_L: number;
  onThreshold: number;
  offThreshold: number;
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
  prevPV: number;
  prevDerivative: number;
  output: number;
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

  // FSM
  state: SimStateName;
  stateTimer: number;  // ticks in current state

  // PID states
  phPID: PIDState;
  ecPID: PIDState;

  // Safety
  alarmCode: number;
  alarmLatched: boolean;
  acidTotalGrams: number;
  baseTotalGrams: number;
  nutTotalML: number;
  hourlyResetTick: number;

  // Gain scheduling
  gainSchedule: number;
  bufferCapacity: number;

  // Stuck sensor detector
  phHistory: number[];
  ecHistory: number[];
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
  gainSchedule: number;
  bufferCapacity: number;
  phKp: number;
  phKi: number;
  phKd: number;
  alarmCode: number;
  alarmLatched: boolean;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  volumeL: 100,
  tempC: 22,
  salinity: 0,
  initialPH: 6.5,
  initialAlkMeq: 2.0,
  initialEC: 1.3,
  targetPH: 5.8,
  targetEC: 1.8,
  dt: 0.1,
  speedMultiplier: 1,
};

export const DEFAULT_PH_PID: PIDParams = {
  Kp: 8.0,
  Ki: 0.3,
  Kd: 1.5,
  N: 5,
  rateMax: 50,
};

export const DEFAULT_EC_PID: PIDParams = {
  Kp: 15.0,
  Ki: 1.0,
  Kd: 0.5,
  N: 5,
  rateMax: 50,
};

export const DEFAULT_ACID_PUMP: PumpConfig = {
  maxFlowRate_mL_min: 50,
  concentration_g_L: 100,  // ~10% HNO3 solution
  onThreshold: 2,
  offThreshold: 1,
};

export const DEFAULT_BASE_PUMP: PumpConfig = {
  maxFlowRate_mL_min: 50,
  concentration_g_L: 100,  // ~10% KOH solution
  onThreshold: 2,
  offThreshold: 1,
};

export const DEFAULT_NUT_PUMP: PumpConfig = {
  maxFlowRate_mL_min: 100,
  concentration_g_L: 200,
  onThreshold: 2,
  offThreshold: 1,
};

export const DEFAULT_DIL_PUMP: PumpConfig = {
  maxFlowRate_mL_min: 500,
  concentration_g_L: 0,
  onThreshold: 2,
  offThreshold: 1,
};

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

export function createInitialPIDState(initialPV: number = 0): PIDState {
  return {
    integral: 0,
    prevError: 0,
    prevPV: initialPV,
    prevDerivative: 0,
    output: 0,
  };
}

export function createInitialSimState(
  config: SimConfig,
  chemFns: {
    calcDicOfAlk: (alk: number, pH: number, t: number, s: number) => number;
    calcCo2OfDic: (dic: number, pH: number, t: number, s: number) => number;
    co2MmToMg: (co2: number) => number;
  },
): SimState {
  const DIC = chemFns.calcDicOfAlk(config.initialAlkMeq, config.initialPH, config.tempC, config.salinity);
  const co2mm = chemFns.calcCo2OfDic(DIC, config.initialPH, config.tempC, config.salinity);

  return {
    tick: 0,
    DIC,
    ALK: config.initialAlkMeq,
    pH: config.initialPH,
    EC: config.initialEC,
    co2: chemFns.co2MmToMg(co2mm),
    acidPump: 0,
    basePump: 0,
    nutPump: 0,
    dilPump: 0,
    state: 'IDLE',
    stateTimer: 0,
    phPID: createInitialPIDState(config.initialPH),
    ecPID: createInitialPIDState(config.initialEC),
    alarmCode: 0,
    alarmLatched: false,
    acidTotalGrams: 0,
    baseTotalGrams: 0,
    nutTotalML: 0,
    hourlyResetTick: 0,
    gainSchedule: 1,
    bufferCapacity: 0,
    phHistory: [],
    ecHistory: [],
  };
}
