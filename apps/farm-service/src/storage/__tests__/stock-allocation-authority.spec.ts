import { BadRequestException } from '@nestjs/common';

import {
  compileFeedAllocation,
  type FeedAllocationCandidate,
} from '../services/stock-movement.service';

const candidate = (
  inventoryId: string,
  siteId: string,
  lotNumber: string,
  quantityKg: number,
): FeedAllocationCandidate => ({
  inventoryId,
  storageLocationId: `location-${inventoryId}`,
  siteId,
  lotNumber,
  quantityKg,
  expiryDate: null,
  receivedDate: null,
});

describe('compileFeedAllocation', () => {
  it('cascades across FEFO rows instead of rejecting on the first remainder lot', () => {
    const result = compileFeedAllocation(
      [candidate('a', 'site-a', 'LOT-A', 0.3), candidate('b', 'site-a', 'LOT-B', 3000)],
      150,
      'site-a',
    );

    expect(result.slices).toEqual([
      expect.objectContaining({ inventoryId: 'a', quantityKg: 0.3 }),
      expect.objectContaining({ inventoryId: 'b', quantityKg: 149.7 }),
    ]);
    expect(result.usedSiteFallback).toBe(false);
    expect(result.poolTotalKg).toBe(3000.3);
  });

  it('keeps canonical FEFO order inside each site partition and reports cross-site fallback', () => {
    const result = compileFeedAllocation(
      [
        candidate('remote-first', 'site-b', 'REMOTE-EARLY', 50),
        candidate('local-first', 'site-a', 'LOCAL-LATE', 40),
        candidate('remote-second', 'site-b', 'REMOTE-LATE', 50),
      ],
      70,
      'site-a',
    );

    expect(result.slices.map((slice) => [slice.inventoryId, slice.quantityKg])).toEqual([
      ['local-first', 40],
      ['remote-first', 30],
    ]);
    expect(result.usedSiteFallback).toBe(true);
  });

  it('fails closed before producing slices when the complete pool is insufficient', () => {
    expect(() =>
      compileFeedAllocation(
        [candidate('a', 'site-a', 'LOT-A', 0.3), candidate('b', 'site-a', 'LOT-B', 10)],
        150,
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects quantities that cannot be represented by numeric(15,2)', () => {
    expect(() => compileFeedAllocation([candidate('a', 'site-a', 'LOT-A', 10)], 0.001)).toThrow(
      'at most two decimal places',
    );
  });
});
