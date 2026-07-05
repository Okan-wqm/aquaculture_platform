/**
 * FeedingProtocolRateService — SSoT feed-rate calculation from a FeedingProtocol.
 * rate% = feedPercent(weightBand) × feedingMultiplier(tempBand).
 */
import { FeedingProtocolRateService } from '../feeding-protocol-rate.service';
import type { GrowthStageProtocol, TemperatureRange } from '../../entities/feeding-protocol.entity';

const stage = (
  minWeight: number,
  maxWeight: number,
  feedPercent: number,
  weightUnit: GrowthStageProtocol['weightUnit'] = 'gram',
): GrowthStageProtocol => ({
  minWeight,
  maxWeight,
  weightUnit,
  feedPercent,
  schedule: { totalMealsPerDay: 1, schedule: [] },
});

const temp = (
  min: number,
  max: number,
  feedingMultiplier: number,
  unit: TemperatureRange['unit'] = 'celsius',
): TemperatureRange => ({ min, max, unit, feedingMultiplier });

describe('FeedingProtocolRateService', () => {
  const service = new FeedingProtocolRateService();

  const bands: GrowthStageProtocol[] = [stage(0, 5, 8), stage(5, 50, 4), stage(50, 1000, 2)];
  const temps: TemperatureRange[] = [temp(2, 10, 0.5), temp(10, 14, 1.0), temp(14, 20, 0.9)];

  it('multiplies the matched weight band by the matched temperature band', () => {
    const r = service.calculateRate(
      { growthStageProtocols: bands, temperatureRanges: temps },
      30,
      12,
    );
    // 5..50g band → 4%, 10..14°C band → ×1.0
    expect(r).not.toBeNull();
    expect(r!.baseFeedPercent).toBe(4);
    expect(r!.temperatureMultiplier).toBe(1.0);
    expect(r!.feedingRatePercent).toBe(4);
    expect(r!.weightBandExact).toBe(true);
    expect(r!.temperatureBandMatched).toBe(true);
  });

  it('applies a cold-water multiplier below 1.0', () => {
    const r = service.calculateRate(
      { growthStageProtocols: bands, temperatureRanges: temps },
      30,
      6,
    );
    // 4% × 0.5 (2..10°C) = 2%
    expect(r!.feedingRatePercent).toBe(2);
    expect(r!.temperatureMultiplier).toBe(0.5);
  });

  it('defaults the multiplier to 1.0 when temperature is omitted', () => {
    const r = service.calculateRate({ growthStageProtocols: bands, temperatureRanges: temps }, 300);
    expect(r!.baseFeedPercent).toBe(2); // 50..1000g band
    expect(r!.temperatureMultiplier).toBe(1.0);
    expect(r!.temperatureBandMatched).toBe(false);
    expect(r!.feedingRatePercent).toBe(2);
  });

  it('defaults the multiplier to 1.0 when temperature is outside every band', () => {
    const r = service.calculateRate(
      { growthStageProtocols: bands, temperatureRanges: temps },
      30,
      25,
    );
    expect(r!.temperatureMultiplier).toBe(1.0);
    expect(r!.temperatureBandMatched).toBe(false);
  });

  it('clamps weights below the lowest band to the lowest band (never zero feed)', () => {
    const gapBands = [stage(2, 5, 8), stage(5, 50, 4)]; // lowest band starts at 2g
    const r = service.calculateRate(
      { growthStageProtocols: gapBands, temperatureRanges: temps },
      0.5,
      12,
    );
    expect(r!.baseFeedPercent).toBe(8);
    expect(r!.weightBandExact).toBe(false);
  });

  it('clamps weights at/above the highest band to the highest band', () => {
    const r = service.calculateRate(
      { growthStageProtocols: bands, temperatureRanges: temps },
      5000,
      12,
    );
    expect(r!.baseFeedPercent).toBe(2);
    expect(r!.weightBandExact).toBe(false);
  });

  it('converts kg weight bands and fahrenheit temperature bands', () => {
    const kgBands = [stage(0, 1, 5, 'kg')]; // 0..1000g → 5%
    const fTemps = [temp(50, 60, 0.7, 'fahrenheit')]; // ~10..15.5°C
    const r = service.calculateRate(
      { growthStageProtocols: kgBands, temperatureRanges: fTemps },
      300,
      12,
    );
    expect(r!.baseFeedPercent).toBe(5);
    expect(r!.temperatureMultiplier).toBe(0.7); // 12°C is within 50..60°F
    expect(r!.feedingRatePercent).toBe(3.5);
  });

  it('returns null when the protocol has no weight bands (caller falls back)', () => {
    expect(
      service.calculateRate({ growthStageProtocols: [], temperatureRanges: temps }, 30, 12),
    ).toBeNull();
    expect(
      service.calculateRate({ growthStageProtocols: undefined, temperatureRanges: temps }, 30, 12),
    ).toBeNull();
  });
});
