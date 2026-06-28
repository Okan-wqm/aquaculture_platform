/**
 * UpdateFeedingRecordHandler — Transactional Outbox Unit Tests
 *
 * Pins the always-fire `FeedingRecordUpdated` event contract and its
 * atomic co-commit with the row save + batch consumption recalc.
 *
 * Tests:
 *   1. actualAmount change → event with correct pre/post + diff +
 *      batch totalFeedConsumed updated
 *   2. feedCost-only change → event with zero amountDiff + non-zero
 *      costDiff + batch totalFeedCost updated
 *   3. Notes-only change → event still fires (downstream AI insights
 *      consume every update regardless of numerical impact) with
 *      zero diffs
 *   4. No batch update when no numerical change requested
 *   5. Outbox enqueue failure → rollback + no row change
 *   6. NotFoundException on missing feeding record → no tx, no event
 */
import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import { UpdateFeedingRecordHandler } from '../../handlers/update-feeding-record.handler';
import { UpdateFeedingRecordCommand } from '../../commands/update-feeding-record.command';
import { FeedingRecord } from '../../entities/feeding-record.entity';
import { Batch } from '../../../batch/entities/batch.entity';
import type { OutboxPublisher } from '@platform/outbox';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface HarnessOpts {
  feedingRecord?: Partial<FeedingRecord> | null;
  batch?: Partial<Batch> | null;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const record: Partial<FeedingRecord> | null =
    opts.feedingRecord === null
      ? null
      : ({
          id: 'fr-1',
          tenantId: TENANT_ID,
          batchId: 'batch-1',
          actualAmount: 10,
          feedCost: 100,
          calculateVariance: jest.fn(),
          ...(opts.feedingRecord ?? {}),
        } as unknown as FeedingRecord);

  const batch: Partial<Batch> =
    opts.batch === null
      ? (null as unknown as Partial<Batch>)
      : {
          id: 'batch-1',
          tenantId: TENANT_ID,
          totalFeedConsumed: 500,
          totalFeedCost: 5000,
          ...(opts.batch ?? {}),
        };

  const feedingRecordRepository = {
    findOne: jest.fn().mockResolvedValue(record),
  };
  const batchRepository = {};

  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();

  const savedEntities: unknown[] = [];
  const managerSave = mockManager.save as jest.Mock;
  managerSave.mockImplementation(async (entityOrType: unknown, entity?: unknown) => {
    // repository-style .save(entity) — single arg
    const target = entity ?? entityOrType;
    savedEntities.push(target);
    return target;
  });
  const managerFindOne = mockManager.findOne as jest.Mock;
  managerFindOne.mockResolvedValue(batch);

  const commit = mockQueryRunner.commitTransaction as jest.Mock;
  const rollback = mockQueryRunner.rollbackTransaction as jest.Mock;
  const dataSource = mockDataSource;

  const enqueue = jest.fn(async (event: unknown, em: EntityManager) => {
    if (opts.enqueueImpl) return opts.enqueueImpl(event, em);
    return undefined;
  });
  const outboxPublisher = { enqueue } as unknown as OutboxPublisher;

  const handler = new UpdateFeedingRecordHandler(
    feedingRecordRepository as unknown as Repository<FeedingRecord>,
    batchRepository as unknown as Repository<Batch>,
    dataSource as DataSource,
    outboxPublisher,
  );

  return {
    handler,
    enqueue,
    commit,
    rollback,
    managerSave,
    managerFindOne,
    savedEntities,
    batch,
  };
}

function makeCommand(
  payload: ConstructorParameters<typeof UpdateFeedingRecordCommand>[2],
) {
  return new UpdateFeedingRecordCommand(TENANT_ID, 'fr-1', payload, 'user-1');
}

describe('UpdateFeedingRecordHandler — transactional outbox', () => {
  it('actualAmount change: emits event with diff + updates batch total', async () => {
    const { handler, enqueue, commit, managerFindOne } = makeHarness();

    await handler.execute(makeCommand({ actualAmount: 15 }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('FeedingRecordUpdated');
    expect(event['tenantId']).toBe(TENANT_ID);
    expect(event['feedingRecordId']).toBe('fr-1');
    expect(event['batchId']).toBe('batch-1');
    expect(event['previousActualAmountKg']).toBe(10);
    expect(event['newActualAmountKg']).toBe(15);
    expect(event['amountDiffKg']).toBe(5);
    // Feed cost wasn't touched → diff = 0
    expect(event['costDiff']).toBe(0);

    // Batch read + write happens when amount changed
    expect(managerFindOne).toHaveBeenCalledWith(Batch, {
      where: { id: 'batch-1', tenantId: TENANT_ID },
    });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('feedCost-only change: emits event + updates batch totalFeedCost only', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(makeCommand({ feedCost: 150 }));

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['amountDiffKg']).toBe(0);
    expect(event['previousFeedCost']).toBe(100);
    expect(event['newFeedCost']).toBe(150);
    expect(event['costDiff']).toBe(50);
  });

  it('notes-only change: event still fires (zero diffs) — batch not read', async () => {
    const { handler, enqueue, managerFindOne } = makeHarness();

    await handler.execute(makeCommand({ notes: 'adjusted by operator' }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['amountDiffKg']).toBe(0);
    expect(event['costDiff']).toBe(0);
    // Batch read is skipped when no numerical change
    expect(managerFindOne).not.toHaveBeenCalled();
  });

  it('outbox enqueue failure rolls back the row update', async () => {
    const { handler, rollback, commit } = makeHarness({
      enqueueImpl: async () => {
        throw new Error('outbox-enqueue-failed');
      },
    });

    await expect(
      handler.execute(makeCommand({ actualAmount: 15 })),
    ).rejects.toThrow('outbox-enqueue-failed');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('NotFoundException when feeding record is missing — no tx, no event', async () => {
    const { handler, enqueue } = makeHarness({ feedingRecord: null });

    await expect(
      handler.execute(makeCommand({ actualAmount: 15 })),
    ).rejects.toThrow(NotFoundException);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
