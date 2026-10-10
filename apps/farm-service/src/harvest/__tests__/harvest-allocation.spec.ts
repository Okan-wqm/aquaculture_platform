/**
 * allocateHarvestAcrossTanks — the plan-completion split (FARM-MEDIUM-397).
 *
 * #1670 split the counted quantity proportionally without bounding it by the
 * book stock, so a count above the stock gave a tank more than it held and
 * the completion was refused on every retry. The split now never exceeds a
 * tank's stock, always sums to the request, and a surplus over the total book
 * stock is refused with the figures.
 */
import { BadRequestException } from '@nestjs/common';

import { allocateHarvestAcrossTanks } from '../services/harvest-allocation';

describe('allocateHarvestAcrossTanks', () => {
  it('splits in proportion to each tank stock', () => {
    expect(
      allocateHarvestAcrossTanks(
        [
          { tankId: 'a', quantity: 600 },
          { tankId: 'b', quantity: 200 },
        ],
        400,
      ),
    ).toEqual([
      { tankId: 'a', quantity: 300 },
      { tankId: 'b', quantity: 100 },
    ]);
  });

  it('hands the rounding leftover to the largest fractions and sums exactly', () => {
    const shares = allocateHarvestAcrossTanks(
      [
        { tankId: 'a', quantity: 1 },
        { tankId: 'b', quantity: 1 },
        { tankId: 'c', quantity: 1 },
      ],
      2,
    );
    expect(shares.reduce((sum, share) => sum + share.quantity, 0)).toBe(2);
    expect(shares.every((share) => share.quantity <= 1)).toBe(true);
  });

  it('harvests the whole book stock when the count equals it', () => {
    expect(
      allocateHarvestAcrossTanks(
        [
          { tankId: 'a', quantity: 7 },
          { tankId: 'b', quantity: 3 },
        ],
        10,
      ),
    ).toEqual([
      { tankId: 'a', quantity: 7 },
      { tankId: 'b', quantity: 3 },
    ]);
  });

  it('never gives a tank more than its own stock (multi-tank, uneven)', () => {
    const stocks = [
      { tankId: 'a', quantity: 13 },
      { tankId: 'b', quantity: 7 },
      { tankId: 'c', quantity: 1 },
      { tankId: 'd', quantity: 29 },
    ];
    for (let requested = 1; requested <= 50; requested += 1) {
      const shares = allocateHarvestAcrossTanks(stocks, requested);
      expect(shares.reduce((sum, share) => sum + share.quantity, 0)).toBe(requested);
      for (const share of shares) {
        const stock = stocks.find((s) => s.tankId === share.tankId);
        expect(share.quantity).toBeLessThanOrEqual(stock?.quantity ?? 0);
      }
    }
  });

  it('refuses a count above the total book stock with the figures', () => {
    expect(() =>
      allocateHarvestAcrossTanks(
        [
          { tankId: 'a', quantity: 100 },
          { tankId: 'b', quantity: 50 },
        ],
        151,
      ),
    ).toThrow(
      new BadRequestException(
        "Counted harvest quantity 151 exceeds the batch's book stock of 150 across 2 tank(s). " +
          'Record the missing stock or correct the count before completing the plan.',
      ),
    );
  });

  it('refuses when no tank holds the batch', () => {
    expect(() => allocateHarvestAcrossTanks([], 1)).toThrow(BadRequestException);
  });
});
