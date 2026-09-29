/**
 * CatalogStockProjector — the ONE writer of the catalog quantity/status
 * projection (FARM-HIGH-337).
 */
import { EntityManager, ObjectLiteral, Repository } from 'typeorm';
import { stub } from '@aquaculture/testing';

import { Feed, FeedStatus } from '../../feed/entities/feed.entity';
import { ChemicalStatus } from '../../chemical/entities/chemical.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import {
  CatalogStockProjector,
  deriveCatalogStockStatus,
} from '../services/catalog-stock-projector.service';
import { poolStockBand } from '../services/low-stock/stock-band';
import { StockLedgerReader } from '../services/low-stock/stock-ledger.reader';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FEED = 'feed-1';

const CHEM = {
  available: ChemicalStatus.AVAILABLE,
  low: ChemicalStatus.LOW_STOCK,
  out: ChemicalStatus.OUT_OF_STOCK,
  lifecycle: [ChemicalStatus.EXPIRED, ChemicalStatus.DISCONTINUED],
};

describe('deriveCatalogStockStatus', () => {
  it.each([
    // SCENARIO: stock bands from ledger on-hand + open orders vs minStock.
    // EXPECTS: the poolStockBand of the same facts.
    [ChemicalStatus.AVAILABLE, 0, 0, 10, ChemicalStatus.OUT_OF_STOCK],
    [ChemicalStatus.AVAILABLE, 10, 0, 10, ChemicalStatus.LOW_STOCK],
    [ChemicalStatus.LOW_STOCK, 11, 0, 10, ChemicalStatus.AVAILABLE],
    [ChemicalStatus.OUT_OF_STOCK, 5, 0, 0, ChemicalStatus.AVAILABLE],
    // An open order that lifts the position above minStock covers the shortfall…
    [ChemicalStatus.LOW_STOCK, 4, 20, 10, ChemicalStatus.AVAILABLE],
    // …one that does not leaves it LOW, and no order hides a physical stock-out.
    [ChemicalStatus.AVAILABLE, 4, 6, 10, ChemicalStatus.LOW_STOCK],
    [ChemicalStatus.AVAILABLE, 0, 500, 10, ChemicalStatus.OUT_OF_STOCK],
  ] as const)(
    '%p with on-hand %p, on-order %p, min %p → %p',
    (current, onHand, onOrder, min, expected) => {
      expect(deriveCatalogStockStatus(current, { onHand, onOrder }, min, CHEM)).toBe(expected);
    },
  );

  it('agrees with the pool band on every cell of the grid (one rule, V-B1-4)', () => {
    // SCENARIO: on-hand × on-order × minStock grid. EXPECTS: the catalog status is
    // exactly the band the LowStockDetected pool tier and the evaluator read.
    const toStatus = { ok: CHEM.available, low_stock: CHEM.low, out_of_stock: CHEM.out } as const;
    for (const onHand of [0, 3, 10, 11]) {
      for (const onOrder of [0, 1, 8]) {
        for (const min of [0, 10]) {
          expect(
            deriveCatalogStockStatus(ChemicalStatus.AVAILABLE, { onHand, onOrder }, min, CHEM),
          ).toBe(toStatus[poolStockBand(onHand, onOrder, min)]);
        }
      }
    }
  });

  it('keeps an operator lifecycle status (DISCONTINUED / EXPIRED) across projections', () => {
    // SCENARIO: a discontinued chemical still holding stock. EXPECTS: stays DISCONTINUED.
    expect(
      deriveCatalogStockStatus(ChemicalStatus.DISCONTINUED, { onHand: 50, onOrder: 0 }, 10, CHEM),
    ).toBe(ChemicalStatus.DISCONTINUED);
    expect(
      deriveCatalogStockStatus(ChemicalStatus.EXPIRED, { onHand: 0, onOrder: 0 }, 10, CHEM),
    ).toBe(ChemicalStatus.EXPIRED);
  });
});

function tenantMetadata<T extends ObjectLiteral>(): Repository<T>['metadata'] {
  const tenantColumn = stub<
    NonNullable<ReturnType<Repository<T>['metadata']['findColumnWithPropertyName']>>
  >({ databaseName: 'tenantId' });
  return stub<Repository<T>['metadata']>({
    findColumnWithPropertyName: jest.fn((name: string) =>
      name === 'tenantId' ? tenantColumn : undefined,
    ),
  });
}

