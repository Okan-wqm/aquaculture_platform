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
    // SCENARIO: stock bands from ledger on-hand vs minStock. EXPECTS: derived band.
    [ChemicalStatus.AVAILABLE, 0, 10, ChemicalStatus.OUT_OF_STOCK],
    [ChemicalStatus.AVAILABLE, 10, 10, ChemicalStatus.LOW_STOCK],
    [ChemicalStatus.LOW_STOCK, 11, 10, ChemicalStatus.AVAILABLE],
    [ChemicalStatus.OUT_OF_STOCK, 5, 0, ChemicalStatus.AVAILABLE],
  ] as const)('%p with on-hand %p, min %p → %p', (current, onHand, min, expected) => {
    expect(deriveCatalogStockStatus(current, onHand, min, CHEM)).toBe(expected);
  });

  it('keeps an operator lifecycle status (DISCONTINUED / EXPIRED) across projections', () => {
    // SCENARIO: a discontinued chemical still holding stock. EXPECTS: stays DISCONTINUED.
    expect(deriveCatalogStockStatus(ChemicalStatus.DISCONTINUED, 50, 10, CHEM)).toBe(
      ChemicalStatus.DISCONTINUED,
    );
    expect(deriveCatalogStockStatus(ChemicalStatus.EXPIRED, 0, 10, CHEM)).toBe(
      ChemicalStatus.EXPIRED,
    );
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
  const projector = new CatalogStockProjector(stub<StockLedgerReader>({ onHandBySite }));
  return {
    projector,
    manager: stub<EntityManager>({ getRepository }),
    feedFindOne,
    feedSave,
    getRepository,
    onHandBySite,
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
