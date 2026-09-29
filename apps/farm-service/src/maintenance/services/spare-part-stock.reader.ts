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
import { SparePart, SparePartStatus } from '../entities/spare-part.entity';

/** Derived stock of one spare part. */
export interface SparePartStockView {
  /** Ledger on-hand across every non-deleted location. */
  onHand: number;
  /** Unreceived remainder on open purchase-order lines (SPARE_PART category). */
  onOrder: number;
  status: SparePartStatus;
}

/** The catalog facts the status derivation needs. */
export type SparePartStockFacts = Pick<SparePart, 'id' | 'isActive' | 'minStock'>;

/**
 * Derive a spare part's status from the ledger.
 * WHY: status used to be a stored field any update could overwrite; WHAT:
 *   inactive → DISCONTINUED; on-hand ≤ 0 → OUT_OF_STOCK (physical fact, even
 *   with an order open); open order → ON_ORDER; on-hand ≤ minStock →
 *   LOW_STOCK; else IN_STOCK.
 */
export function deriveSparePartStatus(
  part: Pick<SparePart, 'isActive' | 'minStock'>,
  onHand: number,
  onOrder: number,
): SparePartStatus {
  if (!part.isActive) return SparePartStatus.DISCONTINUED;
  if (onHand <= 0) return SparePartStatus.OUT_OF_STOCK;
  if (onOrder > 0) return SparePartStatus.ON_ORDER;
  if (onHand <= part.minStock) return SparePartStatus.LOW_STOCK;
  return SparePartStatus.IN_STOCK;
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
    const [onHandRows, onOrderRows] = await Promise.all([
      this.ledger.onHandBySite(manager, tenantId, scope),
      this.ledger.onOrder(manager, tenantId, scope),
    ]);

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
