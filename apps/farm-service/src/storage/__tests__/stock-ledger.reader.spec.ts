/**
 * StockLedgerReader — every read on the OUT hot path is bounded to the item in
 * question (V-B1-12 of the B1a-1 verifier round).
 *
 * `onHandBySite` and `onOrder` run once per feeding OUT slice while the item's
 * advisory lock is held. They used to load every live location of the tenant
 * and every open purchase order with all its lines. London School: the
 * repositories are doubled to pin WHAT is asked for; the SQL itself is proven
 * against real Postgres in __tests__/e2e/low-stock-ledger.postgres.spec.ts.
 */
import { stub } from '@aquaculture/testing';
import {
  EntityManager,
  FindOperator,
  ObjectLiteral,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';

import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import { PurchaseOrderCategory } from '../entities/purchase-order.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StorageLocation } from '../entities/storage-location.entity';
import { StockLedgerReader } from '../services/low-stock/stock-ledger.reader';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FEED = '22222222-2222-4222-8222-222222222222';
const LOC_A = '33333333-3333-4333-8333-333333333333';
const LOC_B = '44444444-4444-4444-8444-444444444444';

function tenantMetadata<T extends ObjectLiteral>(): Repository<T>['metadata'] {
  const tenantColumn = stub<
    NonNullable<ReturnType<Repository<T>['metadata']['findColumnWithPropertyName']>>
  >({ databaseName: 'tenant_id' });
  return stub<Repository<T>['metadata']>({
    findColumnWithPropertyName: jest.fn((name: string) =>
      name === 'tenantId' ? tenantColumn : undefined,
    ),
  });
}

/** A chainable query-builder double that records its predicates. */
function queryBuilder<T extends ObjectLiteral>(
  raw: unknown[],
): { qb: SelectQueryBuilder<T>; predicates: Array<[string, unknown]> } {
  const predicates: Array<[string, unknown]> = [];
  const qb = stub<SelectQueryBuilder<T>>({});
  const chain = jest.fn(() => qb);
  qb.where = chain;
  qb.select = chain;
  qb.addSelect = chain;
  qb.groupBy = chain;
  qb.addGroupBy = chain;
  qb.innerJoin = chain;
  qb.andWhere = jest.fn((condition: string, parameters?: unknown) => {
    predicates.push([condition, parameters]);
    return qb;
  });
  qb.getRawMany = jest.fn().mockResolvedValue(raw);
  return { qb, predicates };
}

describe('StockLedgerReader — bounded reads', () => {
  it('reads the sites of only the locations that hold the item', async () => {
    // SCENARIO: the item lies in LOC_A and LOC_B. EXPECTS: the location read is
    // restricted to those two ids (not the tenant's whole location list), and
    // the per-site sum is exact in hundredths (0.1 + 0.2 = 0.3).
    const inventory = queryBuilder<StorageInventory>([
      { itemType: StorageItemType.FEED, itemId: FEED, locationId: LOC_A, onHand: '0.10' },
      { itemType: StorageItemType.FEED, itemId: FEED, locationId: LOC_B, onHand: '0.20' },
    ]);
    const locationFind = jest.fn().mockResolvedValue([
      { id: LOC_A, siteId: 'site-a' },
      { id: LOC_B, siteId: 'site-a' },
    ]);
    const getRepository = jest.fn();
    getRepository.mockImplementation((entity: unknown): unknown =>
      entity === StorageInventory
        ? stub<Repository<StorageInventory>>({
            metadata: tenantMetadata<StorageInventory>(),
            createQueryBuilder: jest.fn(() => inventory.qb),
          })
        : stub<Repository<StorageLocation>>({
            metadata: tenantMetadata<StorageLocation>(),
            find: locationFind,
          }),
    );
    const manager = stub<EntityManager>({ getRepository });

    const rows = await new StockLedgerReader().onHandBySite(manager, TENANT, {
      kind: 'item',
      key: { itemType: StorageItemType.FEED, itemId: FEED },
    });

    expect(rows).toEqual([
      { itemType: StorageItemType.FEED, itemId: FEED, siteId: 'site-a', onHand: 0.3 },
    ]);
    const where = locationFind.mock.calls[0][0].where as { id: FindOperator<string[]> };
    expect(where.id.type).toBe('in');
    expect([...where.id.value].sort()).toEqual([LOC_A, LOC_B].sort());
  });

  it('reads the open-order remainder of only the item, grouped in SQL', async () => {
    // SCENARIO: one open FEED line with 12.5 remaining. EXPECTS: the line read is
    // filtered to this item id and the FEED categories in SQL (never every open
    // order with all its lines), and the remainder comes back exact.
    const lines = queryBuilder<PurchaseOrderItem>([
      { category: PurchaseOrderCategory.FEED, itemId: FEED, onOrder: '12.50' },
    ]);
    const getRepository = jest.fn();
    getRepository.mockImplementation((): unknown =>
      stub<Repository<PurchaseOrderItem>>({
        metadata: tenantMetadata<PurchaseOrderItem>(),
        createQueryBuilder: jest.fn(() => lines.qb),
      }),
    );
    const manager = stub<EntityManager>({ getRepository });

    const rows = await new StockLedgerReader().onOrder(manager, TENANT, {
      kind: 'item',
      key: { itemType: StorageItemType.FEED, itemId: FEED },
    });

    expect(rows).toEqual([{ itemType: StorageItemType.FEED, itemId: FEED, onOrder: 12.5 }]);
    expect(lines.predicates).toEqual(
      expect.arrayContaining([
        ['line.itemId IN (:...itemIds)', { itemIds: [FEED] }],
        ['po.category IN (:...categories)', { categories: [PurchaseOrderCategory.FEED] }],
      ]),
    );
  });
});
