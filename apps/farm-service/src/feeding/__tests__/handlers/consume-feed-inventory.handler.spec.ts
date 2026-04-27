/**
 * ConsumeFeedInventoryHandler — Transactional Outbox Unit Tests
 *
 * Exercises the migration from direct-NATS `FeedInventoryLow` publish
 * (non-atomic, lost on NATS hiccup) to transactional outbox with two
 * event types:
 *
 *   1. `FeedInventoryConsumed` — always fires (food-safety
 *      traceability anchor)
 *   2. `FeedInventoryLow` — fires only when post-op status lands in
 *      the LOW_STOCK band
 *
 * Tests pin:
 *   - Happy path with normal stock → 1 consumed event only.
 *   - Post-op LOW_STOCK → 2 events (consumed + low).
 *   - Outbox enqueue failure → rollback, no decrement committed.
 *   - Pre-tx validation (OUT_OF_STOCK / EXPIRED-not-using-expired-
 *     reason / over-spend / missing row) rejects and emits NOTHING.
 *   - Pessimistic lock is requested on the inventory read.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';

import { ConsumeFeedInventoryHandler } from '../../handlers/consume-feed-inventory.handler';
import {
  ConsumeFeedInventoryCommand,
  ConsumptionReason,
} from '../../commands/consume-feed-inventory.command';
import { FeedInventory, InventoryStatus } from '../../entities/feed-inventory.entity';
import type { OutboxPublisher } from '@platform/outbox';

interface HarnessOpts {
  inventory?: Partial<FeedInventory> | null;
  postOpStatus?: InventoryStatus;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const inventoryRow: Partial<FeedInventory> | null =
    opts.inventory === null
      ? null
      : ({
          id: 'inv-1',
          tenantId: 'tenant-1',
          feedId: 'feed-1',
          siteId: 'site-1',
          quantityKg: 500,
          minStockKg: 100,
          status: InventoryStatus.AVAILABLE,
          unitPricePerKg: 10,
          updateStatus: jest.fn(function (this: FeedInventory) {
            if (opts.postOpStatus) {
              this.status = opts.postOpStatus;
            }
          }),
          ...(opts.inventory ?? {}),
        } as unknown as FeedInventory);

  const managerFindOne = jest.fn().mockResolvedValue(inventoryRow);
  const managerSave = jest.fn(async (_: unknown, entity: unknown) => entity);
  const commit = jest.fn().mockResolvedValue(undefined);
  const rollback = jest.fn().mockResolvedValue(undefined);
  const release = jest.fn().mockResolvedValue(undefined);
  const queryRunner: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: commit,
    rollbackTransaction: rollback,
    release,
    manager: {
      findOne: managerFindOne,
      save: managerSave,
    } as unknown as EntityManager,
  };
  const dataSource: Partial<DataSource> = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };

  const enqueue = jest.fn(async (event: unknown, em: EntityManager) => {
    if (opts.enqueueImpl) return opts.enqueueImpl(event, em);
    return undefined;
  });
  const outboxPublisher = { enqueue } as unknown as OutboxPublisher;

  const inventoryRepository = {} as unknown as Repository<FeedInventory>;

  const handler = new ConsumeFeedInventoryHandler(
    inventoryRepository,
    dataSource as DataSource,
    outboxPublisher,
  );

  return { handler, enqueue, commit, rollback, managerFindOne };
}

function makeCommand(overrides: Partial<{
  quantityKg: number;
  reason: ConsumptionReason;
}> = {}) {
  return new ConsumeFeedInventoryCommand(
    'tenant-1',
    {
      inventoryId: 'inv-1',
      quantityKg: overrides.quantityKg ?? 50,
      reason: overrides.reason ?? ConsumptionReason.FEEDING,
    },
    'user-1',
  );
}

describe('ConsumeFeedInventoryHandler — transactional outbox', () => {
  it('happy path (normal stock): emits FeedInventoryConsumed only (1 event)', async () => {
    const { handler, enqueue, commit } = makeHarness();

    await handler.execute(makeCommand({ quantityKg: 50 }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('FeedInventoryConsumed');
    expect(event['tenantId']).toBe('tenant-1');
    expect(event['inventoryId']).toBe('inv-1');
    expect(event['quantityKg']).toBe(50);
    // 500 - 50 = 450
    expect(event['newQuantityKg']).toBe(450);
    expect(event['reason']).toBe('feeding');
    expect(event['newStatus']).toBe(InventoryStatus.AVAILABLE);

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('post-op LOW_STOCK: emits BOTH FeedInventoryConsumed AND FeedInventoryLow (2 events)', async () => {
    const { handler, enqueue } = makeHarness({ postOpStatus: InventoryStatus.LOW_STOCK });

    await handler.execute(makeCommand({ quantityKg: 50 }));

    expect(enqueue).toHaveBeenCalledTimes(2);
    const eventTypes = enqueue.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>)['eventType'],
    );
    expect(eventTypes).toEqual(['FeedInventoryConsumed', 'FeedInventoryLow']);
    const lowEvent = enqueue.mock.calls[1]![0] as Record<string, unknown>;
    expect(lowEvent['status']).toBe('low_stock');
    expect(lowEvent['currentQuantityKg']).toBe(450);
    expect(lowEvent['reorderPointKg']).toBe(100);
  });

  it('requests a pessimistic_write lock on the inventory read', async () => {
    const { handler, managerFindOne } = makeHarness();

    await handler.execute(makeCommand({ quantityKg: 10 }));

    expect(managerFindOne).toHaveBeenCalledWith(FeedInventory, {
      where: { id: 'inv-1', tenantId: 'tenant-1' },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('outbox enqueue failure rolls back the decrement', async () => {
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

  it('NotFoundException when inventory is missing — no event emitted', async () => {
    const { handler, enqueue } = makeHarness({ inventory: null });
    await expect(handler.execute(makeCommand())).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('BadRequestException when stock is OUT_OF_STOCK — no event emitted', async () => {
    const { handler, enqueue } = makeHarness({
      inventory: { status: InventoryStatus.OUT_OF_STOCK } as FeedInventory,
    });
    await expect(handler.execute(makeCommand())).rejects.toThrow(
      BadRequestException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('BadRequestException when stock is EXPIRED and reason is not EXPIRED — no event emitted', async () => {
    const { handler, enqueue } = makeHarness({
      inventory: { status: InventoryStatus.EXPIRED, quantityKg: 500 } as FeedInventory,
    });
    await expect(
      handler.execute(makeCommand({ reason: ConsumptionReason.FEEDING })),
    ).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('BadRequestException on quantity over-spend — no event emitted', async () => {
    const { handler, enqueue } = makeHarness();
    await expect(
      handler.execute(makeCommand({ quantityKg: 9999 })),
    ).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
