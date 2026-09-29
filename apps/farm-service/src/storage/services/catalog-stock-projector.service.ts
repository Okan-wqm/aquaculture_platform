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
 * WHAT: `project()` reads the pool on-hand AND the open purchase-order
 * remainder from the ledger (the same reads every low-stock decision makes)
 * and writes quantity + the status of `poolStockBand` — the ONE band rule the
 * LowStockDetected pool tier, the evaluator's listing and the spare-part status
 * use (V-B1-4 of the B1a-1 verifier round: the projection compared on-hand
 * alone with minStock, so a setup table showed LOW for an item the overview
 * reported covered by an order). Spare parts have no projection: their
 * quantity/status are derived at read time (FARM-HIGH-338), so nothing is
 * written for them.
 *
 * WHY a column at all (not derived at read time like spare parts): the feed,
 * chemical and consumable lists filter and sort on `status` in SQL. So every
 * command that changes one of the rule's inputs re-projects: a stock movement
 * (StockMovementService) and every threshold, open-order or site change
 * (StockTierWatch — minStock edits, purchase-order create/status/receipt).
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
import { poolStockBand } from './low-stock/stock-band';
import { StockLedgerReader } from './low-stock/stock-ledger.reader';
import { stockQuantityFromUnits, stockQuantityUnits } from './stock-quantity';

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

/** Pool facts the catalog status is derived from. */
export interface CatalogStockFacts {
  /** Ledger on-hand across every live location. */
  onHand: number;
  /** Unreceived remainder on open purchase-order lines. */
  onOrder: number;
}

/**
 * Derive the catalog status from the pool facts and minStock.
 * WHY one function over `poolStockBand`: the projection must read the same
 * band as the pool tier, so a shortfall an open order already covers is not
 * LOW on one screen and covered on the next; WHAT: lifecycle statuses stick,
 * otherwise out when nothing is on hand, low when on-hand + on-order is at or
 * below minStock, available otherwise.
 */
export function deriveCatalogStockStatus<S extends string>(
  current: S,
  facts: CatalogStockFacts,
  minStock: number,
  statuses: StockStatusVocabulary<S>,
): S {
  if (statuses.lifecycle.includes(current)) return current;
  switch (poolStockBand(facts.onHand, facts.onOrder, minStock)) {
    case 'out_of_stock':
      return statuses.out;
    case 'low_stock':
      return statuses.low;
    case 'ok':
      return statuses.available;
  }
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
        const facts = await this.poolFacts(manager, tenantId, itemType, itemId);
        feed.quantity = facts.onHand;
        feed.status = deriveCatalogStockStatus(
          feed.status,
          facts,
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
        const facts = await this.poolFacts(manager, tenantId, itemType, itemId);
        chem.quantity = facts.onHand;
        chem.status = deriveCatalogStockStatus(
          chem.status,
          facts,
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
        const facts = await this.poolFacts(manager, tenantId, itemType, itemId);
        cons.quantity = facts.onHand;
        cons.status = deriveCatalogStockStatus(
          cons.status,
          facts,
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

  /** Pool on-hand + open-order remainder of one item, exact to the hundredth. */
  private async poolFacts(
    manager: EntityManager,
    tenantId: string,
    itemType: StorageItemType,
    itemId: string,
  ): Promise<CatalogStockFacts> {
    const scope = { kind: 'item' as const, key: { itemType, itemId } };
    // Sequential: the caller's transactional connection runs one query at a time.
    const onHandRows = await this.reader.onHandBySite(manager, tenantId, scope);
    const onOrderRows = await this.reader.onOrder(manager, tenantId, scope);
    return {
      onHand: exactSum(onHandRows.map((row) => row.onHand)),
      onOrder: exactSum(onOrderRows.map((row) => row.onOrder)),
    };
  }
}

/** Sum `numeric(15,2)` quantities in integer hundredths (no double residue). */
function exactSum(values: readonly number[]): number {
  return stockQuantityFromUnits(
    values.reduce(
      (sum, value) => sum + stockQuantityUnits(value, 'Stock quantity', { allowZero: true }),
      0,
    ),
  );
}
