/**
 * StockMutationLockAuthority pinleri.
 *
 * Kilit protokolünün üç özelliği test edilir, çünkü üçü de bozulduğunda
 * SESSİZCE bozulur: yanlış anahtar üreten bir kilit hâlâ "alınır", sıralamayı
 * kaybeden bir kilit hâlâ çalışır (ta ki iki yönlü transfer gelene kadar) ve
 * transaction dışında alınan bir advisory kilit aynı ifadede serbest bırakılır.
 */
import { BadRequestException } from '@nestjs/common';
import { EntityManager, QueryRunner } from 'typeorm';
import { stub } from '@aquaculture/testing';

import { StorageItemType } from '../entities/storage-inventory.entity';
import {
  StockMutationLockAuthority,
  stockIdempotencyLockKey,
  stockMutationLockKey,
} from '../services/stock-mutation-lock.authority';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FEED_A = '22222222-2222-4222-8222-222222222222';
const FEED_B = '33333333-3333-4333-8333-333333333333';

function makeManager(isTransactionActive: boolean): {
  manager: EntityManager;
  query: jest.Mock;
} {
  const query = jest.fn();
  query.mockResolvedValue([{ pg_advisory_xact_lock: '' }]);
  const manager = stub<EntityManager>({
    query,
    queryRunner: stub<QueryRunner>({ isTransactionActive }),
  });
  return { manager, query };
}

describe('stockMutationLockKey', () => {
  it('is namespaced and case-normalised so one bucket has exactly one key', () => {
    expect(
      stockMutationLockKey(TENANT.toUpperCase(), {
        itemType: StorageItemType.FEED,
        itemId: FEED_A.toUpperCase(),
      }),
    ).toBe(`aquaculture.stock-item/v1:${TENANT}:feed:${FEED_A}`);
  });

  it('refuses a non-UUID identity rather than locking a key nobody else derives', () => {
    expect(() =>
      stockMutationLockKey('tenant-1', { itemType: StorageItemType.FEED, itemId: FEED_A }),
    ).toThrow(BadRequestException);
  });

  it('refuses an unknown item type', () => {
    expect(() =>
      stockMutationLockKey(TENANT, {
        itemType: 'kelp' as StorageItemType,
        itemId: FEED_A,
      }),
    ).toThrow(BadRequestException);
  });
});

describe('stockIdempotencyLockKey', () => {
  it('bounds the key so an unbounded caller string cannot become the lock', () => {
    expect(() => stockIdempotencyLockKey(TENANT, '')).toThrow(BadRequestException);
    expect(() => stockIdempotencyLockKey(TENANT, 'x'.repeat(129))).toThrow(BadRequestException);
    expect(stockIdempotencyLockKey(TENANT, 'meal-deduct-1-0')).toBe(
      `aquaculture.stock-idempotency/v1:${TENANT}:meal-deduct-1-0`,
    );
  });
});

describe('StockMutationLockAuthority', () => {
  it('acquires one lock per distinct bucket, in sorted key order (no ABBA cycle)', async () => {
    const authority = new StockMutationLockAuthority();
    const { manager, query } = makeManager(true);

    await authority.acquire(manager, TENANT, [
      { itemType: StorageItemType.FEED, itemId: FEED_B },
      { itemType: StorageItemType.FEED, itemId: FEED_A },
      // Duplicate of the first target — must not take a second lock.
      { itemType: StorageItemType.FEED, itemId: FEED_B },
    ]);

    const keys = query.mock.calls.map((call) => (call[1] as string[])[0]);
    expect(keys).toEqual([
      stockMutationLockKey(TENANT, { itemType: StorageItemType.FEED, itemId: FEED_A }),
      stockMutationLockKey(TENANT, { itemType: StorageItemType.FEED, itemId: FEED_B }),
    ]);
    expect([...keys].sort()).toEqual(keys);
  });

  it('refuses to run outside a transaction — an advisory xact lock there is a no-op', async () => {
    const authority = new StockMutationLockAuthority();
    const { manager, query } = makeManager(false);

    await expect(
      authority.acquire(manager, TENANT, [{ itemType: StorageItemType.FEED, itemId: FEED_A }]),
    ).rejects.toThrow(/active caller-owned transaction/);
    await expect(authority.acquireIdempotency(manager, TENANT, 'k')).rejects.toThrow(
      /active caller-owned transaction/,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
