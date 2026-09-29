/**
 * Read models of the two-tier stock evaluation (plan K8).
 *
 * WHY discriminated on `level`: a site reading always names its site and a
 * pool reading never does; consumers narrow on `level` instead of checking
 * optional fields.
 */
import type { StorageItemType } from '../../entities/storage-inventory.entity';
import type { LowStockSeverity, StockBand } from './stock-band';

/** Ledger identity of one stock item. */
export interface StorageItemKey {
  itemType: StorageItemType;
  itemId: string;
}

/** Tier 1: one site's on-hand against its distribution policy. */
export interface SiteStockReading extends StorageItemKey {
  level: 'site';
  siteId: string;
  onHand: number;
  /** `storage_item_site_policies.min_stock` (always > 0). */
  threshold: number;
  band: StockBand;
}

/** Tier 2: the tenant pool's inventory position against the catalog threshold. */
export interface PoolStockReading extends StorageItemKey {
  level: 'pool';
  onHand: number;
  /** Unreceived remainder on SUBMITTED/APPROVED/ORDERED/PARTIALLY_RECEIVED lines. */
  onOrder: number;
  /** Catalog reorder threshold; 0 = not reorder-controlled. */
  threshold: number;
  band: StockBand;
}

export type StockReading = SiteStockReading | PoolStockReading;

/** A listed reading plus the catalog facts a list needs to render it. */
export type DescribedStockReading = StockReading & { itemName: string; unit: string };

/** Both tiers of one item. */
export interface ItemStockEvaluation {
  pool: PoolStockReading;
  sites: SiteStockReading[];
}

/**
 * What one committed ledger movement did to one item's tiers: a location on
 * the FROM side lost `quantity`, one on the TO side gained it. A side is null
 * when the movement has no such location, or when that location no longer
 * counts as stock (soft-deleted), so its change moved no tier.
 */
export interface StockMovementEffect extends StorageItemKey {
  quantity: number;
  fromSiteId: string | null;
  toSiteId: string | null;
}

/** A tier that the movement pushed into a worse band. */
export interface LowStockCrossing {
  before: StockBand;
  severity: LowStockSeverity;
  reading: StockReading;
}
