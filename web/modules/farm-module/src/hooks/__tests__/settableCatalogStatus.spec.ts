/**
 * Settable catalog statuses (FARM-HIGH-337).
 *
 * WHY: the API rejects LOW_STOCK / OUT_OF_STOCK as input — they are derived
 * from the storage ledger — so an edit form that prefills a derived band and
 * sends it back would fail. WHAT this pins: the settable lists hold no derived
 * band, and each normaliser keeps a lifecycle status and maps a band to
 * AVAILABLE ("derive from stock").
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import {
  CHEMICAL_SETTABLE_STATUSES,
  ChemicalStatus,
  toChemicalSettableStatus,
} from '../useChemicals';
import {
  CONSUMABLE_SETTABLE_STATUSES,
  ConsumableStatus,
  toConsumableSettableStatus,
} from '../useConsumables';
import { FEED_SETTABLE_STATUSES, FeedStatus, toFeedSettableStatus } from '../useFeeds';

const DERIVED_BANDS = ['LOW_STOCK', 'OUT_OF_STOCK'];

describe('settable catalog statuses (FARM-HIGH-337)', () => {
  it('offers no derived stock band in any settable list', () => {
    // SCENARIO: the three form vocabularies. EXPECTS: none contains LOW_STOCK / OUT_OF_STOCK.
    const settable: string[] = [
      ...FEED_SETTABLE_STATUSES,
      ...CHEMICAL_SETTABLE_STATUSES,
      ...CONSUMABLE_SETTABLE_STATUSES,
    ];
    expect(settable.filter((status) => DERIVED_BANDS.includes(status))).toEqual([]);
  });

  it.each(DERIVED_BANDS)('maps the derived band %s to AVAILABLE on edit prefill', (band) => {
    // SCENARIO: an item currently in a derived band is edited. EXPECTS: AVAILABLE is sent.
    expect(toFeedSettableStatus(band)).toBe(FeedStatus.AVAILABLE);
    expect(toChemicalSettableStatus(band)).toBe(ChemicalStatus.AVAILABLE);
    expect(toConsumableSettableStatus(band)).toBe(ConsumableStatus.AVAILABLE);
  });

  it('keeps an operator lifecycle status', () => {
    // SCENARIO: an item is DISCONTINUED / EXPIRED. EXPECTS: the override survives the edit.
    expect(toFeedSettableStatus(FeedStatus.EXPIRED)).toBe(FeedStatus.EXPIRED);
    expect(toChemicalSettableStatus(ChemicalStatus.DISCONTINUED)).toBe(ChemicalStatus.DISCONTINUED);
    expect(toConsumableSettableStatus(ConsumableStatus.DISCONTINUED)).toBe(
      ConsumableStatus.DISCONTINUED,
    );
  });
});
