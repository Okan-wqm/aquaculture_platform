import {
  GrowthMeasurement,
  GrowthPerformance,
  GrowthComparison,
} from '../entities/growth-measurement.entity';

/**
 * evaluatePerformance() signed-band regression guard (ORPHAN-MEDIUM-268). The
 * prior Math.abs(variancePercent) conflated under- and over-performance, so a
 * batch 15% BELOW theoretical scored the same band as 15% ABOVE. These cases
 * pin the signed bands so the bug cannot return.
 */
function gradeFor(variancePercent: number): GrowthPerformance | undefined {
  const measurement = new GrowthMeasurement();
  const comparison: GrowthComparison = {
    theoreticalWeight: 100,
    actualWeight: 100 + variancePercent,
    variance: variancePercent,
    variancePercent,
  };
  measurement.growthComparison = comparison;
  measurement.evaluatePerformance();
  return measurement.performance;
}

describe('GrowthMeasurement.evaluatePerformance — signed bands', () => {
  it('grades on/over target as good, well over as excellent', () => {
    expect(gradeFor(15)).toBe(GrowthPerformance.EXCELLENT); // >10% over
    expect(gradeFor(10)).toBe(GrowthPerformance.GOOD); // +10% over (boundary)
    expect(gradeFor(3)).toBe(GrowthPerformance.GOOD);
    expect(gradeFor(0)).toBe(GrowthPerformance.GOOD); // on target
  });

  it('degrades under-target by magnitude', () => {
    expect(gradeFor(-3)).toBe(GrowthPerformance.AVERAGE); // 3% under
    expect(gradeFor(-5)).toBe(GrowthPerformance.AVERAGE); // -5 boundary
    expect(gradeFor(-8)).toBe(GrowthPerformance.BELOW_AVERAGE); // 8% under
    expect(gradeFor(-15)).toBe(GrowthPerformance.BELOW_AVERAGE); // -15 boundary
    expect(gradeFor(-20)).toBe(GrowthPerformance.POOR); // >15% under
  });

  it('does NOT conflate under- and over-performance (the Math.abs bug)', () => {
    expect(gradeFor(8)).toBe(GrowthPerformance.GOOD);
    expect(gradeFor(-8)).toBe(GrowthPerformance.BELOW_AVERAGE);
    expect(gradeFor(8)).not.toBe(gradeFor(-8));
    expect(gradeFor(15)).not.toBe(gradeFor(-15)); // the old abs() scored these the same
  });

  it('is a no-op without a growth comparison', () => {
    const measurement = new GrowthMeasurement();
    measurement.evaluatePerformance();
    expect(measurement.performance).toBeUndefined();
  });
});
