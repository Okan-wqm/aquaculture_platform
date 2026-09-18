/**
 * Oxygen budget — saturation, demand, time-to-minimum and temperature
 * sensitivity for one tank. Pure arithmetic; presentation (rounding, prose)
 * belongs to the caller.
 *
 * REFERENCES: Weiss (1970); Colt (2006); Timmons & Ebeling (2013);
 * minimum safe DO 5 mg/L — Boyd & Tucker (1998), FAO Technical Paper 600.
 */
import {
  doSaturationWeiss,
  o2ConsumptionRateMgLPerHour,
  o2Demand,
  type O2Demand,
} from './do-saturation.js';

/** Minimum safe dissolved oxygen for most cultured species (mg/L). */
export const MIN_SAFE_DO_MG_L = 5.0;

export type SaturationStatus = 'supersaturated' | 'optimal' | 'low' | 'critical';
export type OxygenBalanceStatus = 'surplus' | 'balanced' | 'deficit' | 'critical';

export interface OxygenBudgetInput {
  temperatureC: number;
  salinityPpt?: number;
  dailyFeedKg: number;
  tankVolumeM3: number;
  currentDoMgL: number;
  hasBiofilter?: boolean;
  /** Fresh-water exchange flow (m³/h); enables the steady-state estimate. */
  waterFlowM3h?: number;
  /** Override of the 5 mg/L floor. */
  minSafeDoMgL?: number;
}

export interface WaterExchangeEstimate {
  exchangeRatePerHour: number;
  exchangesPerDay: number;
  /** CSTR steady state assuming inflow at saturation: DO_sat − rate/exchange, floored at 0. */
  steadyStateDoMgL: number;
  steadyStateAdequate: boolean;
}

export interface OxygenBudgetResult {
  doSaturationMgL: number;
  saturationPercent: number;
  saturationStatus: SaturationStatus;
  minSafeDoMgL: number;
  demand: O2Demand;
  consumptionRateMgLPerHour: number;
  /** Hours until DO reaches the floor with no aeration; null when already at/below it or no demand. */
  hoursToMinDo: number | null;
  balanceStatus: OxygenBalanceStatus;
  /** d(DO_sat)/dT by central difference (±0.5 °C), mg/L per °C (negative). */
  doChangePerDegreeC: number;
  /** First temperature (0.5 °C steps, ≤50 °C) where saturation drops below the floor; null if none. */
  criticalTemperatureC: number | null;
  waterExchange: WaterExchangeEstimate | null;
}

export function saturationStatus(saturationPercent: number): SaturationStatus {
  if (saturationPercent > 105) return 'supersaturated';
  if (saturationPercent >= 80) return 'optimal';
  if (saturationPercent >= 50) return 'low';
  return 'critical';
}

export function oxygenBalanceStatus(hoursToMinDo: number | null): OxygenBalanceStatus {
  if (hoursToMinDo === null) return 'critical';
  if (hoursToMinDo > 24) return 'surplus';
  if (hoursToMinDo >= 12) return 'balanced';
  return 'deficit';
}

export function oxygenBudget(input: OxygenBudgetInput): OxygenBudgetResult {
  const salinity = input.salinityPpt ?? 0;
  const minSafe = input.minSafeDoMgL ?? MIN_SAFE_DO_MG_L;

  const doSaturationMgL = doSaturationWeiss(input.temperatureC, salinity);
  const saturationPercent = (input.currentDoMgL / doSaturationMgL) * 100;

  const demand = o2Demand({ dailyFeedKg: input.dailyFeedKg, hasBiofilter: input.hasBiofilter });
  const consumptionRateMgLPerHour = o2ConsumptionRateMgLPerHour(
    demand.totalKgPerDay,
    input.tankVolumeM3,
  );

  const hoursToMinDo =
    input.currentDoMgL > minSafe && consumptionRateMgLPerHour > 0
      ? (input.currentDoMgL - minSafe) / consumptionRateMgLPerHour
      : null;

  const doChangePerDegreeC =
    doSaturationWeiss(input.temperatureC + 0.5, salinity) -
    doSaturationWeiss(input.temperatureC - 0.5, salinity);

  let criticalTemperatureC: number | null = null;
  for (let t = input.temperatureC; t <= 50; t += 0.5) {
    if (doSaturationWeiss(t, salinity) < minSafe) {
      criticalTemperatureC = t;
      break;
    }
  }

  let waterExchange: WaterExchangeEstimate | null = null;
  if (input.waterFlowM3h !== undefined && input.waterFlowM3h > 0) {
    const exchangeRatePerHour = input.waterFlowM3h / input.tankVolumeM3;
    const steadyState = doSaturationMgL - consumptionRateMgLPerHour / exchangeRatePerHour;
    waterExchange = {
      exchangeRatePerHour,
      exchangesPerDay: exchangeRatePerHour * 24,
      steadyStateDoMgL: Math.max(0, steadyState),
      steadyStateAdequate: steadyState >= minSafe,
    };
  }

  return {
    doSaturationMgL,
    saturationPercent,
    saturationStatus: saturationStatus(saturationPercent),
    minSafeDoMgL: minSafe,
    demand,
    consumptionRateMgLPerHour,
    hoursToMinDo,
    balanceStatus: oxygenBalanceStatus(hoursToMinDo),
    doChangePerDegreeC,
    criticalTemperatureC,
    waterExchange,
  };
}
