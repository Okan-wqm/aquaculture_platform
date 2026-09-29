/**
 * Low-stock tiers on the storage page (plan K8, FARM-HIGH-336).
 *
 * WHY: the storage overview returns one row per short TIER — the tenant pool
 * of an item and, separately, each site below its site policy — so the same
 * item can appear twice. Keying by `itemId` alone kept whichever row came last
 * and badged every site's rows with it. This module says which inventory rows
 * a tier concerns; the row identity and the tier label are the design system's
 * (`lowStockRowKey` / `lowStockTierLabel` in shared-ui), shared with the
 * dashboard stock widget so the two lists cannot key or name a tier differently.
 */
import type { LowStockAlert } from '../../../hooks/useStorageInventory';

export { lowStockRowKey, lowStockTierLabel } from '@aquaculture/shared-ui';

/** The alerts that concern one inventory row. */
export interface RowLowStock {
  /** The item's tenant pool is at/below its reorder threshold. */
  pool?: LowStockAlert;
  /** The row's own site is at/below its site policy. */
  site?: LowStockAlert;
}

export interface LowStockIndex {
  /** Tiers that concern an inventory row of `itemId` at a location of `siteId`. */
  forRow(itemId: string, siteId: string | undefined): RowLowStock;
}

/**
 * WHY: a pool row concerns every inventory row of the item; a site row only the
 * rows at that site. WHAT: two maps, keyed exactly that way.
 */
export function indexLowStock(alerts: readonly LowStockAlert[]): LowStockIndex {
  const pool = new Map<string, LowStockAlert>();
  const site = new Map<string, LowStockAlert>();
  for (const alert of alerts) {
    if (alert.level === 'POOL') pool.set(alert.itemId, alert);
    else if (alert.siteId !== null) site.set(`${alert.itemId}:${alert.siteId}`, alert);
  }
  return {
    forRow(itemId, siteId) {
      return {
        pool: pool.get(itemId),
        site: siteId === undefined ? undefined : site.get(`${itemId}:${siteId}`),
      };
    },
  };
}
