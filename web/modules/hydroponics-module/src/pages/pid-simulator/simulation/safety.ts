/**
 * Safety Systems for PID Simulator
 * - Watchdog timer
 * - Stuck sensor detection
 * - Drift detector
 * - Dose limits
 * - pH range alarm
 */

import { SimState, ALARM_CODES } from './types';

const WATCHDOG_LIMIT = 100;  // max ticks without safety check reset
const STUCK_WINDOW = 50;
const STUCK_STDDEV_THRESH = 0.001;
const DRIFT_HALF_WINDOW = 25;
const DRIFT_RATE_THRESH = 0.1;  // pH/s - actual rate threshold
const MAX_ACID_GRAMS_HOUR = 500;
const MAX_BASE_GRAMS_HOUR = 500;
const MAX_NUT_ML_HOUR = 2000;
const PH_MIN = 3.0;
const PH_MAX = 10.0;
const HOURLY_TICKS = 36000; // 3600s / 0.1s
const DT = 0.1; // tick duration for rate calculations

function stddev(arr: number[]): number {
  if (arr.length < 2) return Infinity;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Run all safety checks. Returns alarm code if triggered.
 */
export function safetyCheck(state: SimState, lastSafetyTick: { value: number }): number {
  // Watchdog: check that we're being called at expected rate
  const ticksSinceLastCheck = state.tick - lastSafetyTick.value;
  lastSafetyTick.value = state.tick;
  if (ticksSinceLastCheck > WATCHDOG_LIMIT && state.tick > WATCHDOG_LIMIT) {
    return ALARM_CODES.WATCHDOG;
  }

  // Update sensor history FIRST (before any early returns from alarm checks)
  state.phHistory.push(state.pH);
  state.ecHistory.push(state.EC);
  if (state.phHistory.length > STUCK_WINDOW) state.phHistory.shift();
  if (state.ecHistory.length > STUCK_WINDOW) state.ecHistory.shift();

  // pH range check
  if (state.pH < PH_MIN || state.pH > PH_MAX) {
    return ALARM_CODES.PH_OUT_OF_RANGE;
  }

  // Dose limits (hourly)
  if (state.tick - state.hourlyResetTick >= HOURLY_TICKS) {
    state.acidTotalGrams = 0;
    state.baseTotalGrams = 0;
    state.nutTotalML = 0;
    state.hourlyResetTick = state.tick;
  }

  if (state.acidTotalGrams > MAX_ACID_GRAMS_HOUR) {
    return ALARM_CODES.DOSE_LIMIT_ACID;
  }
  if (state.baseTotalGrams > MAX_BASE_GRAMS_HOUR) {
    return ALARM_CODES.DOSE_LIMIT_BASE;
  }
  if (state.nutTotalML > MAX_NUT_ML_HOUR) {
    return ALARM_CODES.DOSE_LIMIT_NUT;
  }

  // Stuck sensor detection
  if (state.phHistory.length >= STUCK_WINDOW) {
    if (stddev(state.phHistory) < STUCK_STDDEV_THRESH) {
      if (state.acidPump > 5 || state.basePump > 5) {
        return ALARM_CODES.STUCK_PH;
      }
    }
  }
  if (state.ecHistory.length >= STUCK_WINDOW) {
    if (stddev(state.ecHistory) < STUCK_STDDEV_THRESH) {
      if (state.nutPump > 5) {
        return ALARM_CODES.STUCK_EC;
      }
    }
  }

  // Drift detector (only in IDLE or WAIT states)
  if (
    state.phHistory.length >= STUCK_WINDOW &&
    (state.state === 'IDLE' || state.state === 'EC_WAIT' || state.state === 'PH_WAIT')
  ) {
    const firstHalf = state.phHistory.slice(0, DRIFT_HALF_WINDOW);
    const secondHalf = state.phHistory.slice(DRIFT_HALF_WINDOW);
    if (secondHalf.length >= DRIFT_HALF_WINDOW) {
      const meanShift = Math.abs(mean(secondHalf) - mean(firstHalf));
      // Convert to rate: meanShift is pH difference over DRIFT_HALF_WINDOW * DT seconds
      const timeSpan = DRIFT_HALF_WINDOW * DT; // seconds between window centers
      const driftRate = meanShift / timeSpan;   // pH/s
      const localVar = stddev(secondHalf);
      if (driftRate > DRIFT_RATE_THRESH && localVar < 0.05) {
        return ALARM_CODES.DRIFT;
      }
    }
  }

  return ALARM_CODES.NONE;
}

export function alarmName(code: number): string {
  switch (code) {
    case ALARM_CODES.NONE: return 'None';
    case ALARM_CODES.WATCHDOG: return 'Watchdog';
    case ALARM_CODES.STUCK_PH: return 'Stuck pH Sensor';
    case ALARM_CODES.STUCK_EC: return 'Stuck EC Sensor';
    case ALARM_CODES.DRIFT: return 'pH Drift';
    case ALARM_CODES.DOSE_LIMIT_ACID: return 'Acid Dose Limit';
    case ALARM_CODES.DOSE_LIMIT_BASE: return 'Base Dose Limit';
    case ALARM_CODES.DOSE_LIMIT_NUT: return 'Nutrient Dose Limit';
    case ALARM_CODES.PH_OUT_OF_RANGE: return 'pH Out of Range';
    default: return `Unknown (${code})`;
  }
}
