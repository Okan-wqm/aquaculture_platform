/**
 * Low-stock tier rows — ONE identity and ONE label for every web surface that
 * lists `storageOverview.lowStockAlerts` (plan K8, FARM-HIGH-336).
 *
 * WHY here: the storage overview returns one row per short TIER — the tenant
 * pool of an item and, separately, each site below its site policy — so the
 * same item appears once per tier. The farm-module storage page and the
 * dashboard stock widget both list those rows; keyed by `itemId` alone the
 * dashboard collapsed a pool row and a site row into one React key and showed
 * neither tier nor site. Two private copies of the key would drift again, so
 * the rule lives in the design system both remotes already import.
 *
 * WHAT: `lowStockRowKey` identifies a row by (item, tier, site);
 * `lowStockTierLabel` names the tier (the site, or the tenant pool) through
 * the message catalog. The input is structural, so each module keeps its own
 * row type (GraphQL selection) and passes it as is.
 */
import type { I18nContextValue } from '../i18n';

/** Stock tier of a low-stock row: one site, or the tenant pool. */
export type LowStockTierLevel = 'SITE' | 'POOL';

/** The fields of a low-stock row that decide its identity and its tier label. */
export interface LowStockTierRow {
  itemId: string;
  level: LowStockTierLevel;
  /** The short site for SITE rows; null for POOL rows. */
  siteId: string | null;
  siteName: string | null;
}

/**
 * Stable key of one row: (item, tier, site).
 * INVARIANT: a pool row and each site row of one item get distinct keys; if
 * violated → React reuses one element for two tiers and a list shows one of
 * them twice or drops the other.
 */
export function lowStockRowKey(row: LowStockTierRow): string {
  return `${row.itemId}:${row.level}:${row.siteId ?? 'pool'}`;
}

/**
 * Human label of the row's tier: the site's name, or the tenant pool.
 * WHY `t` is a parameter: the label is user-visible text, so it goes through
 * the shared-ui message catalog (FE-HIGH-089) in the viewer's language, and
 * the helper stays a pure function callers can test without a provider.
 */
export function lowStockTierLabel(row: LowStockTierRow, t: I18nContextValue['t']): string {
  return row.level === 'SITE'
    ? t('storage.lowStock.siteTier', { site: row.siteName ?? row.siteId ?? '-' })
    : t('storage.lowStock.poolTier');
}
