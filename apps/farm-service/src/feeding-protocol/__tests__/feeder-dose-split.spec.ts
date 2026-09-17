/**
 * Doz bölme aritmetiğinin kanıtı.
 *
 * WHY it is tested this hard: a percentage split that loses a gram a day is
 * invisible for months. The parts must reconstitute the whole EXACTLY, and the
 * same input must always produce the same output — plan generation reruns, and a
 * feeder whose kilograms wobble between runs is unexplainable at the barn.
 */
import { splitDoseByShare, type FeederDoseShare } from '../services/feeder-dose-split.service';

function share(feederEquipmentId: string, doseSharePercent: number): FeederDoseShare {
  return {
    feederEquipmentId,
    feederName: `Feeder ${feederEquipmentId}`,
    feederCode: feederEquipmentId.toUpperCase(),
    doseSharePercent,
  };
}

describe('splitDoseByShare', () => {
  it('splits a dose across two feeders by their shares', () => {
    const allocations = splitDoseByShare([share('a', 60), share('b', 40)], 100);

    expect(allocations.map((allocation) => allocation.kg)).toEqual([60, 40]);
    expect(allocations[0]!.feederEquipmentId).toBe('a');
  });

  it('keeps the parts summing to the whole when the split does not divide evenly', () => {
    // 10 kg across three equal feeders: naive rounding yields 3.333 × 3 = 9.999
    // and loses a gram every single day.
    const allocations = splitDoseByShare(
      [share('a', 33.333), share('b', 33.333), share('c', 33.334)],
      10,
    );

    const total = allocations.reduce((sum, allocation) => sum + allocation.kg, 0);
    expect(Number(total.toFixed(3))).toBe(10);
    for (const allocation of allocations) {
      expect(allocation.kg).toBeGreaterThan(3.33);
      expect(allocation.kg).toBeLessThan(3.34);
    }
  });

  it('reconstitutes the whole for a range of awkward doses', () => {
    const shares = [share('a', 55.5), share('b', 24.25), share('c', 20.25)];

    for (const totalKg of [0.001, 0.7, 1, 7.777, 13.331, 100.005, 1234.567]) {
      const allocations = splitDoseByShare(shares, totalKg);
      const total = allocations.reduce((sum, allocation) => sum + allocation.kg, 0);
      expect(Number(total.toFixed(3))).toBe(Number(totalKg.toFixed(3)));
    }
  });

  it('is deterministic — the same input always allocates the same grams', () => {
    const shares = [share('a', 33.333), share('b', 33.333), share('c', 33.334)];

    const first = splitDoseByShare(shares, 10).map((allocation) => allocation.kg);
    const second = splitDoseByShare(shares, 10).map((allocation) => allocation.kg);

    expect(second).toEqual(first);
  });

  it('gives the whole dose to a single feeder', () => {
    expect(splitDoseByShare([share('a', 100)], 12.5)[0]!.kg).toBe(12.5);
  });

  it('returns nothing for a unit with no active feeder (hand-fed, not an error)', () => {
    expect(splitDoseByShare([], 25)).toEqual([]);
  });
});
