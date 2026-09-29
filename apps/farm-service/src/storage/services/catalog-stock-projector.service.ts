/**
 * CatalogStockProjector — the ONE writer of the catalog stock projection
 * (`feeds/chemicals/consumables.quantity` + stock `status`), FARM-HIGH-337.
 *
 * WHY: the projection had three writers — the ledger roll-up, the item update
 * DTOs (which could set `quantity` and `status` directly) and the create DTOs
 * (which seeded `quantity` with no ledger row) — and a `minStock` change left
 * `status` stale. Now only the ledger decides quantity, and status is derived
 * from it whenever either input changes.
 *
 * WHAT: `project()` reads the pool on-hand from the ledger (same SUM as every
 * low-stock decision) and writes quantity + derived status. Spare parts have
 * no projection: their quantity/status are derived at read time (FARM-HIGH-338),
 * so nothing is written for them.
 *
 * INVARIANT: lifecycle statuses (EXPIRED, DISCONTINUED) are operator decisions
 * and survive a projection; only the stock bands are derived.
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

import { Feed, FeedStatus, FEED_LIFECYCLE_STATUSES } from '../../feed/entities/feed.entity';
import {
  Chemical,
  ChemicalStatus,
  CHEMICAL_LIFECYCLE_STATUSES,
} from '../../chemical/entities/chemical.entity';
import {
  Consumable,
  ConsumableStatus,
  CONSUMABLE_LIFECYCLE_STATUSES,
} from '../../consumable/entities/consumable.entity';
import { StorageItemType, assertNeverItemType } from '../entities/storage-inventory.entity';
import { StockLedgerReader } from './low-stock/stock-ledger.reader';

/** The stock-band vocabulary each catalog status enum shares. */
interface StockStatusVocabulary<S extends string> {
  available: S;
  low: S;
  out: S;
  /** Operator-set statuses a projection must not overwrite. */
  lifecycle: readonly S[];
}

const FEED_STATUSES: StockStatusVocabulary<FeedStatus> = {
  available: FeedStatus.AVAILABLE,
  low: FeedStatus.LOW_STOCK,
  out: FeedStatus.OUT_OF_STOCK,
  lifecycle: FEED_LIFECYCLE_STATUSES,
};

const CHEMICAL_STATUSES: StockStatusVocabulary<ChemicalStatus> = {
  available: ChemicalStatus.AVAILABLE,
  low: ChemicalStatus.LOW_STOCK,
  out: ChemicalStatus.OUT_OF_STOCK,
  lifecycle: CHEMICAL_LIFECYCLE_STATUSES,
};

const CONSUMABLE_STATUSES: StockStatusVocabulary<ConsumableStatus> = {
  available: ConsumableStatus.AVAILABLE,
  low: ConsumableStatus.LOW_STOCK,
  out: ConsumableStatus.OUT_OF_STOCK,
  lifecycle: CONSUMABLE_LIFECYCLE_STATUSES,
};

/**
 * Derive the catalog status from ledger on-hand and minStock.
 * WHY one function: the roll-up and the minStock-change path must agree;
 * WHAT: lifecycle statuses stick, otherwise out ≤ 0 < low ≤ minStock < available.
 */
export function deriveCatalogStockStatus<S extends string>(
  current: S,
  onHand: number,
  minStock: number,
  statuses: StockStatusVocabulary<S>,
): S {
  if (statuses.lifecycle.includes(current)) return current;
  if (onHand <= 0) return statuses.out;
  return onHand <= minStock ? statuses.low : statuses.available;
}

@Injectable()
export class CatalogStockProjector {
  constructor(private readonly reader: StockLedgerReader) {}

  /**
   * Re-project one item's catalog quantity + status from the ledger inside the
   * caller's transaction.
   *
   * Lock ORDER: the catalog row is locked BEFORE the SUM (FARM-CRITICAL-240) —
   * two movements on different lots of the same item serialise here, so the
   * later SUM sees the earlier commit. Callers mutate inventory rows first and
   * project last, keeping the inventory-row → aggregate-row order everywhere.
   */
  async project(
    manager: EntityManager,
    tenantId: string,
    itemType: StorageItemType,
    itemId: string,
  ): Promise<void> {
    switch (itemType) {
      case StorageItemType.FEED: {
        const repo = tenantManagerRepo(manager, Feed, tenantId);
        const feed = await repo.findOne({
          where: { id: itemId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!feed) return;
        feed.quantity = await this.poolOnHand(manager, tenantId, itemType, itemId);
        feed.status = deriveCatalogStockStatus(
          feed.status,
          feed.quantity,
          Number(feed.minStock),
          FEED_STATUSES,
        );
        await repo.save(feed);
        return;
      }
      case StorageItemType.CHEMICAL: {
        const repo = tenantManagerRepo(manager, Chemical, tenantId);
        const chem = await repo.findOne({
          where: { id: itemId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!chem) return;
        chem.quantity = await this.poolOnHand(manager, tenantId, itemType, itemId);
        chem.status = deriveCatalogStockStatus(
          chem.status,
          chem.quantity,
          Number(chem.minStock),
          CHEMICAL_STATUSES,
        );
        await repo.save(chem);
        return;
      }
      case StorageItemType.CONSUMABLE:
      case StorageItemType.HEALTHCARE: {
        const repo = tenantManagerRepo(manager, Consumable, tenantId);
        const cons = await repo.findOne({
          where: { id: itemId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!cons) return;
        cons.quantity = await this.poolOnHand(manager, tenantId, itemType, itemId);
        cons.status = deriveCatalogStockStatus(
          cons.status,
          cons.quantity,
          Number(cons.minStock),
          CONSUMABLE_STATUSES,
        );
        await repo.save(cons);
        return;
      }
      case StorageItemType.SPARE_PART:
        // Derived at read time from the ledger (FARM-HIGH-338); the legacy
        // `spare_parts.quantity` / `status` columns are no longer written and
        // are dropped in plan PR-A4.
        return;
      default:
        assertNeverItemType(itemType);
    }
  }

  private async poolOnHand(
    manager: EntityManager,
    tenantId: string,
    itemType: StorageItemType,
    itemId: string,
  ): Promise<number> {
    const rows = await this.reader.onHandBySite(manager, tenantId, {
      kind: 'item',
      key: { itemType, itemId },
    });
    return rows.reduce((sum, row) => sum + row.onHand, 0);
  }
}
