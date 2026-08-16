import { BadRequestException } from '@nestjs/common';
import type { EntityManager, QueryRunner } from 'typeorm';

import {
  compileFeedAllocationV1,
  type FeedAllocationCandidateV1,
} from '../services/feed-stock-allocation.authority';
import {
  stockIdempotencyKeyV1,
  StockMutationLockAuthority,
  stockMutationKeyV1,
} from '../services/stock-mutation-lock.authority';
import { StorageItemType } from '../entities/storage-inventory.entity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FEED = '22222222-2222-4222-8222-222222222222';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

function candidate(
  id: string,
  quantityKg: number,
  siteId: string,
  lotNumber: string,
): FeedAllocationCandidateV1 {
  return {
    inventoryId: id,
    storageLocationId: `33333333-3333-4333-8333-33333333333${id}`,
    siteId,
    lotNumber,
    quantityKg,
    expiryDate: new Date(`2026-09-0${id}T00:00:00.000Z`),
    receivedDate: new Date(`2026-07-0${id}T00:00:00.000Z`),
  };
}

describe('compileFeedAllocationV1', () => {
  it('compiles an immutable multi-lot allocation without losing the final slice', () => {
    const result = compileFeedAllocationV1(
      [candidate('1', 4, 'site-a', 'LOT-A'), candidate('2', 10, 'site-a', 'LOT-B')],
      11,
      'site-a',
    );

    expect(result.slices.map((slice) => [slice.lotNumber, slice.quantityKg])).toEqual([
      ['LOT-A', 4],
      ['LOT-B', 7],
    ]);
    expect(result.poolTotalKg).toBe(14);
    expect(result.usedTenantPool).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.slices)).toBe(true);
    expect(result.slices.every(Object.isFrozen)).toBe(true);
  });

  it('uses the preferred-site pool first but retains deterministic tenant fallback', () => {
    const result = compileFeedAllocationV1(
      [candidate('1', 8, 'site-b', 'LOT-EARLY'), candidate('2', 3, 'site-a', 'LOT-LOCAL')],
      6,
      'site-a',
    );

    expect(result.slices.map((slice) => [slice.lotNumber, slice.quantityKg])).toEqual([
      ['LOT-LOCAL', 3],
      ['LOT-EARLY', 3],
    ]);
    expect(result.usedTenantPool).toBe(true);
  });

  it('fails closed on an insufficient pool and on non-canonical precision', () => {
    expect(() => compileFeedAllocationV1([candidate('1', 2, 'site-a', 'LOT-A')], 3)).toThrow(
      BadRequestException,
    );
    expect(() => compileFeedAllocationV1([candidate('1', 2, 'site-a', 'LOT-A')], 1.001)).toThrow(
      /two decimal places/,
    );
  });
});

describe('StockMutationLockAuthority', () => {
  it('builds a stable, case-normalized lock identity', () => {
    expect(
      stockMutationKeyV1(TENANT.toUpperCase(), {
        itemType: StorageItemType.FEED,
        itemId: FEED.toUpperCase(),
      }),
    ).toBe(`aquaculture.stock-item/v1:${TENANT}:feed:${FEED}`);
  });

  it('requires a caller-owned transaction and acquires sorted unique keys', async () => {
    const authority = new StockMutationLockAuthority();
    const inactive = mock<EntityManager>({
      queryRunner: mock<QueryRunner>({ isTransactionActive: false }),
    });
    await expect(
      authority.acquire(inactive, TENANT, [{ itemType: StorageItemType.FEED, itemId: FEED }]),
    ).rejects.toThrow(/active caller-owned transaction/);

    const query = jest.fn().mockResolvedValue([]);
    const manager = mock<EntityManager>({
      queryRunner: mock<QueryRunner>({ isTransactionActive: true }),
      query,
    });
    const other = '00000000-0000-4000-8000-000000000001';
    await authority.acquire(manager, TENANT, [
      { itemType: StorageItemType.FEED, itemId: FEED },
      { itemType: StorageItemType.FEED, itemId: other },
      { itemType: StorageItemType.FEED, itemId: FEED },
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map((call) => call[1][0])).toEqual([
      stockMutationKeyV1(TENANT, { itemType: StorageItemType.FEED, itemId: other }),
      stockMutationKeyV1(TENANT, { itemType: StorageItemType.FEED, itemId: FEED }),
    ]);

    await authority.acquireIdempotency(manager, TENANT, 'operation-1');
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]![1][0]).toBe(stockIdempotencyKeyV1(TENANT, 'operation-1'));
  });

  it('rejects malformed mutation identities before calling PostgreSQL', () => {
    expect(() =>
      stockMutationKeyV1('not-a-tenant', {
        itemType: StorageItemType.FEED,
        itemId: FEED,
      }),
    ).toThrow(BadRequestException);
    expect(() => stockIdempotencyKeyV1(TENANT, '')).toThrow(BadRequestException);
  });
});
