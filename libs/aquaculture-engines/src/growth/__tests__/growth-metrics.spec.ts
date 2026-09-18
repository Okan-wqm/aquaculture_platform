import { describe, expect, it } from 'vitest';

import {
  biomass,
  feedConversionRatio,
  growthProjection,
  specificGrowthRate,
  transferDensity,
} from '../growth-metrics.js';

describe('specificGrowthRate', () => {
  it('100 g → 150 g in 30 days ≈ 1.3516 %/day (average)', () => {
    const r = specificGrowthRate(100, 150, 30);
    expect(r.sgrPercentPerDay).toBeCloseTo(1.3516, 4);
    expect(r.rating).toBe('average');
    expect(r.weightGainG).toBe(50);
    expect(r.weightGainPercent).toBe(50);
    expect(r.doublingTimeDays).toBeCloseTo(Math.log(2) / 0.013516, 1);
  });

  it('no growth → 0 %/day, poor, no doubling time', () => {
    const r = specificGrowthRate(100, 100, 30);
    expect(r.sgrPercentPerDay).toBeCloseTo(0, 10);
    expect(r.rating).toBe('poor');
    expect(r.doublingTimeDays).toBeNull();
  });

  it('rates >3 excellent, ≥2 good', () => {
    expect(specificGrowthRate(10, 30, 30).rating).toBe('excellent');
    expect(specificGrowthRate(100, 185, 30).rating).toBe('good');
  });
});

describe('feedConversionRatio', () => {
  it('1200 kg feed / 1000 kg gain = 1.2 → salmon at industry average (good)', () => {
    const r = feedConversionRatio(1200, 1000, 'Salmon');
    expect(r.fcr).toBeCloseTo(1.2, 10);
    expect(r.industryAverageFcr).toBe(1.2);
    expect(r.deviationFromIndustryPercent).toBeCloseTo(0, 10);
    expect(r.efficiency).toBe('good');
    expect(r.feedSavingsKgIfImproved01).toBeCloseTo(100, 10);
  });

  it('unknown species uses the 1.5 default; ≤85 % of it is excellent, >120 % poor', () => {
    expect(feedConversionRatio(1.2, 1).efficiency).toBe('excellent');
    expect(feedConversionRatio(1.9, 1, 'unicorn').efficiency).toBe('poor');
    expect(feedConversionRatio(1.9, 1, 'unicorn').industryAverageFcr).toBe(1.5);
  });
});

describe('biomass', () => {
  it('quantity × weight, with density status when a volume is given', () => {
    expect(biomass(10_000, 250)).toEqual({
      biomassKg: 2500,
      densityKgM3: null,
      densityStatus: null,
    });
    expect(biomass(10_000, 250, 100)).toEqual({
      biomassKg: 2500,
      densityKgM3: 25,
      densityStatus: 'high',
    });
    expect(biomass(1000, 250, 100).densityStatus).toBe('low');
    expect(biomass(10_000, 250, 50).densityStatus).toBe('excessive');
  });
});

describe('growthProjection', () => {
  it('grows exponentially at the SGR, applies daily mortality and reaches the target on the analytical day', () => {
    const r = growthProjection({
      currentWeightG: 100,
      currentQuantity: 1000,
      sgrPercentPerDay: 1,
      targetWeightG: 200,
      mortalityRatePercent: 0.1,
    });
    // ln 2 / 0.01 = 69.3 days → 70-day horizon, target met on day 70.
    expect(r.estimatedHarvestDays).toBeCloseTo(69.31, 1);
    expect(r.simulationDays).toBe(70);
    expect(r.targetReachedDay).toBe(70);
    expect(r.final.avgWeightG).toBeCloseTo(100 * Math.exp(0.7), 6);
    expect(r.final.quantity).toBeCloseTo(1000 * Math.pow(0.999, 70), 6);
    expect(r.survivalRatePercent).toBeCloseTo(100 * Math.pow(0.999, 70), 6);
    expect(r.samples[0]).toMatchObject({
      day: 0,
      avgWeightG: 100,
      quantity: 1000,
      cumulativeFeedKg: 0,
    });
    expect(r.samples.map((s) => s.day)).toEqual([0, 7, 14, 21, 28, 35, 42, 49, 56, 63, 70]);
  });

  it('defaults to 90 days without a target, caps at 365, and feeds 2 % BW/day', () => {
    expect(
      growthProjection({ currentWeightG: 100, currentQuantity: 10, sgrPercentPerDay: 1 })
        .simulationDays,
    ).toBe(90);
    const long = growthProjection({
      currentWeightG: 100,
      currentQuantity: 10,
      sgrPercentPerDay: 1,
      projectionDays: 1000,
    });
    expect(long.simulationDays).toBe(365);
    const r = growthProjection({
      currentWeightG: 100,
      currentQuantity: 1000,
      sgrPercentPerDay: 0,
      projectionDays: 1,
    });
    // day 1 feed = 100 kg biomass × 2 % = 2 kg
    expect(r.final.cumulativeFeedKg).toBeCloseTo(2, 10);
  });
});

describe('transferDensity', () => {
  const source = { volumeM3: 100, currentBiomassKg: 1500, maxDensityKgM3: 20 };
  const destination = { volumeM3: 50, currentBiomassKg: 200, maxDensityKgM3: 20 };

  it('moves biomass and reports before/after loads and the safe maximum', () => {
    const r = transferDensity(source, destination, 500);
    expect(r.source.before).toEqual({ biomassKg: 1500, densityKgM3: 15, utilizationPercent: 75 });
    expect(r.source.after).toEqual({ biomassKg: 1000, densityKgM3: 10, utilizationPercent: 50 });
    expect(r.destination.after).toEqual({
      biomassKg: 700,
      densityKgM3: 14,
      utilizationPercent: 70,
    });
    expect(r.maxSafeTransferKg).toBe(800);
    expect(r.feasible).toBe(true);
  });

  it('flags an over-max destination with the excess, and an insufficient source', () => {
    const over = transferDensity(source, destination, 900);
    expect(over.destinationOverMax).toBe(true);
    expect(over.destinationExcessKg).toBeCloseTo(100, 10);
    expect(over.feasible).toBe(false);
    const short = transferDensity({ ...source, currentBiomassKg: 100 }, destination, 300);
    expect(short.sourceInsufficient).toBe(true);
    expect(short.source.after.biomassKg).toBe(0);
    expect(short.maxSafeTransferKg).toBe(100);
  });
});
