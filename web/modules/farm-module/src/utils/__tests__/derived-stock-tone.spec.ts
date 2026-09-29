/**
 * derivedStockTone — stock tables colour a cell from the backend-derived
 * status, never from a client-side quantity comparison (FARM-HIGH-335).
 */
import { describe, expect, it } from 'vitest';

import { derivedStockTone, STOCK_TONE_TEXT_CLASS } from '../derived-stock-tone';

describe('derivedStockTone', () => {
  it.each([
    // SCENARIO: every stock status a catalog item or spare part can carry.
    // EXPECTS: only the two derived bands colour the cell.
    ['OUT_OF_STOCK', 'out'],
    ['LOW_STOCK', 'low'],
    ['AVAILABLE', 'neutral'],
    ['IN_STOCK', 'neutral'],
    ['ON_ORDER', 'neutral'],
    ['DISCONTINUED', 'neutral'],
    ['EXPIRED', 'neutral'],
  ] as const)('%s → %s', (status, tone) => {
    expect(derivedStockTone(status)).toBe(tone);
  });

  it('reads nothing but the status (a covered shortfall stays neutral)', () => {
    // SCENARIO: a spare part at 3 on hand with reorderPoint 5 and 20 on order
    // is ON_ORDER on the backend. EXPECTS: neutral — the table does not
    // re-compare quantity with the reorder point and paint it amber.
    expect(STOCK_TONE_TEXT_CLASS[derivedStockTone('ON_ORDER')]).toBe(
      'text-gray-900 dark:text-gray-100',
    );
    expect(STOCK_TONE_TEXT_CLASS[derivedStockTone('LOW_STOCK')]).toContain('text-warning-600');
    expect(STOCK_TONE_TEXT_CLASS[derivedStockTone('OUT_OF_STOCK')]).toContain('text-error-600');
  });
});
