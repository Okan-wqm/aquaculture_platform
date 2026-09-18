import { describe, expect, it } from 'vitest';

import { doSaturationWeiss, o2ConsumptionRateMgLPerHour, o2Demand } from '../do-saturation.js';

/**
 * Weiss (1970) anchors — USGS WRIR 2006-5084 tables (1 atm).
 */
describe('doSaturationWeiss — literature anchors', () => {
  it.each([
    [0, 0, 14.6],
    [5, 0, 12.77],
    [10, 0, 11.29],
    [15, 0, 10.08],
    [20, 0, 9.09],
    [25, 0, 8.26],
    [30, 0, 7.56],
    [10, 35, 9.02],
    [20, 35, 7.38],
  ])('%d °C, %d ppt → ≈ %f mg/L', (t, s, expected) => {
    expect(doSaturationWeiss(t, s)).toBeCloseTo(expected, 1);
  });

  it('falls with temperature and with salinity (Henry’s law)', () => {
    expect(doSaturationWeiss(10)).toBeGreaterThan(doSaturationWeiss(20));
    expect(doSaturationWeiss(20)).toBeGreaterThan(doSaturationWeiss(30));
    expect(doSaturationWeiss(20, 0)).toBeGreaterThan(doSaturationWeiss(20, 35));
  });
});

describe('o2Demand', () => {
  it('splits 10 kg feed into fish 3.5, organic 1.0 and no biofilter demand by default', () => {
    expect(o2Demand({ dailyFeedKg: 10 })).toEqual({
      fishKgPerDay: 3.5,
      biofilterKgPerDay: 0,
      organicKgPerDay: 1,
      totalKgPerDay: 4.5,
    });
  });

  it('adds nitrification at 4.57 kg O2 per kg TAN, defaulting TAN to 1 % of feed', () => {
    const withDefaultTan = o2Demand({ dailyFeedKg: 10, hasBiofilter: true });
    expect(withDefaultTan.biofilterKgPerDay).toBeCloseTo(0.1 * 4.57, 10);
    const withTan = o2Demand({ dailyFeedKg: 10, tanKg: 0.3, hasBiofilter: true });
    expect(withTan.biofilterKgPerDay).toBeCloseTo(0.3 * 4.57, 10);
    expect(withTan.totalKgPerDay).toBeCloseTo(3.5 + 1 + 0.3 * 4.57, 10);
  });
});

describe('o2ConsumptionRateMgLPerHour', () => {
  it('spreads 4.5 kg/day over 24 h in 100 m³ → 1.875 mg/L/h', () => {
    expect(o2ConsumptionRateMgLPerHour(4.5, 100)).toBeCloseTo(1.875, 6);
  });
});
