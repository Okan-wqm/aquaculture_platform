/**
 * Spare-part stock facts as SQL, for list filters and sorts that must run in
 * the database (FARM-HIGH-338, V-B1-12 of the B1a-1 verifier round).
 *
 * WHY: the spare-part list used to load EVERY part of the tenant and derive
 * every part's stock in TypeScript before it could filter, sort and slice one
 * page. A page must be selected in SQL, so the facts the status rule reads —
 * ledger on-hand over live locations and the open purchase-order remainder —
 * are expressed here as scalar subqueries correlated to the part row.
 *
 * WHAT: `sparePartStockSql()` returns the on-hand, on-order and derived status
 * expressions plus their parameters for a query whose root alias is the part.
 * Table and column names come from the entity metadata, never hand-spelled,
 * so a renamed column fails loudly at build time of the query instead of
 * silently matching nothing (the FARM-CRITICAL-242 / FARM-HIGH-300 class).
 *
 * INVARIANT: `status` is the SQL rendering of `deriveSparePartStatus` +
 * `poolStockBand` (spare-part-stock.reader.ts, stock-band.ts) — the ONE rule.
 * The parity is proven over the whole band grid against real Postgres in
 * `__tests__/e2e/spare-part-list.postgres.spec.ts`; if violated → a status
 * filter or sort selects parts whose displayed status says otherwise.
 */
import { EntityManager, EntityMetadata, EntityTarget, ObjectLiteral } from 'typeorm';

import { PurchaseOrderItem } from '../../storage/entities/purchase-order-item.entity';
import { PurchaseOrder } from '../../storage/entities/purchase-order.entity';
import { StorageInventory, StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StorageLocation } from '../../storage/entities/storage-location.entity';
import {
  OPEN_PURCHASE_ORDER_STATUSES,
  purchaseOrderCategoriesFor,
} from '../../storage/services/purchase-order-item-type';
import { SparePart, SparePartStatus } from '../entities/spare-part.entity';

/** The derived stock of the part row, as SQL expressions. */
export interface SparePartStockSql {
  /** Ledger on-hand across the part's live locations (numeric). */
  onHand: string;
  /** Unreceived remainder on open SPARE_PART purchase-order lines (numeric). */
  onOrder: string;
  /** `deriveSparePartStatus` rendered as a CASE (a `SparePartStatus` value). */
  status: string;
  /** Named parameters the expressions reference. */
  parameters: Record<string, unknown>;
}

/** Quoted identifier (entity metadata names are validated identifiers). */
function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** The database column of an entity property, or a loud failure. */
function column(metadata: EntityMetadata, alias: string, property: string): string {
  const found = metadata.findColumnWithPropertyName(property);
  if (!found) {
    throw new Error(`${metadata.name} has no column for property "${property}"`);
  }
  return `${quoted(alias)}.${quoted(found.databaseName)}`;
}

function table<T extends ObjectLiteral>(
  manager: EntityManager,
  entity: EntityTarget<T>,
): EntityMetadata {
  return manager.connection.getMetadata(entity);
}

/**
 * WHY: one place builds the facts a spare-part list filters and sorts on;
 * WHAT: expressions correlated to `partAlias` (the SparePart root alias).
 */
export function sparePartStockSql(manager: EntityManager, partAlias: string): SparePartStockSql {
  const part = table(manager, SparePart);
  const inventory = table(manager, StorageInventory);
  const location = table(manager, StorageLocation);
  const line = table(manager, PurchaseOrderItem);
  const order = table(manager, PurchaseOrder);

  const partId = column(part, partAlias, 'id');
  const partTenant = column(part, partAlias, 'tenantId');

  // Stock in a soft-deleted location is on-hand for no reader (FARM-MEDIUM-293).
  const onHand = `(SELECT COALESCE(SUM(${column(inventory, 'sp_inv', 'quantity')}), 0)
      FROM ${quoted(inventory.tableName)} ${quoted('sp_inv')}
      JOIN ${quoted(location.tableName)} ${quoted('sp_loc')}
        ON ${column(location, 'sp_loc', 'id')} = ${column(inventory, 'sp_inv', 'storageLocationId')}
     WHERE ${column(inventory, 'sp_inv', 'tenantId')} = ${partTenant}
       AND ${column(location, 'sp_loc', 'tenantId')} = ${partTenant}
       AND ${column(location, 'sp_loc', 'isDeleted')} = false
       AND ${column(inventory, 'sp_inv', 'itemType')} = :sparePartStockItemType
       AND ${column(inventory, 'sp_inv', 'itemId')} = ${partId})`;

  const onOrder = `(SELECT COALESCE(SUM(GREATEST(${column(line, 'sp_line', 'quantity')} - ${column(
    line,
    'sp_line',
    'quantityReceived',
  )}, 0)), 0)
      FROM ${quoted(line.tableName)} ${quoted('sp_line')}
      JOIN ${quoted(order.tableName)} ${quoted('sp_po')}
        ON ${column(order, 'sp_po', 'id')} = ${column(line, 'sp_line', 'purchaseOrderId')}
     WHERE ${column(line, 'sp_line', 'tenantId')} = ${partTenant}
       AND ${column(order, 'sp_po', 'tenantId')} = ${partTenant}
       AND ${column(order, 'sp_po', 'isDeleted')} = false
       AND ${column(order, 'sp_po', 'status')} IN (:...sparePartOpenOrderStatuses)
       AND ${column(order, 'sp_po', 'category')} IN (:...sparePartOrderCategories)
       AND ${column(line, 'sp_line', 'itemId')} = ${partId})`;

  const isActive = column(part, partAlias, 'isActive');
  const reorderPoint = column(part, partAlias, 'reorderPoint');
  // Same order as deriveSparePartStatus: inactive, physical stock-out,
  // inventory position at/below the reorder point, open order, in stock.
  const status = `(CASE
      WHEN NOT ${isActive} THEN '${SparePartStatus.DISCONTINUED}'
      WHEN ${onHand} <= 0 THEN '${SparePartStatus.OUT_OF_STOCK}'
      WHEN ${reorderPoint} > 0 AND ${onHand} + ${onOrder} <= ${reorderPoint}
        THEN '${SparePartStatus.LOW_STOCK}'
      WHEN ${onOrder} > 0 THEN '${SparePartStatus.ON_ORDER}'
      ELSE '${SparePartStatus.IN_STOCK}'
    END)`;

  return {
    onHand,
    onOrder,
    status,
    parameters: {
      sparePartStockItemType: StorageItemType.SPARE_PART,
      sparePartOpenOrderStatuses: [...OPEN_PURCHASE_ORDER_STATUSES],
      sparePartOrderCategories: purchaseOrderCategoriesFor(StorageItemType.SPARE_PART),
    },
  };
}
