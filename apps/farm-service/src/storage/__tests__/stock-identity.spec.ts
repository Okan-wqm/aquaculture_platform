/**
 * Stock identity: one physical item, one key (plan K8).
 */
import { StorageItemType } from '../entities/storage-inventory.entity';
import { canonicalStockItemType, ledgerItemTypesOf } from '../services/low-stock/stock-identity';

describe('stock identity', () => {
  it('folds HEALTHCARE into the consumable identity it shares a catalog row with', () => {
    // SCENARIO: a vaccine booked as healthcare, and as consumable. EXPECTS: one canonical type.
    expect(canonicalStockItemType(StorageItemType.HEALTHCARE)).toBe(StorageItemType.CONSUMABLE);
    expect(canonicalStockItemType(StorageItemType.CONSUMABLE)).toBe(StorageItemType.CONSUMABLE);
  });

  it('reads every ledger type of the shared catalog row, and only those', () => {
    // SCENARIO: ledger reads for each category. EXPECTS: consumable ↔ both; others alone.
    expect(ledgerItemTypesOf(StorageItemType.HEALTHCARE).sort()).toEqual(
      [StorageItemType.CONSUMABLE, StorageItemType.HEALTHCARE].sort(),
    );
    expect(ledgerItemTypesOf(StorageItemType.CONSUMABLE).sort()).toEqual(
      [StorageItemType.CONSUMABLE, StorageItemType.HEALTHCARE].sort(),
    );
    expect(ledgerItemTypesOf(StorageItemType.FEED)).toEqual([StorageItemType.FEED]);
    expect(ledgerItemTypesOf(StorageItemType.SPARE_PART)).toEqual([StorageItemType.SPARE_PART]);
  });
});
