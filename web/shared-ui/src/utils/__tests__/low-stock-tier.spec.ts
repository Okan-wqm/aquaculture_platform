/**
 * low-stock-tier — one row identity and one tier label for every remote that
 * lists storageOverview.lowStockAlerts (plan K8, FARM-HIGH-336).
 */
import { describe, expect, it } from 'vitest';

import type { I18nContextValue } from '../../i18n';
import { lowStockRowKey, lowStockTierLabel, type LowStockTierRow } from '../low-stock-tier';

const pool: LowStockTierRow = { itemId: 'feed-1', level: 'POOL', siteId: null, siteName: null };
const siteA: LowStockTierRow = { itemId: 'feed-1', level: 'SITE', siteId: 'site-a', siteName: 'A' };
const siteB: LowStockTierRow = {
  itemId: 'feed-1',
  level: 'SITE',
  siteId: 'site-b',
  siteName: null,
};

// A recording translator: shows the catalog key and the interpolated values
// the caller hands to useI18n().t.
const t: I18nContextValue['t'] = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`;

describe('lowStockRowKey', () => {
  it('gives the pool row and every site row of one item a distinct key', () => {
    // SCENARIO: one item short in the pool, at site A and at site B.
    // EXPECTS: three distinct keys — no tier collapses into another.
    const keys = [pool, siteA, siteB].map(lowStockRowKey);
    expect(new Set(keys).size).toBe(3);
    expect(lowStockRowKey(pool)).toBe('feed-1:POOL:pool');
    expect(lowStockRowKey(siteA)).toBe('feed-1:SITE:site-a');
  });
});

describe('lowStockTierLabel', () => {
  it('names the site for a SITE row and the pool for a POOL row, through the catalog', () => {
    // SCENARIO: a named site, a site whose name did not resolve, the pool.
    // EXPECTS: the site name (or its id) interpolated into the site key; the
    // pool key for the pool row.
    expect(lowStockTierLabel(siteA, t)).toBe('storage.lowStock.siteTier{"site":"A"}');
    expect(lowStockTierLabel(siteB, t)).toBe('storage.lowStock.siteTier{"site":"site-b"}');
    expect(lowStockTierLabel(pool, t)).toBe('storage.lowStock.poolTier');
  });
});
