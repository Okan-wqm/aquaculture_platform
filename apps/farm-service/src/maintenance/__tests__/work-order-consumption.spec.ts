/**
 * compileSparePartDraw — the deterministic, site-bounded draw of a work
 * order's spare parts (V-B1-9 of the B1a-1 verifier round). Pure: the rows it
 * orders are loaded by SparePartLedgerService and proven against Postgres in
 * __tests__/e2e/spare-part-work-order-draw.postgres.spec.ts.
 */
import { BadRequestException } from '@nestjs/common';

import {
  compileSparePartDraw,
  type SparePartDrawCandidate,
} from '../services/work-order-consumption';

const HOME = 'loc-home';

function row(
  over: Partial<SparePartDrawCandidate> & { storageLocationId: string },
): SparePartDrawCandidate {
  return { lotNumber: null, quantity: 1, receivedDate: null, expiryDate: null, ...over };
}

describe('compileSparePartDraw', () => {
  it('takes the home location first, then locations by their oldest received stock', () => {
    // SCENARIO: home holds 1 (newest), store B 4 (received first), store A 4 (received second).
    // EXPECTS: home 1, then B 4, then A 2 for a draw of 7.
    const slices = compileSparePartDraw(
      [
        row({ storageLocationId: 'loc-a', quantity: 4, receivedDate: new Date('2026-02-01') }),
        row({ storageLocationId: 'loc-b', quantity: 4, receivedDate: new Date('2026-01-01') }),
        row({ storageLocationId: HOME, quantity: 1, receivedDate: new Date('2026-05-01') }),
      ],
      7,
      HOME,
      'SP-1',
    );

    expect(slices).toEqual([
      { storageLocationId: HOME, quantity: 1 },
      { storageLocationId: 'loc-b', quantity: 4 },
      { storageLocationId: 'loc-a', quantity: 2 },
    ]);
  });

  it('drains lots inside a location in FEFO order and names each lot', () => {
    // SCENARIO: one store holds lot L2 (expires later), lot L1 (expires first) and an
    // unlotted row. EXPECTS: L1, then L2, then the unlotted row — the order the
    // ledger's unpinned decrement picks, so each slice lands on its planned row.
    const slices = compileSparePartDraw(
      [
        row({ storageLocationId: 'loc-a', quantity: 2 }),
        row({
          storageLocationId: 'loc-a',
          lotNumber: 'L2',
          quantity: 2,
          expiryDate: new Date('2027-06-01'),
        }),
        row({
          storageLocationId: 'loc-a',
          lotNumber: 'L1',
          quantity: 2,
          expiryDate: new Date('2027-01-01'),
        }),
      ],
      5,
      HOME,
      'SP-1',
    );

    expect(slices).toEqual([
      { storageLocationId: 'loc-a', lotNumber: 'L1', quantity: 2 },
      { storageLocationId: 'loc-a', lotNumber: 'L2', quantity: 2 },
      { storageLocationId: 'loc-a', quantity: 1 },
    ]);
  });

  it('fails only when the site total is short, naming the usable total', () => {
    // SCENARIO: 0.1 + 0.2 at the site, 0.4 requested; then exactly 0.3 requested.
    // EXPECTS: 400 with "Available: 0.3"; the exact total is drawn in full (hundredths, no residue).
    const rows = [
      row({ storageLocationId: HOME, quantity: 0.1 }),
      row({ storageLocationId: 'loc-a', quantity: 0.2 }),
    ];
    expect(() => compileSparePartDraw(rows, 0.4, HOME, 'SP-1')).toThrow(BadRequestException);
    expect(() => compileSparePartDraw(rows, 0.4, HOME, 'SP-1')).toThrow('Available: 0.3');
    expect(compileSparePartDraw(rows, 0.3, HOME, 'SP-1')).toEqual([
      { storageLocationId: HOME, quantity: 0.1 },
      { storageLocationId: 'loc-a', quantity: 0.2 },
    ]);
  });
});
