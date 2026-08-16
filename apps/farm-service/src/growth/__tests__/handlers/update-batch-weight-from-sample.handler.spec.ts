/**
 * UpdateBatchWeightFromSampleHandler Unit Tests
 *
 * The handler applies a measurement to a batch's weight.actual provenance
 * INSIDE a runInTenantTransaction with a pessimistic_write lock, mutating
 * ONLY the provenance fields (avgWeight, totalBiomass, lastMeasuredAt,
 * sampleSize, confidencePercent) on the locked in-tx row — never saving an
 * externally-loaded full snapshot. This pins:
 *
 *   1. The write targets the LOCKED in-tx batch (queryRunner.manager.findOne
 *      with pessimistic_write), and only provenance fields are touched.
 *   2. isProcessed flips atomically with the weight update (single tx commit).
 *   3. Already-processed measurement is rejected before any tx work.
 *   4. Missing measurement / missing locked batch throw correctly.
 *
 * tenantId is a valid UUID v4 (runInTenantTransaction rejects non-UUIDs).
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';

import { UpdateBatchWeightFromSampleHandler } from '../../handlers/update-batch-weight-from-sample.handler';
import { UpdateBatchWeightFromSampleCommand } from '../../commands/update-batch-weight-from-sample.command';
import { GrowthMeasurement } from '../../entities/growth-measurement.entity';
import { Batch } from '../../../batch/entities/batch.entity';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';
import { RecordingBatchAggregateMutationPort } from '../../../__tests__/support/durable-mutation-test-authority';

const TENANT_UUID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = 'batch-1';
const MEASUREMENT_ID = 'measurement-1';

interface HarnessOpts {
  measurement?: Partial<GrowthMeasurement> | null;
  lockedBatch?: Partial<Batch> | null;
}

function makeHarness(opts: HarnessOpts = {}) {
  const lockedBatchRow: Partial<Batch> | null =
    opts.lockedBatch === null
      ? null
      : {
          id: BATCH_ID,
          tenantId: TENANT_UUID,
          // Live count + a stale weight snapshot — the handler must NOT touch
          // currentQuantity (would be a lost-update vs concurrent removals).
          currentQuantity: 4800,
          weight: {
            initial: { avgWeight: 5, totalBiomass: 25, measuredAt: new Date() },
            theoretical: { avgWeight: 0, totalBiomass: 0, lastCalculatedAt: new Date(), basedOnFCR: 0 },
            actual: {
              avgWeight: 10,
              totalBiomass: 48,
              lastMeasuredAt: new Date('2026-01-01T00:00:00Z'),
              sampleSize: 30,
              confidencePercent: 80,
            },
            variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
          } as Batch['weight'],
          ...(opts.lockedBatch ?? {}),
        };

  const batchSave = jest.fn(async (entity: Batch) => entity);
  const measurementSave = jest.fn(async (entity: GrowthMeasurement) => entity);

  const commit = jest.fn().mockResolvedValue(undefined);
  const rollback = jest.fn().mockResolvedValue(undefined);
  const release = jest.fn().mockResolvedValue(undefined);
  // EntityManager mock from the shared @aquaculture/testing factory (already
  // jest.Mocked<EntityManager> — assignable to queryRunner.manager without a
  // cast). DRIVE behaviour through mockImplementation so the heavily-overloaded
  // EntityManager.save/findOne MockInstance types stay intact; the impls
  // delegate to the standalone batchSave/measurementSave spies the assertions
  // read. WHY: a bare `mockManager.save = managerSave` assignment fails to
  // typecheck (loose jest.fn vs the overloaded MockInstance) — replacing the
  // function preserves the mock's typed signature instead of clobbering it.
  const { mockManager } = createMockDataSource();
  mockManager.save.mockImplementation((Entity, entity) => {
    const name = (Entity as { name?: string }).name;
    if (name === 'Batch') return batchSave(entity as Batch);
    if (name === 'GrowthMeasurement') return measurementSave(entity as GrowthMeasurement);
    return Promise.resolve(entity);
  });
  mockManager.findOne.mockImplementation((Entity) => {
    const name = (Entity as { name?: string }).name;
    if (name === 'Batch') {
      return Promise.resolve(opts.lockedBatch === null ? null : (lockedBatchRow as Batch));
    }
    return Promise.resolve(null);
  });
  const queryRunner: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: commit,
    rollbackTransaction: rollback,
    release,
    query: jest.fn().mockResolvedValue([]),
    manager: mockManager,
  };
  const dataSource: Partial<DataSource> = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };

  const measurement: Partial<GrowthMeasurement> | null =
    opts.measurement === null
      ? null
      : {
          id: MEASUREMENT_ID,
          tenantId: TENANT_UUID,
          batchId: BATCH_ID,
          averageWeight: 85,
          estimatedBiomass: 408,
          measurementDate: new Date('2026-03-01T00:00:00Z'),
          sampleSize: 100,
          isProcessed: false,
          ...(opts.measurement ?? {}),
        };

  const measurementRepository = createMockRepository<GrowthMeasurement>();
  // The harness builds a Partial<GrowthMeasurement> fixture (no entity methods);
  // a single cast satisfies the strictly-typed mock's resolve value.
  measurementRepository.findOne.mockResolvedValue(measurement as GrowthMeasurement | null);

  const handler = new UpdateBatchWeightFromSampleHandler(
    new RecordingBatchAggregateMutationPort(mockManager),
    dataSource as DataSource,
    measurementRepository,
  );

  return {
    handler,
    mockManager,
    batchSave,
    measurementSave,
    commit,
    rollback,
    lockedBatchRow,
  };
}

function makeCommand(): UpdateBatchWeightFromSampleCommand {
  return new UpdateBatchWeightFromSampleCommand(TENANT_UUID, BATCH_ID, MEASUREMENT_ID, 'user-1');
}

describe('UpdateBatchWeightFromSampleHandler', () => {
  it('applies the measurement to the LOCKED in-tx batch, provenance fields only', async () => {
    const { handler, mockManager, batchSave, commit } = makeHarness();

    const result = await handler.execute(makeCommand());

    // Locked read with pessimistic_write.
    expect(mockManager.findOne).toHaveBeenCalledWith(
      Batch,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    // Provenance fields updated from the measurement.
    expect(result.weight.actual.avgWeight).toBe(85);
    expect(result.weight.actual.totalBiomass).toBe(408);
    expect(result.weight.actual.sampleSize).toBe(100);
    expect(result.weight.actual.confidencePercent).toBe(95);
    // currentQuantity is NEVER touched (no lost-update of concurrent removals).
    expect(result.currentQuantity).toBe(4800);
    expect(batchSave).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('flips isProcessed atomically with the weight write', async () => {
    const { handler, measurementSave } = makeHarness();

    await handler.execute(makeCommand());

    expect(measurementSave).toHaveBeenCalledTimes(1);
    const saved = measurementSave.mock.calls[0]![0] as GrowthMeasurement;
    expect(saved.isProcessed).toBe(true);
  });

  it('rejects an already-processed measurement before any tx work', async () => {
    const { handler, mockManager } = makeHarness({
      measurement: { isProcessed: true },
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(BadRequestException);
    expect(mockManager.findOne).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the measurement is missing', async () => {
    const { handler } = makeHarness({ measurement: null });

    await expect(handler.execute(makeCommand())).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException and rolls back when the locked batch is missing', async () => {
    const { handler, rollback, commit } = makeHarness({ lockedBatch: null });

    await expect(handler.execute(makeCommand())).rejects.toThrow(NotFoundException);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });
});
