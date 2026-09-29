/**
 * Low-stock tiers on the web (plan K8, FARM-HIGH-336).
 *
 * WHY: the storage overview returns one row per short TIER — the tenant pool
 * of an item and, separately, each site below its site policy — so the same
 * item can appear twice. Keying by `itemId` alone kept whichever row came last
 * and badged every site's rows with it. This module is the ONE place that says
 * which tier a row is and which inventory rows it concerns.
 */
import type { I18nContextValue } from '@aquaculture/shared-ui';

import type { LowStockAlert } from '../../../hooks/useStorageInventory';

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

/** Stable React key: one row per (item, tier, site). */
export function lowStockRowKey(alert: LowStockAlert): string {
  return `${alert.itemId}:${alert.level}:${alert.siteId ?? 'pool'}`;
}

/**
 * Human label of the tier: the site's name, or the tenant pool.
 * WHY `t` is a parameter: the label is user-visible text, so it goes through
 * the shared-ui message catalog (FE-HIGH-089) in the viewer's language.
 */
export function lowStockTierLabel(alert: LowStockAlert, t: I18nContextValue['t']): string {
  return alert.level === 'SITE'
    ? t('storage.lowStock.siteTier', { site: alert.siteName ?? alert.siteId ?? '-' })
    : t('storage.lowStock.poolTier');
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
