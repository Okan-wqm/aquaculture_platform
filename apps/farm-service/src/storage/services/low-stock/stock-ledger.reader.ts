/**
 * StockLedgerReader — the raw facts the two-tier evaluation is built from
 * (plan K8). Every read is tenant-scoped through `tenantManagerRepo`.
 *
 * WHY property-syntax QueryBuilders and no join conditions: the ledger's
 * columns are snake_case behind camelCase properties, and a hand-written join
 * condition is exactly how FARM-CRITICAL-242 / FARM-HIGH-300 shipped queries
 * that raised 42703 or matched nothing. Rows are grouped per LOCATION in SQL
 * and folded per site in TypeScript over the (small) location list instead.
 *
 * INVARIANT (FARM-MEDIUM-293): stock in a soft-deleted location is not
 * on-hand — the same rule the feed forecast and FEFO allocation apply, so every
 * reader of "how much is there" agrees.
 */
import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

import { StorageInventory, StorageItemType } from '../../entities/storage-inventory.entity';
import { StorageLocation } from '../../entities/storage-location.entity';
import { StorageItemSitePolicy } from '../../entities/storage-item-site-policy.entity';
import { PurchaseOrder } from '../../entities/purchase-order.entity';
import { Feed } from '../../../feed/entities/feed.entity';
import { Chemical } from '../../../chemical/entities/chemical.entity';
import { Consumable } from '../../../consumable/entities/consumable.entity';
import { SparePart } from '../../../maintenance/entities/spare-part.entity';
import { Site } from '../../../site/entities/site.entity';
import {
  OPEN_PURCHASE_ORDER_STATUSES,
  PURCHASE_ORDER_CATEGORY_ITEM_TYPE,
  purchaseOrderCategoriesFor,
} from '../purchase-order-item-type';
import type { StorageItemKey } from './low-stock.types';
import { canonicalStockItemType, ledgerItemTypesOf } from './stock-identity';

/** Which items a read covers: one ledger key, several of one type, or the whole tenant. */
export type StockReadScope =
  | { kind: 'item'; key: StorageItemKey }
  | { kind: 'items'; itemType: StorageItemType; itemIds: readonly string[] }
  | { kind: 'tenant' };

/** The item type a scope is restricted to, or undefined for the whole tenant. */
function scopedItemType(scope: StockReadScope): StorageItemType | undefined {
  if (scope.kind === 'item') return scope.key.itemType;
  if (scope.kind === 'items') return scope.itemType;
  return undefined;
}

/** True when the scope admits this item id (the type is filtered separately). */
function scopeAdmitsItem(scope: StockReadScope, itemId: string): boolean {
  if (scope.kind === 'item') return scope.key.itemId === itemId;
  if (scope.kind === 'items') return scope.itemIds.includes(itemId);
  return true;
}

export interface SiteOnHandRow extends StorageItemKey {
  siteId: string;
  onHand: number;
}

export interface OnOrderRow extends StorageItemKey {
  onOrder: number;
}

export interface SitePolicyRow extends StorageItemKey {
  siteId: string;
  minStock: number;
}

/** A catalog row that can carry stock, in the ledger's vocabulary. */
export interface CatalogStockRow {
  /** The ledger item type new stock of this row is recorded under. */
  itemType: StorageItemType;
  itemId: string;
  name: string;
  unit: string;
  /** Pool reorder threshold (minStock, or reorderPoint for spare parts). */
  poolReorderThreshold: number;
}

/** Stable map key for a stock identity (canonical type + id). */
export function itemKeyOf(key: StorageItemKey): string {
  return `${canonicalStockItemType(key.itemType)}:${key.itemId}`;
}

