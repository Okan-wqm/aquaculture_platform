import { describe, expect, it } from 'vitest';

import { fractionNH3 } from '../../water-chemistry/ammonia-calc.js';
import { feedingImpact, feedingRateStatus, tanCoefficientFor } from '../feeding-impact.js';

describe('feedingImpact', () => {
  const base = {
    feedKg: 10,
    biomassKg: 500,
    tankVolumeM3: 100,
    temperatureC: 20,
    currentPH: 7.5,
  };

  it('uses the species TAN coefficient, spreads it over the tank and derives NH3 from the ammonia engine', () => {
    const r = feedingImpact({ ...base, speciesCode: 'trout' });
    expect(r.tan.method).toBe('species_coefficient');
    expect(r.tan.coefficientKgPerKgFeed).toBe(0.028);
    expect(r.tan.producedKg).toBeCloseTo(0.28, 10);
    // 0.28 kg in 100 m³ = 2.8 mg/L
    expect(r.tan.increaseMgL).toBeCloseTo(2.8, 10);
    expect(r.tan.peakMgL).toBeCloseTo(2.8, 10);
    expect(r.ammonia.nh3Fraction).toBeCloseTo(fractionNH3(7.5, 20, 0), 12);
    expect(r.ammonia.peakNh3MgL).toBeCloseTo(2.8 * fractionNH3(7.5, 20, 0), 12);
    expect(r.ammonia.limitMgL).toBe(0.012);
    expect(r.ammonia.criticalPH).not.toBeNull();
    expect(r.ammonia.safetyMarginPH).toBeCloseTo((r.ammonia.criticalPH as number) - 7.5, 12);
  });

  it('prefers the protein-based TAN yield when a protein % is given', () => {
    const r = feedingImpact({ ...base, feedProteinPercent: 42 });
    expect(r.tan.method).toBe('protein_based');
    expect(r.tan.coefficientKgPerKgFeed).toBeCloseTo(0.092 * 0.42, 12);
    expect(tanCoefficientFor('salmon', 0)).toEqual({
      method: 'species_coefficient',
      coefficientKgPerKgFeed: 0.028,
    });
  });

  it('adds current TAN to the peak and feeds the produced TAN into biofilter oxygen demand', () => {
    const r = feedingImpact({ ...base, currentTanMgL: 1, hasBiofilter: true });
    expect(r.tan.peakMgL).toBeCloseTo(1 + 3, 10); // default 0.03 × 10 kg = 0.3 kg → 3 mg/L
    expect(r.oxygen.biofilterKgPerDay).toBeCloseTo(0.3 * 4.57, 10);
    expect(r.oxygen.totalKgPerDay).toBeCloseTo(3.5 + 1 + 0.3 * 4.57, 10);
    expect(r.oxygen.consumptionRateMgLPerHour).toBeCloseTo(
      (r.oxygen.totalKgPerDay * 1_000_000) / (24 * 100_000),
      10,
    );
  });

  it('classifies the feeding rate as % of body weight', () => {
    expect(feedingImpact(base).feedingRate).toEqual({ ratePercentBw: 2, status: 'normal' });
    expect(feedingRateStatus(0.4)).toBe('low');
    expect(feedingRateStatus(4)).toBe('high');
    expect(feedingRateStatus(6)).toBe('overfeeding');
  });

  it('reports no critical pH when the TAN load cannot reach the limit', () => {
    const r = feedingImpact({ ...base, feedKg: 0.0001, tankVolumeM3: 10_000 });
    expect(r.ammonia.criticalPH).toBeNull();
    expect(r.ammonia.safetyMarginPH).toBeNull();
    expect(r.ammonia.status).toBe('safe');
  });
});
