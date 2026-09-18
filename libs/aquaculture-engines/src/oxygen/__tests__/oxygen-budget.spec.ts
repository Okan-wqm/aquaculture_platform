import { describe, expect, it } from 'vitest';

import { doSaturationWeiss } from '../do-saturation.js';
import { oxygenBalanceStatus, oxygenBudget, saturationStatus } from '../oxygen-budget.js';

describe('oxygenBudget', () => {
  const base = {
    temperatureC: 20,
    salinityPpt: 0,
    dailyFeedKg: 10,
    tankVolumeM3: 100,
    currentDoMgL: 8,
  };

  it('derives saturation %, uniform demand rate and hours-to-floor from the anchors', () => {
    const r = oxygenBudget(base);
    expect(r.doSaturationMgL).toBeCloseTo(9.09, 1);
    expect(r.saturationPercent).toBeCloseTo((8 / doSaturationWeiss(20)) * 100, 6);
    expect(r.saturationStatus).toBe('optimal');
    expect(r.demand.totalKgPerDay).toBeCloseTo(4.5, 10);
    expect(r.consumptionRateMgLPerHour).toBeCloseTo(1.875, 6);
    // (8 − 5) / 1.875 = 1.6 h → deficit
    expect(r.hoursToMinDo).toBeCloseTo(1.6, 6);
    expect(r.balanceStatus).toBe('deficit');
    expect(r.doChangePerDegreeC).toBeLessThan(0);
    expect(r.doChangePerDegreeC).toBeCloseTo(-0.17, 1);
  });

  it('reports null hours and critical balance when already at or below the floor', () => {
    const r = oxygenBudget({ ...base, currentDoMgL: 4.5 });
    expect(r.hoursToMinDo).toBeNull();
    expect(r.balanceStatus).toBe('critical');
    expect(r.saturationStatus).toBe('critical');
  });

  it('finds the first 0.5 °C step where saturation drops below the floor (seawater); none for fresh water ≤ 50 °C', () => {
    const sea = oxygenBudget({ ...base, salinityPpt: 35 });
    expect(sea.criticalTemperatureC).not.toBeNull();
    const t = sea.criticalTemperatureC as number;
    expect(doSaturationWeiss(t, 35)).toBeLessThan(5);
    expect(doSaturationWeiss(t - 0.5, 35)).toBeGreaterThanOrEqual(5);
    // Fresh water still holds ≈5.5 mg/L at 50 °C, so no critical temperature within the scan.
    expect(oxygenBudget(base).criticalTemperatureC).toBeNull();
  });

  it('estimates a CSTR steady state when an exchange flow is given', () => {
    const r = oxygenBudget({ ...base, waterFlowM3h: 50 });
    expect(r.waterExchange).not.toBeNull();
    const w = r.waterExchange as NonNullable<typeof r.waterExchange>;
    expect(w.exchangeRatePerHour).toBeCloseTo(0.5, 10);
    expect(w.exchangesPerDay).toBeCloseTo(12, 10);
    // DO_sat − 1.875 / 0.5
    expect(w.steadyStateDoMgL).toBeCloseTo(doSaturationWeiss(20) - 3.75, 6);
    expect(w.steadyStateAdequate).toBe(true);
    expect(oxygenBudget({ ...base, waterFlowM3h: 0 }).waterExchange).toBeNull();
  });

  it('an unfed tank above the floor is a surplus (no demand), not critical; at/below the floor it is critical', () => {
    const unfed = oxygenBudget({ ...base, dailyFeedKg: 0 });
    expect(unfed.demand.totalKgPerDay).toBe(0);
    expect(unfed.hoursToMinDo).toBeNull();
    expect(unfed.balanceStatus).toBe('surplus');
    expect(oxygenBudget({ ...base, dailyFeedKg: 0, currentDoMgL: 5 }).balanceStatus).toBe(
      'critical',
    );
  });

  it('honours an explicit minimum-DO override', () => {
    const r = oxygenBudget({ ...base, minSafeDoMgL: 6 });
    expect(r.minSafeDoMgL).toBe(6);
    expect(r.hoursToMinDo).toBeCloseTo((8 - 6) / 1.875, 6);
  });
});

describe('status thresholds', () => {
  it('saturation: >105 supersaturated, ≥80 optimal, ≥50 low, else critical', () => {
    expect(saturationStatus(105.1)).toBe('supersaturated');
    expect(saturationStatus(105)).toBe('optimal');
    expect(saturationStatus(80)).toBe('optimal');
    expect(saturationStatus(79.9)).toBe('low');
    expect(saturationStatus(50)).toBe('low');
    expect(saturationStatus(49.9)).toBe('critical');
  });

  it('balance: >24 h surplus, ≥12 balanced, else deficit; null → critical below the floor, surplus above it', () => {
    expect(oxygenBalanceStatus(24.1, true)).toBe('surplus');
    expect(oxygenBalanceStatus(24, true)).toBe('balanced');
    expect(oxygenBalanceStatus(12, true)).toBe('balanced');
    expect(oxygenBalanceStatus(11.9, true)).toBe('deficit');
    expect(oxygenBalanceStatus(null, false)).toBe('critical');
    expect(oxygenBalanceStatus(null, true)).toBe('surplus');
  });
});