@Injectable()
export class StockLedgerReader {
  /**
   * Physical on-hand per (item, site). WHY: the one SUM(storage_inventory)
   * every stock decision reads (FARM-HIGH-335); WHAT: grouped per location in
   * SQL, folded per site here, deleted locations excluded.
   */
  async onHandBySite(
    manager: EntityManager,
    tenantId: string,
    scope: StockReadScope,
  ): Promise<SiteOnHandRow[]> {
    const query = tenantManagerRepo(manager, StorageInventory, tenantId)
      .createQueryBuilder('inv')
      .select('inv.itemType', 'itemType')
      .addSelect('inv.itemId', 'itemId')
      .addSelect('inv.storageLocationId', 'locationId')
      .addSelect('COALESCE(SUM(inv.quantity), 0)', 'onHand')
      .groupBy('inv.itemType')
      .addGroupBy('inv.itemId')
      .addGroupBy('inv.storageLocationId');
    if (scope.kind === 'items' && scope.itemIds.length === 0) return [];
    // Every ledger type that shares the item's catalog row (stock-identity.ts).
    if (scope.kind === 'item') {
      query
        .andWhere('inv.itemType IN (:...itemTypes)', {
          itemTypes: ledgerItemTypesOf(scope.key.itemType),
        })
        .andWhere('inv.itemId = :itemId', { itemId: scope.key.itemId });
    } else if (scope.kind === 'items') {
      query
        .andWhere('inv.itemType IN (:...itemTypes)', {
          itemTypes: ledgerItemTypesOf(scope.itemType),
        })
        .andWhere('inv.itemId IN (:...itemIds)', { itemIds: [...scope.itemIds] });
    }
    const rows: Array<{
      itemType: StorageItemType;
      itemId: string;
      locationId: string;
      onHand: string;
    }> = await query.getRawMany();
    if (rows.length === 0) return [];

    const locations = await tenantManagerRepo(manager, StorageLocation, tenantId).find({
      where: { tenantId, isDeleted: false },
      select: ['id', 'siteId'],
    });
    const siteByLocation = new Map(locations.map((loc) => [loc.id, loc.siteId]));

    const bySite = new Map<string, SiteOnHandRow>();
    for (const row of rows) {
      const siteId = siteByLocation.get(row.locationId);
      // Soft-deleted (or foreign) location: not on-hand (FARM-MEDIUM-293).
      if (siteId === undefined) continue;
      const mapKey = `${itemKeyOf(row)}:${siteId}`;
      const current = bySite.get(mapKey);
      const onHand = Number(row.onHand);
      if (current) {
        current.onHand += onHand;
      } else {
        bySite.set(mapKey, {
          itemType: canonicalStockItemType(row.itemType),
          itemId: row.itemId,
          siteId,
          onHand,
        });
      }
    }
    return [...bySite.values()];
  }

  /**
   * Unreceived remainder on open purchase-order lines (FARM-3). The line's
   * item type is its order's category mapped through the one SSoT.
   */
  async onOrder(
    manager: EntityManager,
    tenantId: string,
    scope: StockReadScope,
  ): Promise<OnOrderRow[]> {
    if (scope.kind === 'items' && scope.itemIds.length === 0) return [];
    const itemType = scopedItemType(scope);
    const categories = itemType
      ? ledgerItemTypesOf(itemType).flatMap((ledgerType) => purchaseOrderCategoriesFor(ledgerType))
      : undefined;
    if (categories !== undefined && categories.length === 0) return [];

    const orders = await tenantManagerRepo(manager, PurchaseOrder, tenantId).find({
      where: {
        tenantId,
        isDeleted: false,
        status: In([...OPEN_PURCHASE_ORDER_STATUSES]),
        ...(categories ? { category: In(categories) } : {}),
      },
      relations: ['items'],
    });

    const totals = new Map<string, OnOrderRow>();
    for (const order of orders) {
      const lineItemType = PURCHASE_ORDER_CATEGORY_ITEM_TYPE[order.category];
      for (const line of order.items) {
        if (!scopeAdmitsItem(scope, line.itemId)) continue;
        const remainder = Math.max(Number(line.quantity) - Number(line.quantityReceived), 0);
        if (remainder === 0) continue;
        const key = { itemType: canonicalStockItemType(lineItemType), itemId: line.itemId };
        const current = totals.get(itemKeyOf(key));
        if (current) current.onOrder += remainder;
        else totals.set(itemKeyOf(key), { ...key, onOrder: remainder });
      }
    }
    return [...totals.values()];
  }

