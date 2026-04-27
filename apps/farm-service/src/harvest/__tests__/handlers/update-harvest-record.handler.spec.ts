/**
 * UpdateHarvestRecordHandler — Transactional Outbox Unit Tests
 *
 * Pins the `HarvestRecordUpdated` outbox contract. The handler
 * already runs a pessimistic_write transaction; this spec covers
 * the new enqueue:
 *
 *   1. Status + quantity change → `changedFields` lists both, event
 *      carries new `quantityHarvested` / `totalBiomass` / `status`.
 *   2. Notes-only change → `changedFields=['notes']`, numeric fields
 *      unchanged.
 *   3. No fields supplied → `changedFields=[]`, event still fires
 *      (audit record for the updatedBy stamp).
 *   4. Outbox enqueue failure rolls back the row save.
 *   5. Pessimistic_write lock requested.
 *   6. NotFoundException on missing record — no event.
 */
import { NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';

import { UpdateHarvestRecordHandler } from '../../handlers/update-harvest-record.handler';
import {
  UpdateHarvestRecordCommand,
  UpdateHarvestRecordData,
} from '../../commands/update-harvest-record.command';
import {
  HarvestRecord,
  HarvestRecordStatus,
} from '../../entities/harvest-record.entity';
import type { OutboxPublisher } from '@platform/outbox';

interface HarnessOpts {
  record?: Partial<HarvestRecord> | null;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const record: Partial<HarvestRecord> | null =
    opts.record === null
      ? null
      : ({
          id: 'hr-1',
          tenantId: 'tenant-1',
          batchId: 'batch-1',
          status: HarvestRecordStatus.IN_PROGRESS,
          quantityHarvested: 500,
          totalBiomass: 1500,
          ...(opts.record ?? {}),
        } as unknown as HarvestRecord);

  const managerFindOne = jest.fn().mockResolvedValue(record);
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

  const harvestRepository = {} as unknown as Repository<HarvestRecord>;

  const handler = new UpdateHarvestRecordHandler(
    dataSource as DataSource,
    harvestRepository,
    outboxPublisher,
  );

  return { handler, enqueue, commit, rollback, managerFindOne, managerSave };
}

function makeCommand(data: UpdateHarvestRecordData) {
  return new UpdateHarvestRecordCommand('tenant-1', 'hr-1', data, 'user-1');
}

describe('UpdateHarvestRecordHandler — transactional outbox', () => {
  it('status + quantity change: changedFields lists both, event reflects new values', async () => {
    const { handler, enqueue, commit } = makeHarness();

    await handler.execute(
      makeCommand({
        status: HarvestRecordStatus.COMPLETED,
        quantityHarvested: 600,
        totalBiomass: 1800,
      }),
    );

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.eventType).toBe('HarvestRecordUpdated');
    expect(event.harvestRecordId).toBe('hr-1');
    expect(event.batchId).toBe('batch-1');
    expect(event.changedFields).toEqual(
      expect.arrayContaining(['status', 'quantityHarvested', 'totalBiomass']),
    );
    expect(event.newQuantityHarvested).toBe(600);
    expect(event.newTotalBiomass).toBe(1800);
    expect(event.newStatus).toBe(HarvestRecordStatus.COMPLETED);

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('notes-only change: changedFields=["notes"], numeric fields unchanged', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(makeCommand({ notes: 'reviewed by supervisor' }));

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.changedFields).toEqual(['notes']);
    expect(event.newQuantityHarvested).toBe(500);
    expect(event.newTotalBiomass).toBe(1500);
  });

  it('no fields supplied: changedFields is empty but event still fires (audit)', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(makeCommand({}));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.changedFields).toEqual([]);
  });

  it('outbox enqueue failure rolls back the row save', async () => {
    const { handler, rollback, commit } = makeHarness({
      enqueueImpl: async () => {
        throw new Error('outbox-enqueue-failed');
      },
    });

    await expect(
      handler.execute(makeCommand({ notes: 'x' })),
    ).rejects.toThrow('outbox-enqueue-failed');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('requests a pessimistic_write lock on the harvest-record read', async () => {
    const { handler, managerFindOne } = makeHarness();

    await handler.execute(makeCommand({ notes: 'x' }));

    expect(managerFindOne).toHaveBeenCalledWith(HarvestRecord, {
      where: { id: 'hr-1', tenantId: 'tenant-1' },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('NotFoundException when harvest record is missing — no event', async () => {
    const { handler, enqueue } = makeHarness({ record: null });

    await expect(handler.execute(makeCommand({ notes: 'x' }))).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
