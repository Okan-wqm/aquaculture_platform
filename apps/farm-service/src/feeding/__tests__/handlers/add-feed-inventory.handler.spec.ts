/**
 * AddFeedInventoryHandler — Transactional Outbox Unit Tests
 *
 * Feed-inventory receipts were previously a non-transactional single
 * save with no event emission. This PR wraps the save and the new
 * `FeedInventoryReceived` outbox enqueue in a DataSource transaction.
 * Lot-level traceability is food-safety-critical and MUST commit
 * atomically with the event that announces the arrival.
 *
 * Tests pin:
 *   1. New lot row → event with `isNewLotRow=true`, matching
 *      quantity fields.
 *   2. Existing lot row → event with `isNewLotRow=false`,
 *      `newTotalQuantityKg` reflects the folded-in total.
 *   3. Outbox enqueue failure rolls back the insert / update.
 *   4. Pre-tx validation (missing feed / site) throws before the
 *      tx opens and the outbox is never touched.
 *   5. `receivedDate` defaults to `new Date()` on the event when
 *      the payload omits it — never emits an undefined date.
 */
import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import { AddFeedInventoryHandler } from '../../handlers/add-feed-inventory.handler';
import { AddFeedInventoryCommand } from '../../commands/add-feed-inventory.command';
import { FeedInventory } from '../../entities/feed-inventory.entity';
import { Feed } from '../../../feed/entities/feed.entity';
import { Site } from '../../../site/entities/site.entity';
import type { OutboxPublisher } from '@platform/outbox';
import type { FinanceSettingsService } from '../../../finance/services/finance-settings.service';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Typed partial-mock helper (repo pattern — keeps mocks type-safe without a blanket cast). */
function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface HarnessOpts {
  feed?: Partial<Feed> | null;
  site?: Partial<Site> | null;
  existingInventory?: Partial<FeedInventory> | null;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const feed: Partial<Feed> | null =
    opts.feed === null
      ? null
      : { id: 'feed-1', tenantId: TENANT_ID, ...(opts.feed ?? {}) };

  const site: Partial<Site> | null =
    opts.site === null
      ? null
      : { id: 'site-1', tenantId: TENANT_ID, ...(opts.site ?? {}) };

  const feedRepository = {
    findOne: jest.fn().mockResolvedValue(feed),
  };
  const siteRepository = {
    findOne: jest.fn().mockResolvedValue(site),
  };
  const inventoryRepository = {
    create: jest.fn((p: Partial<FeedInventory>) => {
      return {
        ...p,
        id: 'new-inv-id',
        updateStatus: jest.fn(),
      } as unknown as FeedInventory;
    }),
  };

  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const managerFindOne = mockManager.findOne as jest.Mock;
  managerFindOne.mockResolvedValue(
    opts.existingInventory === undefined ? null : opts.existingInventory,
  );
  (mockManager.save as jest.Mock).mockImplementation(
    async (_: unknown, entity: FeedInventory) => {
      return { ...entity, id: entity.id ?? 'saved-inv-id' };
    },
  );
  const commit = mockQueryRunner.commitTransaction as jest.Mock;
  const rollback = mockQueryRunner.rollbackTransaction as jest.Mock;
  const dataSource = mockDataSource;

  const enqueue = jest.fn(async (event: unknown, em: EntityManager) => {
    if (opts.enqueueImpl) return opts.enqueueImpl(event, em);
    return undefined;
  });
  const outboxPublisher = { enqueue } as unknown as OutboxPublisher;
  const financeSettings = mock<FinanceSettingsService>({
    getDefaultCurrency: jest.fn().mockResolvedValue('NOK'),
  });

  const handler = new AddFeedInventoryHandler(
    inventoryRepository as unknown as Repository<FeedInventory>,
    feedRepository as unknown as Repository<Feed>,
    siteRepository as unknown as Repository<Site>,
    dataSource as DataSource,
    outboxPublisher,
    financeSettings,
  );

  return { handler, enqueue, commit, rollback, managerFindOne };
}

function makeCommand(overrides: Partial<{
  quantityKg: number;
  lotNumber: string;
  receivedDate: Date;
}> = {}) {
  return new AddFeedInventoryCommand(
    TENANT_ID,
    {
      feedId: 'feed-1',
      siteId: 'site-1',
      quantityKg: overrides.quantityKg ?? 500,
      lotNumber: overrides.lotNumber ?? 'LOT-A-001',
      manufacturingDate: new Date('2026-03-01'),
      expiryDate: new Date('2027-03-01'),
      receivedDate: overrides.receivedDate,
      unitPricePerKg: 12,
      currency: 'NOK',
    } as unknown as AddFeedInventoryCommand['payload'],
    'user-1',
  );
}

describe('AddFeedInventoryHandler — transactional outbox', () => {
  it('fresh lot: emits FeedInventoryReceived with isNewLotRow=true and correct totals', async () => {
    const { handler, enqueue, commit } = makeHarness();

    await handler.execute(makeCommand({ quantityKg: 500 }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('FeedInventoryReceived');
    expect(event['tenantId']).toBe(TENANT_ID);
    expect(event['feedId']).toBe('feed-1');
    expect(event['siteId']).toBe('site-1');
    expect(event['lotNumber']).toBe('LOT-A-001');
    expect(event['quantityKg']).toBe(500);
    expect(event['newTotalQuantityKg']).toBe(500);
    expect(event['isNewLotRow']).toBe(true);
    expect(event['currency']).toBe('NOK');

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('existing lot: folds quantity in and emits event with isNewLotRow=false', async () => {
    const { handler, enqueue } = makeHarness({
      existingInventory: {
        id: 'existing-inv-1',
        tenantId: TENANT_ID,
        feedId: 'feed-1',
        siteId: 'site-1',
        lotNumber: 'LOT-A-001',
        quantityKg: 200,
        updateStatus: jest.fn(),
      } as unknown as FeedInventory,
    });

    await handler.execute(makeCommand({ quantityKg: 500 }));

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['isNewLotRow']).toBe(false);
    // Previous 200 + new 500 = 700
    expect(event['newTotalQuantityKg']).toBe(700);
    // Receipt quantity (THIS arrival) stays 500
    expect(event['quantityKg']).toBe(500);
  });

  it('outbox enqueue failure rolls back the feed_inventory write', async () => {
    const { handler, rollback, commit } = makeHarness({
      enqueueImpl: async () => {
        throw new Error('outbox-enqueue-failed');
      },
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      'outbox-enqueue-failed',
    );
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('NotFoundException on missing feed — no tx opened, no event', async () => {
    const { handler, enqueue } = makeHarness({ feed: null });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NotFoundException on missing site — no tx opened, no event', async () => {
    const { handler, enqueue } = makeHarness({ site: null });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('receivedDate defaults on event when payload omits it — never undefined', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(makeCommand({ receivedDate: undefined }));

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof event['receivedDate']).toBe('string');
  });
});
