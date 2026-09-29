/**
 * SparePartStockReader — spare-part stock read from the ONE storage ledger
 * (FARM-HIGH-338).
 *
 * WHY: `spare_parts.quantity` / `status` were counters no movement backed.
 * Spare parts are now ledger stock (`storage_inventory`, item_type
 * 'spare_part'), so on-hand, open-order remainder and the status are DERIVED
 * here — every spare-part surface (GraphQL fields, lists, alerts, summary,
 * cron) reads the same numbers through this one reader.
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StockLedgerReader } from '../../storage/services/low-stock/stock-ledger.reader';
import { poolStockBand } from '../../storage/services/low-stock/stock-band';
import { SparePart, SparePartStatus } from '../entities/spare-part.entity';

/** Derived stock of one spare part. */
export interface SparePartStockView {
  /** Ledger on-hand across every non-deleted location. */
  onHand: number;
  /** Unreceived remainder on open purchase-order lines (SPARE_PART category). */
  onOrder: number;
  status: SparePartStatus;
}

/**
 * The catalog columns the status derivation reads — THE select list of every
 * partial load that feeds `read()`.
 * WHY the type is derived from this list (not the other way round): a loader
 * that selects columns by hand can omit one the rule needs; TypeORM then
 * hands back `undefined`, `Number(undefined)` is NaN and `poolStockBand`
 * silently reads "not reorder-controlled" (the part never shows LOW_STOCK).
 * INVARIANT: a new fact is added HERE, so every loader selecting
 * `SPARE_PART_STOCK_FACT_COLUMNS` loads it; if violated → a derived status
 * computed from a missing column.
 */
export const SPARE_PART_STOCK_FACT_COLUMNS = [
  'id',
  'isActive',
  'reorderPoint',
] as const satisfies readonly (keyof SparePart)[];

/** The catalog facts the status derivation needs (see the column list above). */
export type SparePartStockFacts = Pick<SparePart, (typeof SPARE_PART_STOCK_FACT_COLUMNS)[number]>;

/**
 * THE spare-part stock rule — every spare-part surface (GraphQL `status`, the
 * low-stock list, the list filters, the summary, the daily cron) reads it.
 *
 * WHY one rule (FARM-HIGH-335 / FARM-4): the status used `minStock`, the
 * low-stock list used `reorderPoint` and the list filter a third comparison, so
 * one part could be LOW on one screen and fine on the next. A spare part's buy
 * trigger is its reorder point compared with its INVENTORY POSITION (ledger
 * on-hand + open purchase-order remainder) — the same `poolStockBand` the
 * `LowStockDetected` pool tier uses for it (storage-item-catalog.ts), so an
 * order that covers the shortfall suppresses LOW (ON_ORDER) and one that does
 * not leaves it LOW. `minStock` is the displayed safety stock, not a trigger.
 * WHAT: inactive → DISCONTINUED; on-hand ≤ 0 → OUT_OF_STOCK (fish-farm
 * pumps cannot run on an order); position ≤ reorderPoint → LOW_STOCK; an open
 * order otherwise → ON_ORDER; else IN_STOCK.
 */
export function deriveSparePartStatus(
  part: Pick<SparePart, 'isActive' | 'reorderPoint'>,
  onHand: number,
  onOrder: number,
): SparePartStatus {
  if (!part.isActive) return SparePartStatus.DISCONTINUED;
  const band = poolStockBand(onHand, onOrder, Number(part.reorderPoint));
  switch (band) {
    case 'out_of_stock':
      return SparePartStatus.OUT_OF_STOCK;
    case 'low_stock':
      return SparePartStatus.LOW_STOCK;
    case 'ok':
      return onOrder > 0 ? SparePartStatus.ON_ORDER : SparePartStatus.IN_STOCK;
  }
}

/**
 * The view of one part from a `read()` result.
 * INVARIANT: `read()` returns a view for every part it was given; a miss is a
 * programming error, raised instead of silently skipping the part.
 */
export function requireStockView(
  views: ReadonlyMap<string, SparePartStockView>,
  partId: string,
): SparePartStockView {
  const view = views.get(partId);
  if (!view) throw new Error(`Stock view missing for spare part ${partId}`);
  return view;
}

@Injectable()
export class SparePartStockReader {
  constructor(private readonly ledger: StockLedgerReader) {}

  /**
   * Derived stock for a set of parts, read inside the caller's tenant
   * transaction. WHY batched: lists resolve dozens of parts; WHAT: two ledger
   * reads for the whole set, a view for every requested part (zero when the
   * ledger holds none).
   */
  async read(
    manager: EntityManager,
    tenantId: string,
    parts: readonly SparePartStockFacts[],
  ): Promise<Map<string, SparePartStockView>> {
    const scope = {
      kind: 'items' as const,
      itemType: StorageItemType.SPARE_PART,
      itemIds: parts.map((part) => part.id),
    };
    // Sequential: `manager` is the caller's transactional connection, which runs
    // one query at a time (pg queues parallel calls and deprecates doing so).
    const onHandRows = await this.ledger.onHandBySite(manager, tenantId, scope);
    const onOrderRows = await this.ledger.onOrder(manager, tenantId, scope);

    const onHand = new Map<string, number>();
    for (const row of onHandRows)
      onHand.set(row.itemId, (onHand.get(row.itemId) ?? 0) + row.onHand);
    const onOrder = new Map(onOrderRows.map((row) => [row.itemId, row.onOrder]));

    const views = new Map<string, SparePartStockView>();
    for (const part of parts) {
      const partOnHand = onHand.get(part.id) ?? 0;
      const partOnOrder = onOrder.get(part.id) ?? 0;
      views.set(part.id, {
        onHand: partOnHand,
        onOrder: partOnOrder,
        status: deriveSparePartStatus(part, partOnHand, partOnOrder),
      });
    }
    return views;
  }
}
