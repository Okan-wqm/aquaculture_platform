/**
 * DeleteHarvestRecordHandler — Transactional Outbox Unit Tests
 *
 * Handler does cascade reversal (batch quantity + retention rate,
 * tank-batch totals, tank biomass/count) then flips harvest record
 * status to CANCELLED, all inside the fail-closed `runInTenantTransaction`
 * boundary (modelled by createMockDataSource). The pre-flight read +
 * status validation run BEFORE the boundary opens. This spec pins the
 * `HarvestRecordCancelledEvent` enqueued inside the same tx.
 *
 * Tests:
 *   1. Cancellation path (IN_PROGRESS / PLANNED) — event carries
 *      reversed quantity + biomass + cancelledAt.
 *   2. DISPATCHED → BadRequestException BEFORE any tx opens.
 *   3. DELIVERED → BadRequestException BEFORE any tx opens.
 *   4. Outbox enqueue failure → rollback, no soft-delete committed.
 *   5. NotFoundException when the record is missing.
 *   6. No tankId → only batch reversal, event still fires with
 *      `tankId=undefined`.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';
import type { EntityManager, Repository } from 'typeorm';

import { DeleteHarvestRecordHandler } from '../../handlers/delete-harvest-record.handler';
import { DeleteHarvestRecordCommand } from '../../commands/delete-harvest-record.command';
import { HarvestRecord, HarvestRecordStatus } from '../../entities/harvest-record.entity';
import { Batch } from '../../../batch/entities/batch.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import type { OutboxPublisher } from '@platform/outbox';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import { RecordingBatchAggregateMutationPort } from '../../../__tests__/support/durable-mutation-test-authority';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

interface HarnessOpts {
  record?: Partial<HarvestRecord> | null;
  batch?: Partial<Batch> | null;
  tankBatch?: Partial<TankBatch> | null;
  tank?: Partial<Tank> | null;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const record: Partial<HarvestRecord> | null =
    opts.record === null
      ? null
      : ({
          id: 'hr-1',
          tenantId: TENANT_ID,
          batchId: 'batch-1',
          tankId: 'tank-1',
          status: HarvestRecordStatus.IN_PROGRESS,
          quantityHarvested: 100,
          totalBiomass: 350,
          ...(opts.record ?? {}),
        } as unknown as HarvestRecord);

  const batch: Partial<Batch> | null =
    opts.batch === null
      ? null
      : ({
          id: 'batch-1',
          tenantId: TENANT_ID,
          currentQuantity: 900,
          harvestedQuantity: 100,
          initialQuantity: 1000,
          getRetentionRate: jest.fn(() => 100),
          ...(opts.batch ?? {}),
        } as unknown as Batch);

  const tankBatch: Partial<TankBatch> | null =
    opts.tankBatch === null
      ? null
      : ({
          id: 'tb-1',
          tenantId: TENANT_ID,
          tankId: 'tank-1',
          totalQuantity: 200,
          totalBiomassKg: 700,
          currentQuantity: 200,
          currentBiomassKg: 700,
          avgWeightG: 3500,
          ...(opts.tankBatch ?? {}),
        } as unknown as TankBatch);

  const tank: Partial<Tank> | null =
    opts.tank === null
      ? null
      : ({
          id: 'tank-1',
          tenantId: TENANT_ID,
          currentBiomass: 500,
          currentCount: 200,
          ...(opts.tank ?? {}),
        } as unknown as Tank);

  const harvestRepository = {
    findOne: jest.fn().mockResolvedValue(record),
  };
  const batchRepository = {} as unknown as Repository<Batch>;
  const tankBatchRepository = {} as unknown as Repository<TankBatch>;
  const tankRepository = {} as unknown as Repository<Tank>;

  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  (mockManager.findOne as jest.Mock).mockImplementation(async (Entity: unknown) => {
    const name = (Entity as { name?: string }).name;
    // The record is read INSIDE the transaction under pessimistic_write (the
    // cancellation state-transition guard) — served from the txn manager.
    if (name === 'HarvestRecord') return record;
    if (name === 'Batch') return batch;
    if (name === 'TankBatch') return tankBatch;
    if (name === 'Tank') return tank;
    return null;
  });
  (mockManager.save as jest.Mock).mockImplementation(async (_: unknown, entity: unknown) => entity);

  const enqueue = jest.fn(async (event: unknown, em: EntityManager) => {
    if (opts.enqueueImpl) return opts.enqueueImpl(event, em);
    return undefined;
  });
  const outboxPublisher = { enqueue } as unknown as OutboxPublisher;
  const farmStockProjection = new FarmStockProjectionService();
  const refreshContainers = jest
    .spyOn(farmStockProjection, 'refreshContainers')
    .mockResolvedValue(undefined);
  // The single SSoT writer for tank composition — the reversal restores
  // batchDetails[] through this, never by direct field arithmetic.
  const applyBatchDelta = jest.fn().mockResolvedValue(undefined);
  const tankBatchService = { applyBatchDelta };

  const handler = new DeleteHarvestRecordHandler(
    new RecordingBatchAggregateMutationPort(mockManager),
    harvestRepository as unknown as Repository<HarvestRecord>,
    batchRepository,
    tankBatchRepository,
    tankRepository,
    mockDataSource,
    outboxPublisher,
    tankBatchService as never,
    farmStockProjection,
  );

  return {
    handler,
    enqueue,
    commit: mockQueryRunner.commitTransaction as jest.Mock,
    rollback: mockQueryRunner.rollbackTransaction as jest.Mock,
    refreshContainers,
    applyBatchDelta,
  };
}

function makeCommand() {
  return new DeleteHarvestRecordCommand(TENANT_ID, 'hr-1', 'user-1');
}

describe('DeleteHarvestRecordHandler — transactional outbox', () => {
  it('cancellation path: emits HarvestRecordCancelled with reversed quantity + biomass', async () => {
    const { handler, enqueue, commit, refreshContainers } = makeHarness();

    const result = await handler.execute(makeCommand());

    expect(result).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('HarvestRecordCancelled');
    expect(event['harvestRecordId']).toBe('hr-1');
    expect(event['batchId']).toBe('batch-1');
    expect(event['tankId']).toBe('tank-1');
    expect(event['reversedQuantity']).toBe(100);
    expect(event['reversedBiomassKg']).toBe(350);
    expect(typeof event['cancelledAt']).toBe('string');

    expect(refreshContainers).toHaveBeenCalledWith(expect.any(Object), TENANT_ID, ['tank-1']);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('routes the reversal through the SSoT writer with a positive signed delta (batchDetails restored)', async () => {
    const { handler, applyBatchDelta } = makeHarness();

    await handler.execute(makeCommand());

    // The reversal must re-add the harvested fish through applyBatchDelta so
    // batchDetails[] is restored in lock-step — not by hand-incrementing
    // totalQuantity (which left the per-batch SSoT stale).
    expect(applyBatchDelta).toHaveBeenCalledTimes(1);
    const call = applyBatchDelta.mock.calls[0];
    expect(call[2]).toBe(TENANT_ID);
    expect(call[3]).toBe('tank-1');
    const delta = call[4];
    expect(delta.batchId).toBe('batch-1');
    expect(delta.quantityDelta).toBe(100);
    expect(delta.biomassDelta).toBe(350);
  });

  it('rejects DISPATCHED harvests with no reversal side effects', async () => {
    const { handler, enqueue, applyBatchDelta } = makeHarness({
      record: { status: HarvestRecordStatus.DISPATCHED } as HarvestRecord,
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
    expect(applyBatchDelta).not.toHaveBeenCalled();
  });

  it('rejects DELIVERED harvests with no reversal side effects', async () => {
    const { handler, enqueue, applyBatchDelta } = makeHarness({
      record: { status: HarvestRecordStatus.DELIVERED } as HarvestRecord,
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
    expect(applyBatchDelta).not.toHaveBeenCalled();
  });

  it('rejects an already-CANCELLED record — cancellation is a state transition, not a repeatable side effect', async () => {
    const { handler, enqueue, applyBatchDelta } = makeHarness({
      record: { status: HarvestRecordStatus.CANCELLED } as HarvestRecord,
    });

    // The pre-fix guard let CANCELLED pass: every re-delete re-added
    // quantityHarvested to the batch AND the tank (double-restocking).
    await expect(handler.execute(makeCommand())).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
    expect(applyBatchDelta).not.toHaveBeenCalled();
  });

  it('outbox enqueue failure rolls back the entire cascade', async () => {
    const { handler, rollback, commit } = makeHarness({
      enqueueImpl: async () => {
        throw new Error('outbox-enqueue-failed');
      },
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow('outbox-enqueue-failed');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('NotFoundException when harvest record is missing — no event', async () => {
    const { handler, enqueue } = makeHarness({ record: null });

    await expect(handler.execute(makeCommand())).rejects.toThrow(NotFoundException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('records without tankId still emit the event (tankId undefined)', async () => {
    const { handler, enqueue } = makeHarness({
      record: {
        id: 'hr-2',
        tenantId: TENANT_ID,
        batchId: 'batch-1',
        status: HarvestRecordStatus.IN_PROGRESS,
        quantityHarvested: 50,
        totalBiomass: 200,
        tankId: undefined as unknown as string,
      } as unknown as HarvestRecord,
    });

    await handler.execute(makeCommand());

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['tankId']).toBeUndefined();
    expect(event['reversedQuantity']).toBe(50);
  });
});