function harness(feed: Feed | null): {
  projector: CatalogStockProjector;
  manager: EntityManager;
  feedFindOne: jest.Mock;
  feedSave: jest.Mock;
  getRepository: jest.Mock;
  onHandBySite: jest.Mock;
  onOrder: jest.Mock;
} {
  const feedFindOne = jest.fn().mockResolvedValue(feed);
  const feedSave = jest.fn();
  feedSave.mockImplementation(async (row: Feed) => row);
  const feedCreate = jest.fn();
  feedCreate.mockImplementation((row: Partial<Feed>) => row);
  const feedRepo = stub<Repository<Feed>>({
    metadata: tenantMetadata<Feed>(),
    findOne: feedFindOne,
    save: feedSave,
    create: feedCreate,
  });
  const getRepository = jest.fn();
  getRepository.mockImplementation((entity: unknown): unknown => {
    if (entity === Feed) return feedRepo;
    throw new Error(`unexpected repository request: ${String(entity)}`);
  });
  const onHandBySite = jest.fn().mockResolvedValue([
    { itemType: StorageItemType.FEED, itemId: FEED, siteId: 's1', onHand: 30 },
    { itemType: StorageItemType.FEED, itemId: FEED, siteId: 's2', onHand: 20 },
  ]);
  const onOrder = jest.fn().mockResolvedValue([]);
  const projector = new CatalogStockProjector(stub<StockLedgerReader>({ onHandBySite, onOrder }));
  return {
    projector,
    manager: stub<EntityManager>({ getRepository }),
    feedFindOne,
    feedSave,
    getRepository,
    onHandBySite,
    onOrder,
  };
}

describe('CatalogStockProjector.project', () => {
  it('writes the ledger pool on-hand and the derived status, locking the row first', async () => {
    // SCENARIO: ledger holds 30 + 20 at two sites; feed minStock 60.
    // EXPECTS: quantity 50, LOW_STOCK, row read under pessimistic_write.
    const feed = stub<Feed>({
      id: FEED,
      tenantId: TENANT,
      quantity: 999,
      minStock: 60,
      status: FeedStatus.AVAILABLE,
    });
    const { projector, manager, feedFindOne, feedSave, onHandBySite } = harness(feed);

    await projector.project(manager, TENANT, StorageItemType.FEED, FEED);

    expect(feedFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(onHandBySite).toHaveBeenCalledWith(manager, TENANT, {
      kind: 'item',
      key: { itemType: StorageItemType.FEED, itemId: FEED },
    });
    expect(feedSave).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 50, status: FeedStatus.LOW_STOCK }),
    );
  });

  it('counts the open-order remainder: a covered shortfall projects AVAILABLE (V-B1-4)', async () => {
    // SCENARIO: 50 on hand, minStock 60, 25 on an open order (position 75).
    // EXPECTS: AVAILABLE — the same answer the storage overview's pool tier gives;
    // the old on-hand-only rule projected LOW_STOCK here.
    const feed = stub<Feed>({
      id: FEED,
      tenantId: TENANT,
      quantity: 0,
      minStock: 60,
      status: FeedStatus.LOW_STOCK,
    });
    const { projector, manager, feedSave, onOrder } = harness(feed);
    onOrder.mockResolvedValueOnce([{ itemType: StorageItemType.FEED, itemId: FEED, onOrder: 25 }]);

    await projector.project(manager, TENANT, StorageItemType.FEED, FEED);

    expect(onOrder).toHaveBeenCalledWith(manager, TENANT, {
      kind: 'item',
      key: { itemType: StorageItemType.FEED, itemId: FEED },
    });
    expect(feedSave).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 50, status: FeedStatus.AVAILABLE }),
    );
  });

  it('keeps DISCONTINUED on a discontinued feed (the old roll-up overwrote it)', async () => {
    // SCENARIO: discontinued feed with stock. EXPECTS: quantity updated, status kept.
    const feed = stub<Feed>({
      id: FEED,
      tenantId: TENANT,
      quantity: 0,
      minStock: 10,
      status: FeedStatus.DISCONTINUED,
    });
    const { projector, manager, feedSave } = harness(feed);

    await projector.project(manager, TENANT, StorageItemType.FEED, FEED);

    expect(feedSave).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 50, status: FeedStatus.DISCONTINUED }),
    );
  });

  it('writes nothing for spare parts (their stock is derived at read time, FARM-HIGH-338)', async () => {
    // SCENARIO: a spare-part movement. EXPECTS: no repository touched, no ledger read.
    const { projector, manager, getRepository, onHandBySite } = harness(null);

    await projector.project(manager, TENANT, StorageItemType.SPARE_PART, 'part-1');

    expect(getRepository).not.toHaveBeenCalled();
    expect(onHandBySite).not.toHaveBeenCalled();
  });
});
