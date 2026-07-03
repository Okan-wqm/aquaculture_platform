import { describe, expect, it } from 'vitest';

import { getVisibleH2SChartZones, getVisibleNH3ChartZones } from './chart-zones';
import { computeWaterChemistryOutputs } from './compute';
import { buildDeffeyesData } from './deffeyes-data';
import type { WaterChemistryInputs } from './types';

const SAMPLE: WaterChemistryInputs = {
  tempC: 12,
  pH: 7.0,
  salinity: 1,
  alkalinityMg: 80,
  targetpH: 7.5,
  targetAlkalinityMg: 100,
  alkMinMg: 50,
  alkMaxMg: 100,
  tan: 0.5,
  unIonizedNH3: 0.0125,
  co2Toxic: 40,
  h2sUgL: 15,
  h2sLimitUgL: 25,
  caMgL: 400,
  volume: 1,
  fishType: 'Arctic Charr',
  fishSize: '0-5 gram',
  showTarget: true,
};

describe('getVisibleH2SChartZones', () => {
  it('renders full safe domain when the H2S critical pH is absent or below the visible chart', () => {
    expect(getVisibleH2SChartZones(NaN)).toEqual({ safe: { x1: 4, x2: 12.5 }, showCriticalLine: false });
    expect(getVisibleH2SChartZones(3.5)).toEqual({ safe: { x1: 4, x2: 12.5 }, showCriticalLine: false });
  });

  it('renders full danger domain when the H2S critical pH is above the visible chart', () => {
    expect(getVisibleH2SChartZones(12.5)).toEqual({ danger: { x1: 4, x2: 12.5 }, showCriticalLine: true });
  });

  it('splits danger, alert, and safe bands inside the visible chart', () => {
    expect(getVisibleH2SChartZones(6)).toEqual({
      danger: { x1: 4, x2: 6 },
      alert: { x1: 6, x2: 6.2 },
      safe: { x1: 6.2, x2: 12.5 },
      showCriticalLine: true,
    });
  });
});

describe('getVisibleNH3ChartZones (NH₃ toxic ABOVE crit, clamped to 6.0–9.5)', () => {
  it('renders full safe domain when the NH₃ critical pH is absent or above the visible chart', () => {
    // Regression guard: off-domain critical pH must NOT leave the chart unshaded.
    expect(getVisibleNH3ChartZones(NaN)).toEqual({ safe: { x1: 6, x2: 9.5 }, showCriticalLine: false });
    expect(getVisibleNH3ChartZones(10)).toEqual({ safe: { x1: 6, x2: 9.5 }, showCriticalLine: false });
  });

  it('renders full danger domain when the NH₃ critical pH is below the visible chart', () => {
    expect(getVisibleNH3ChartZones(5)).toEqual({ danger: { x1: 6, x2: 9.5 }, showCriticalLine: false });
  });

  it('splits safe, alert, and danger bands inside the visible chart', () => {
    expect(getVisibleNH3ChartZones(8)).toEqual({
      safe: { x1: 6, x2: 7.8 },
      alert: { x1: 7.8, x2: 8 },
      danger: { x1: 8, x2: 9.5 },
      showCriticalLine: true,
    });
  });
});

describe('computeWaterChemistryOutputs (SSoT)', () => {
  it('returns a complete, finite output set for a nominal freshwater input', () => {
    const out = computeWaterChemistryOutputs(SAMPLE, ['Sodium Bicarbonate', 'Sodium Hydroxide']);
    expect(Number.isFinite(out.toxicNH3pH)).toBe(true);
    expect(out.toxicNH3pH).toBeGreaterThan(6);
    expect(out.toxicNH3pH).toBeLessThan(12.5);
    expect(out.currentDIC).toBeGreaterThan(0);
    expect(Number.isFinite(out.toxicH2SpH)).toBe(true);
    expect(Number.isFinite(out.toxicCO2pH)).toBe(true);
    expect(Array.isArray(out.dosingRecipes)).toBe(true);
    expect(['safe', 'alert', 'danger']).toContain(out.uiaStatusLevel);
    expect(['safe', 'alert', 'danger']).toContain(out.h2sStatusLevel);
  });

  it('is deterministic (same inputs → identical outputs)', () => {
    const a = computeWaterChemistryOutputs(SAMPLE, ['Sodium Bicarbonate']);
    const b = computeWaterChemistryOutputs(SAMPLE, ['Sodium Bicarbonate']);
    expect(a).toEqual(b);
  });
});

describe('buildDeffeyesData (SSoT)', () => {
  it('builds pH isolines and a current operating point', () => {
    const d = buildDeffeyesData(SAMPLE, []);
    expect(d.isolines.length).toBeGreaterThan(0);
    expect(d.currentPoint.DIC).toBeGreaterThan(0);
  });

  it('adds a reagent direction line for a single reagent', () => {
    const d = buildDeffeyesData(SAMPLE, ['Sodium Bicarbonate']);
    expect(d.reagentLine).not.toBeNull();
  });
});
