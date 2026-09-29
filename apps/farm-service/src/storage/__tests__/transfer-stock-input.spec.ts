/**
 * TransferStockInput — the `transferStock` mutation moves only the item types
 * its handler can book (V-B1-2 of the B1a-1 verifier round, FARM-HIGH-239 gap).
 *
 * `TransferStockHandler` still hand-writes both inventory legs (no stock
 * mutation lock, no LowStockDetected, no deleted-destination refusal), so it
 * must not receive SPARE_PART (manager-gated ledger door) or HEALTHCARE (shares
 * the consumable row's canonical lock) until lane-B PR B1a-1b routes it through
 * the ledger sink.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { StorageItemType } from '../entities/storage-inventory.entity';
import {
  TRANSFERABLE_ITEM_TYPES,
  TransferStockInput,
  type TransferableItemType,
} from '../dto/transfer-stock.input';

/**
 * Compile-time proof that the handler's input type admits neither excluded
 * type: each alias resolves to `true` only while the exclusion holds, and the
 * `Expect<true>` constraint fails the build the moment it does not.
 */
type Expect<T extends true> = T;
type ExcludesSparePart = StorageItemType.SPARE_PART extends TransferableItemType ? false : true;
type ExcludesHealthcare = StorageItemType.HEALTHCARE extends TransferableItemType ? false : true;
export type TransferableTypeProof = [Expect<ExcludesSparePart>, Expect<ExcludesHealthcare>];

async function itemTypeErrors(itemType: StorageItemType): Promise<string[]> {
  const dto = plainToInstance(TransferStockInput, {
    itemType,
    itemId: '22222222-2222-4222-8222-222222222222',
    quantity: 5,
    fromLocationId: '33333333-3333-4333-8333-333333333333',
    toLocationId: '44444444-4444-4444-8444-444444444444',
  });
  return (await validate(dto)).map((error) => error.property);
}

describe('TransferStockInput item types', () => {
  it('rejects SPARE_PART and HEALTHCARE at the API boundary', async () => {
    // SCENARIO: a transferStock request (open to MODULE_USER) naming a spare part
    // or a healthcare booking. EXPECTS: rejected on itemType — spare parts move
    // through recordSparePartStockMovement (transfer), healthcare waits for B1a-1b.
    expect(await itemTypeErrors(StorageItemType.SPARE_PART)).toEqual(['itemType']);
    expect(await itemTypeErrors(StorageItemType.HEALTHCARE)).toEqual(['itemType']);
  });

  it('accepts feed, chemical and consumable, and nothing else', async () => {
    // SCENARIO: every transferable type. EXPECTS: valid; the list is exactly the three.
    for (const itemType of TRANSFERABLE_ITEM_TYPES) {
      expect(await itemTypeErrors(itemType)).toEqual([]);
    }
    expect([...TRANSFERABLE_ITEM_TYPES]).toEqual([
      StorageItemType.FEED,
      StorageItemType.CHEMICAL,
      StorageItemType.CONSUMABLE,
    ]);
  });
});
