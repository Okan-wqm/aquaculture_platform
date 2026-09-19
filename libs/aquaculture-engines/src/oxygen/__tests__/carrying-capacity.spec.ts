import { describe, expect, it } from 'vitest';

import { carryingCapacity } from '../carrying-capacity.js';
import { doSaturationWeiss } from '../do-saturation.js';

describe('carryingCapacity', () => {
  const base = {
    tankVolumeM3: 100,
    temperatureC: 20,
    maxDensityKgM3: 20,
    avgFishWeightG: 500,
    dailyFeedingRatePercent: 2,
  };

  it('takes the smaller of the density and oxygen limits and names the limiting factor', () => {
    const r = carryingCapacity(base);
    // Density: 20 × 100 = 2000 kg. Oxygen: (9.09 − 5) mg/L × 100 m³ → 0.409 kg available;
    // demand 0.02 × (0.35 + 0.10) = 0.009 kg O2/kg/day → 45.4 kg. Oxygen limits.
    expect(r.density.maxBiomassKg).toBe(2000);
    const available = doSaturationWeiss(20) - 5;
    expect(r.oxygen.doAvailableMgL).toBeCloseTo(available, 10);
    expect(r.oxygen.o2PerKgBiomassPerDayKg).toBeCloseTo(0.009, 10);
    expect(r.oxygen.maxBiomassKg).toBeCloseTo((available * 100 * 1000) / 1_000_000 / 0.009, 6);
    expect(r.limitingFactor).toBe('oxygen');
    expect(r.maxBiomassKg).toBe(r.oxygen.maxBiomassKg);
    expect(r.maxFishCount).toBe(Math.floor((r.maxBiomassKg * 1000) / 500));
    expect(r.effectiveMaxDensityKgM3).toBeCloseTo(r.maxBiomassKg / 100, 10);
  });

  it('is density-limited when the feeding rate is tiny, and unbounded by oxygen at 0 % feed', () => {
    const r = carryingCapacity({ ...base, dailyFeedingRatePercent: 0.01, maxDensityKgM3: 5 });
    expect(r.limitingFactor).toBe('density');
    expect(r.maxBiomassKg).toBe(500);
    const noFeed = carryingCapacity({ ...base, dailyFeedingRatePercent: 0 });
    expect(noFeed.oxygen.maxBiomassKg).toBeNull();
    expect(noFeed.limitingFactor).toBe('density');
  });

  it('adds biofilter nitrification demand per kg biomass', () => {
    const r = carryingCapacity({ ...base, hasBiofilter: true });
    expect(r.oxygen.breakdownPerKg.biofilter).toBeCloseTo(0.02 * 0.01 * 4.57, 12);
    expect(r.oxygen.maxBiomassKg as number).toBeLessThan(
      carryingCapacity(base).oxygen.maxBiomassKg as number,
    );
  });

  it('clamps available oxygen at 0 when saturation is below the floor', () => {
    const r = carryingCapacity({ ...base, temperatureC: 45, salinityPpt: 40, minSafeDoMgL: 7 });
    expect(r.oxygen.doAvailableMgL).toBe(0);
    expect(r.maxBiomassKg).toBe(0);
    expect(r.maxFishCount).toBe(0);
  });
});
