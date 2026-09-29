/**
 * Stock identity — which ledger rows are the SAME physical item (plan K8).
 *
 * WHY: HEALTHCARE and CONSUMABLE share one catalog table (`consumables`), and
 * a consumable's stock can be booked under either ledger type (a HEALTHCARE
 * purchase order receives as 'healthcare', a manual movement often as
 * 'consumable'). Evaluating the two keys separately split one shelf into two
 * partial pools: the half with no rows read as a stock-out of an item that was
 * on the shelf. Every tier decision keys on the CANONICAL type and sums every
 * ledger type that shares its catalog row.
 */
import { StorageItemType, assertNeverItemType } from '../../entities/storage-inventory.entity';

/** The one item type a physical item is evaluated, keyed and reported under. */
export function canonicalStockItemType(itemType: StorageItemType): StorageItemType {
  switch (itemType) {
    case StorageItemType.HEALTHCARE:
      return StorageItemType.CONSUMABLE;
    case StorageItemType.FEED:
    case StorageItemType.CHEMICAL:
    case StorageItemType.CONSUMABLE:
    case StorageItemType.SPARE_PART:
      return itemType;
    default:
      return assertNeverItemType(itemType);
  }
}

/** Every ledger item type whose rows belong to the canonical type's catalog row. */
export function ledgerItemTypesOf(itemType: StorageItemType): StorageItemType[] {
  const canonical = canonicalStockItemType(itemType);
  return Object.values(StorageItemType).filter(
    (candidate) => canonicalStockItemType(candidate) === canonical,
  );
}