  /** Site distribution policies (plan K8 tier 1). */
  async sitePolicies(
    manager: EntityManager,
    tenantId: string,
    scope: StockReadScope,
  ): Promise<SitePolicyRow[]> {
    if (scope.kind === 'items' && scope.itemIds.length === 0) return [];
    // Policies are stored under the canonical type (the upsert canonicalises).
    const policies = await tenantManagerRepo(manager, StorageItemSitePolicy, tenantId).find({
      where:
        scope.kind === 'item'
          ? {
              tenantId,
              itemType: canonicalStockItemType(scope.key.itemType),
              itemId: scope.key.itemId,
            }
          : scope.kind === 'items'
            ? {
                tenantId,
                itemType: canonicalStockItemType(scope.itemType),
                itemId: In([...scope.itemIds]),
              }
            : { tenantId },
    });
    if (policies.length === 0) return [];

    // INVARIANT: a soft-deleted site distributes nothing, so its policy is
    // dormant (kept, because a restored site gets its policy back). If
    // violated → a closed site reads as permanently out of stock and asks for
    // transfers nobody can receive.
    const liveSites = await tenantManagerRepo(manager, Site, tenantId).find({
      where: {
        tenantId,
        isDeleted: false,
        id: In([...new Set(policies.map((policy) => policy.siteId))]),
      },
      select: ['id'],
    });
    const liveSiteIds = new Set(liveSites.map((site) => site.id));

    return policies
      .filter((policy) => liveSiteIds.has(policy.siteId))
      .map((policy) => ({
        itemType: policy.itemType,
        itemId: policy.itemId,
        siteId: policy.siteId,
        minStock: Number(policy.minStock),
      }));
  }

  /**
   * Every live catalog row that can carry stock, across the four catalog
   * tables. Deleted and inactive rows are excluded: they are not stocked.
   */
  async catalog(manager: EntityManager, tenantId: string): Promise<CatalogStockRow[]> {
    // Sequential on purpose: one transactional connection runs one query at a
    // time (pg queues parallel calls and deprecates doing so).
    const feeds = await tenantManagerRepo(manager, Feed, tenantId).find({
      where: { tenantId, isDeleted: false, isActive: true },
      select: ['id', 'name', 'unit', 'minStock'],
    });
    const chemicals = await tenantManagerRepo(manager, Chemical, tenantId).find({
      where: { tenantId, isDeleted: false, isActive: true },
      select: ['id', 'name', 'unit', 'minStock'],
    });
    const consumables = await tenantManagerRepo(manager, Consumable, tenantId).find({
      where: { tenantId, isDeleted: false, isActive: true },
      select: ['id', 'name', 'unit', 'minStock'],
    });
    const spareParts = await tenantManagerRepo(manager, SparePart, tenantId).find({
      where: { tenantId, isActive: true },
      select: ['id', 'name', 'unit', 'reorderPoint'],
    });
    return [
      ...feeds.map((row) =>
        catalogRow(StorageItemType.FEED, row.id, row.name, row.unit, row.minStock),
      ),
      ...chemicals.map((row) =>
        catalogRow(StorageItemType.CHEMICAL, row.id, row.name, row.unit, row.minStock),
      ),
      ...consumables.map((row) =>
        catalogRow(StorageItemType.CONSUMABLE, row.id, row.name, row.unit, row.minStock),
      ),
      ...spareParts.map((row) =>
        catalogRow(StorageItemType.SPARE_PART, row.id, row.name, row.unit, row.reorderPoint),
      ),
    ];
  }
}

function catalogRow(
  itemType: StorageItemType,
  itemId: string,
  name: string,
  unit: string,
  threshold: number,
): CatalogStockRow {
  // Decimal columns arrive through DecimalTransformer; Number() normalises the
  // integer spare-part column to the same representation.
  return { itemType, itemId, name, unit, poolReorderThreshold: Number(threshold) };
}
