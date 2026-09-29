/**
 * low-stock-tiers — which inventory rows a low-stock tier concerns (plan K8).
 */
import { describe, expect, it } from 'vitest';
import type { I18nContextValue } from '@aquaculture/shared-ui';

import type { LowStockAlert } from '../../../hooks/useStorageInventory';
import { indexLowStock, lowStockRowKey, lowStockTierLabel } from '../utils/low-stock-tiers';

function alert(over: Partial<LowStockAlert>): LowStockAlert {
  return {
    itemId: 'feed-1',
    itemName: 'Pellet 3mm',
    itemType: 'FEED',
    level: 'POOL',
    siteId: null,
    siteName: null,
    currentQuantity: 10,
    minStock: 100,
    onOrderQuantity: 0,
    unit: 'kg',
    ...over,
  };
}

describe('indexLowStock', () => {
  const pool = alert({});
  const siteA = alert({ level: 'SITE', siteId: 'site-a', siteName: 'A', minStock: 40 });

  it('gives a pool tier to every row of the item and a site tier only to its site', () => {
    // SCENARIO: feed-1 is short in the pool and at site A; rows at A, at B,
    // at an unknown location; another item. EXPECTS: A gets both, B only the
    // pool, an unplaced row only the pool, the other item nothing.
    const index = indexLowStock([siteA, pool]);

    expect(index.forRow('feed-1', 'site-a')).toEqual({ pool, site: siteA });
    expect(index.forRow('feed-1', 'site-b')).toEqual({ pool, site: undefined });
    expect(index.forRow('feed-1', undefined)).toEqual({ pool, site: undefined });
    expect(index.forRow('feed-2', 'site-a')).toEqual({ pool: undefined, site: undefined });
  });

  it('keys and labels the tiers so the same item never collapses into one row', () => {
    // SCENARIO: the pool and site-A rows of one item. EXPECTS: distinct keys
    // and labels that name the site or the pool.
    // The label is catalog text: a recording translator shows the key and the
    // interpolated site name the page hands to useI18n().t.
    const t: I18nContextValue['t'] = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`;
    expect(lowStockRowKey(pool)).not.toBe(lowStockRowKey(siteA));
    expect(lowStockTierLabel(siteA, t)).toBe('storage.lowStock.siteTier{"site":"A"}');
    expect(lowStockTierLabel(pool, t)).toBe('storage.lowStock.poolTier');
  });
});
