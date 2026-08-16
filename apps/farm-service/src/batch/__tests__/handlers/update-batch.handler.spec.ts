/**
 * UpdateBatchHandler — Transactional Outbox Unit Tests
 *
 * Closes the final farm-service outbox gap. The handler previously
 * did a single non-transactional save with no event. This spec
 * pins the new architecture:
 *
 *   - DataSource transaction wraps findOne + save + outbox enqueue.
 *   - `BatchMetadataUpdatedEvent` fires inside the tx with
 *     `changedFields[]` narrowed to the touched fields.
 *
 * Tests (superset of the pre-existing IP-3 coverage):
 *   1. Name change → batch name updated on save, event carries
 *      changedFields=['name'].
 *   2. Untouched fields preserved — notes update doesn't clobber
 *      name.
 *   3. NotFoundException on missing batch — no tx commit.
 *   4. updatedBy stamped on save.
 *   5. Target FCR change — event's newTargetFCR matches payload.
 *   6. Empty payload — changedFields=[], event still fires (audit).
 *   7. Outbox enqueue failure → rollback, no save committed.
 */
import { NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';

import { UpdateBatchHandler } from '../../handlers/update-batch.handler';
import { UpdateBatchCommand } from '../../commands/update-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import type { OutboxPublisher } from '@platform/outbox';
import { RecordingBatchAggregateMutationPort } from '../../../__tests__/support/durable-mutation-test-authority';

interface HarnessOpts {
  batch?: Partial<Batch> | null;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const batch: Partial<Batch> | null =
    opts.batch === null
      ? null
      : ({
          id: 'batch-1',
          tenantId: 'tenant-1',
          name: 'Old Name',
          notes: 'Keep These Notes',
          status: BatchStatus.GROWING,
          fcr: { target: 1.2, isUserOverride: false, lastUpdatedAt: new Date() },
          growthMetrics: { projections: {} },
          isActive: true,
          ...(opts.batch ?? {}),
        } as unknown as Batch);

  const managerFindOne = jest.fn().mockResolvedValue(batch);
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
    // runInTenantTransaction pins search_path + asserts the RLS GUC via
    // queryRunner.query. Returning [] makes the boundary's readback assertion
    // skip (no live DB), so the unit test exercises pure handler logic.
    query: jest.fn().mockResolvedValue([]),
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

  const batchRepository = {} as unknown as Repository<Batch>;

  const handler = new UpdateBatchHandler(
    new RecordingBatchAggregateMutationPort(queryRunner.manager),
    batchRepository,
    dataSource as DataSource,
    outboxPublisher,
  );

  return { handler, enqueue, commit, rollback, managerSave };
}

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'user-1';

function makeCommand(payload: ConstructorParameters<typeof UpdateBatchCommand>[2]) {
  return new UpdateBatchCommand(TENANT, 'batch-1', payload, USER);
}

describe('UpdateBatchHandler — transactional outbox', () => {
  it('updates the batch name and emits BatchMetadataUpdated with changedFields=[name]', async () => {
    const { handler, enqueue, managerSave } = makeHarness();

    const result = await handler.execute(makeCommand({ name: 'New Name' }));

    expect(result.name).toBe('New Name');
    expect(managerSave).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('BatchMetadataUpdated');
    expect(event['changedFields']).toEqual(['name']);
  });

  it('does not overwrite fields not in payload (notes-only edit preserves name)', async () => {
    const { handler, enqueue } = makeHarness();

    const result = await handler.execute(makeCommand({ notes: 'Updated Notes' }));

    expect(result.name).toBe('Old Name');
    expect(result.notes).toBe('Updated Notes');
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['changedFields']).toEqual(['notes']);
  });

  it('throws NotFoundException when batch is missing — no tx commit, no event', async () => {
    const { handler, enqueue, commit } = makeHarness({ batch: null });

    await expect(handler.execute(makeCommand({ name: 'X' }))).rejects.toThrow(NotFoundException);
    expect(enqueue).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('stamps updatedBy on save', async () => {
    const { handler } = makeHarness();

    const result = await handler.execute(makeCommand({ name: 'Updated' }));

    expect(result.updatedBy).toBe(USER);
  });

  it('targetFCR change: event newTargetFCR reflects the payload', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(makeCommand({ targetFCR: 1.4 }));

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['changedFields']).toEqual(['targetFCR']);
    expect(event['newTargetFCR']).toBe(1.4);
  });

  it('empty payload: changedFields=[], event still fires (audit)', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(makeCommand({}));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['changedFields']).toEqual([]);
  });

  it('outbox enqueue failure rolls back the batch save', async () => {
    const { handler, rollback, commit } = makeHarness({
      enqueueImpl: async () => {
        throw new Error('outbox-enqueue-failed');
      },
    });

    await expect(handler.execute(makeCommand({ notes: 'x' }))).rejects.toThrow(
      'outbox-enqueue-failed',
    );
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });
});
