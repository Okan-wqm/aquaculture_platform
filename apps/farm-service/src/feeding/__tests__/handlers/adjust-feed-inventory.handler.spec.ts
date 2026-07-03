/**
 * AdjustFeedInventoryHandler — Transactional Outbox Unit Tests
 *
 * Third feed-inventory outbox PR. The handler previously had no
 * transaction and no event — manual corrections vanished from
 * every downstream projection. This spec pins the new atomic
 * contract: pessimistic-lock read + quantity write + event enqueue
 * commit together.
 *
 * Tests:
 *   1. INCREASE adjustment — event carries previous/new quantities,
 *      adjustmentType='increase'.
 *   2. DECREASE adjustment — same shape + validation that
 *      `previous - adjustment >= 0`.
 *   3. SET_QUANTITY adjustment — new quantity matches payload.
 *   4. DECREASE going negative rejects BEFORE any save / enqueue.
 *   5. SET_QUANTITY with a negative rejects BEFORE any save / enqueue.
 *   6. Outbox enqueue failure → rollback; no quantity change.
 *   7. NotFoundException on missing inventory row.
 *   8. `pessimistic_write` lock is requested on the inventory read.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import { AdjustFeedInventoryHandler } from '../../handlers/adjust-feed-inventory.handler';
import {
  AdjustFeedInventoryCommand,
  AdjustmentType,
} from '../../commands/adjust-feed-inventory.command';
import { FeedInventory } from '../../entities/feed-inventory.entity';
import type { OutboxPublisher } from '@platform/outbox';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface HarnessOpts {
  inventory?: Partial<FeedInventory> | null;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const inventory: Partial<FeedInventory> | null =
    opts.inventory === null
      ? null
      : ({
          id: 'inv-1',
          tenantId: TENANT_ID,
          feedId: 'feed-1',
          siteId: 'site-1',
          quantityKg: 200,
          unitPricePerKg: 10,
          notes: '',
          updateStatus: jest.fn(),
          ...(opts.inventory ?? {}),
        } as unknown as FeedInventory);

  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const managerFindOne = mockManager.findOne as jest.Mock;
  managerFindOne.mockResolvedValue(inventory);
  (mockManager.save as jest.Mock).mockImplementation(async (_: unknown, entity: unknown) => entity);
  const commit = mockQueryRunner.commitTransaction as jest.Mock;
  const rollback = mockQueryRunner.rollbackTransaction as jest.Mock;
  const dataSource = mockDataSource;

  const enqueue = jest.fn(async (event: unknown, em: EntityManager) => {
    if (opts.enqueueImpl) return opts.enqueueImpl(event, em);
    return undefined;
  });
  const outboxPublisher = { enqueue } as unknown as OutboxPublisher;

  const inventoryRepository = {} as unknown as Repository<FeedInventory>;

  const handler = new AdjustFeedInventoryHandler(
    inventoryRepository,
    dataSource as DataSource,
    outboxPublisher,
  );

  return { handler, enqueue, commit, rollback, managerFindOne };
}

function makeCommand(adjustmentType: AdjustmentType, quantity: number, reason = 'physical count') {
  return new AdjustFeedInventoryCommand(
    TENANT_ID,
    {
      inventoryId: 'inv-1',
      adjustmentType,
      quantity,
      reason,
      notes: 'unit test',
    },
    'user-1',
  );
}

describe('AdjustFeedInventoryHandler — transactional outbox', () => {
  it('INCREASE: emits FeedInventoryAdjusted with correct previous/new quantities', async () => {
    const { handler, enqueue, commit } = makeHarness();

    await handler.execute(makeCommand(AdjustmentType.INCREASE, 50));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('FeedInventoryAdjusted');
    expect(event['tenantId']).toBe(TENANT_ID);
    expect(event['inventoryId']).toBe('inv-1');
    expect(event['adjustmentType']).toBe('increase');
    expect(event['adjustmentQuantityKg']).toBe(50);
    expect(event['previousQuantityKg']).toBe(200);
    expect(event['newQuantityKg']).toBe(250);
    expect(event['reason']).toBe('physical count');
    expect(event['notes']).toBe('unit test');
    expect(typeof event['adjustedAt']).toBe('string');

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('DECREASE: subtracts from previous quantity and emits event', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(makeCommand(AdjustmentType.DECREASE, 40));

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['adjustmentType']).toBe('decrease');
    expect(event['previousQuantityKg']).toBe(200);
    expect(event['newQuantityKg']).toBe(160);
  });

  it('SET_QUANTITY: overrides the quantity and emits event', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(makeCommand(AdjustmentType.SET_QUANTITY, 75));

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['adjustmentType']).toBe('set_quantity');
    expect(event['previousQuantityKg']).toBe(200);
    expect(event['newQuantityKg']).toBe(75);
  });

  it('DECREASE below zero rejects before any save or enqueue', async () => {
    const { handler, enqueue, commit } = makeHarness();

    await expect(
      handler.execute(makeCommand(AdjustmentType.DECREASE, 9999)),
    ).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('SET_QUANTITY with negative value rejects before any save or enqueue', async () => {
    const { handler, enqueue } = makeHarness();

    await expect(
      handler.execute(makeCommand(AdjustmentType.SET_QUANTITY, -1)),
    ).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('outbox enqueue failure rolls back the quantity change', async () => {
    const { handler, rollback, commit } = makeHarness({
      enqueueImpl: async () => {
        throw new Error('outbox-enqueue-failed');
      },
    });

    await expect(
      handler.execute(makeCommand(AdjustmentType.INCREASE, 50)),
    ).rejects.toThrow('outbox-enqueue-failed');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('NotFoundException when inventory is missing — no event', async () => {
    const { handler, enqueue } = makeHarness({ inventory: null });

    await expect(
      handler.execute(makeCommand(AdjustmentType.INCREASE, 50)),
    ).rejects.toThrow(NotFoundException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('requests a pessimistic_write lock on the inventory read', async () => {
    const { handler, managerFindOne } = makeHarness();

    await handler.execute(makeCommand(AdjustmentType.INCREASE, 10));

    expect(managerFindOne).toHaveBeenCalledWith(FeedInventory, {
      where: { id: 'inv-1', tenantId: TENANT_ID },
      lock: { mode: 'pessimistic_write' },
    });
  });
});
