/**
 * RecordStockMovementInput — the generic storage movement is not a second door
 * to spare-part stock (FARM-HIGH-338).
 *
 * Spare parts joined the storage ledger (StorageItemType.SPARE_PART), which
 * also put them in this MODULE_USER mutation's enum. Their quantity-changing
 * movements belong to the manager-gated `recordSparePartStockMovement`.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MovementType } from '../entities/stock-movement.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import {
  GENERIC_MOVEMENT_ITEM_TYPES,
  RecordStockMovementInput,
} from '../dto/record-stock-movement.input';

async function itemTypeErrors(itemType: StorageItemType): Promise<string[]> {
  const dto = plainToInstance(RecordStockMovementInput, {
    movementType: MovementType.IN,
    itemType,
    itemId: '22222222-2222-4222-8222-222222222222',
    quantity: 5,
    toLocationId: '33333333-3333-4333-8333-333333333333',
  });
  return (await validate(dto)).map((error) => error.property);
}

describe('RecordStockMovementInput item types', () => {
  it('rejects SPARE_PART so a MODULE_USER cannot bypass the spare-part gate', async () => {
    // SCENARIO: a generic IN of a spare part (recordStockMovement is open to
    // MODULE_USER). EXPECTS: rejected on itemType — spare-part stock changes
    // only through recordSparePartStockMovement (MODULE_MANAGER / TENANT_ADMIN).
    expect(await itemTypeErrors(StorageItemType.SPARE_PART)).toEqual(['itemType']);
  });

  it('accepts every other ledger category', async () => {
    // SCENARIO: feed, chemical, consumable, healthcare. EXPECTS: valid.
    for (const itemType of GENERIC_MOVEMENT_ITEM_TYPES) {
      expect(await itemTypeErrors(itemType)).toEqual([]);
    }
    expect(GENERIC_MOVEMENT_ITEM_TYPES).toEqual([
      StorageItemType.FEED,
      StorageItemType.CHEMICAL,
      StorageItemType.CONSUMABLE,
      StorageItemType.HEALTHCARE,
    ]);
  });
});
