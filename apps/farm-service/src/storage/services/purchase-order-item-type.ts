/**
 * The ONE mapping from a purchase-order category to the ledger item type its
 * lines move (plan K8 / FARM-3).
 *
 * WHY: the receipt handler kept a private `Record<string, …>` with a silent
 * `|| CONSUMABLE` fallback, and the low-stock evaluator needs the same mapping
 * to attribute open PO lines to the item they will restock. A total
 * `Record<PurchaseOrderCategory, StorageItemType>` makes a new category that
 * nobody mapped a compile error rather than a mis-filed receipt.
 */
import { PurchaseOrderCategory, PurchaseOrderStatus } from '../entities/purchase-order.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';

export const PURCHASE_ORDER_CATEGORY_ITEM_TYPE: Readonly<
  Record<PurchaseOrderCategory, StorageItemType>
> = Object.freeze({
  [PurchaseOrderCategory.FEED]: StorageItemType.FEED,
  [PurchaseOrderCategory.CHEMICAL]: StorageItemType.CHEMICAL,
  [PurchaseOrderCategory.CONSUMABLE]: StorageItemType.CONSUMABLE,
  [PurchaseOrderCategory.HEALTHCARE]: StorageItemType.HEALTHCARE,
  [PurchaseOrderCategory.SPARE_PART]: StorageItemType.SPARE_PART,
});

/**
 * Purchase-order states whose unreceived remainder is stock "on order"
 * (FARM-3). DRAFT is not a commitment yet; RECEIVED and CANCELLED have no
 * remainder that will ever arrive.
 */
export const OPEN_PURCHASE_ORDER_STATUSES: readonly PurchaseOrderStatus[] = Object.freeze([
  PurchaseOrderStatus.SUBMITTED,
  PurchaseOrderStatus.APPROVED,
  PurchaseOrderStatus.ORDERED,
  PurchaseOrderStatus.PARTIALLY_RECEIVED,
]);

/** Inverse lookup: which PO categories restock a given ledger item type. */
export function purchaseOrderCategoriesFor(itemType: StorageItemType): PurchaseOrderCategory[] {
  return Object.values(PurchaseOrderCategory).filter(
    (category) => PURCHASE_ORDER_CATEGORY_ITEM_TYPE[category] === itemType,
  );
}
