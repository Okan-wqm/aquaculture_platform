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
 *   5. A sample of a stocked tank takes the unit lock for the tank it names
 *      and moves that tank, exactly as RecordGrowthSampleHandler does
 *      (FARM-CRITICAL-454); a sample older than the batch's last weighing
 *      leaves weight.actual alone (FARM-MEDIUM-453); a sample stamped with the
 *      tank it was taken from is refused once the batch has left that tank,
 *      instead of moving the tank the batch went to.
 *
 * The sample applier and the unit writer are the REAL services (the unit
 * lock and the re-base are spied for the stocked-tank case); the recalc and
 * the read-model projection are typed doubles.
 *
 * tenantId is a valid UUID v4 (runInTenantTransaction rejects non-UUIDs).
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';

import { UpdateBatchWeightFromSampleHandler } from '../../handlers/update-batch-weight-from-sample.handler';
import { UpdateBatchWeightFromSampleCommand } from '../../commands/update-batch-weight-from-sample.command';
import { GrowthMeasurement } from '../../entities/growth-measurement.entity';
import { Batch } from '../../../batch/entities/batch.entity';
import type { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import {
  BiomassGrowthApplierService,
  type LockedUnit,
} from '../../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import { GrowthSampleApplierService } from '../../services/growth-sample-applier.service';
import {
  collaborator,
  createMockDataSource,
  createMockRepository,
  stub,
} from '@aquaculture/testing';

const TENANT_UUID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = 'batch-1';
const MEASUREMENT_ID = 'measurement-1';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface HarnessOpts {
  measurement?: Partial<GrowthMeasurement> | null;
  lockedBatch?: Partial<Batch> | null;
  /** Builds the unit lockUnitForGrowth returns, from the locked batch row. */
  lockedUnit?: (batch: Batch) => LockedUnit | null;
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
  // The unit lookup (BiomassGrowthApplierService.unitsHoldingBatch) runs on
  // the tx manager, whose shared factory double has no `query` member. No tank
  // holds the batch unless a case names one on the measurement.
  Object.assign(mockManager, { query: jest.fn().mockResolvedValue([]) });
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

  const growthApplier = new BiomassGrowthApplierService();
  const lockUnitForGrowth = jest
    .spyOn(growthApplier, 'lockUnitForGrowth')
    .mockImplementation(async () =>
      opts.lockedUnit && lockedBatchRow ? opts.lockedUnit(lockedBatchRow as Batch) : null,
    );
  const applyMeasuredWeight = jest
    .spyOn(growthApplier, 'applyMeasuredWeight')
    .mockResolvedValue('rebased');
  const recalcForUnit = jest.fn().mockResolvedValue(null);
  const refreshContainers = jest.fn().mockResolvedValue(undefined);
  const sampleApplier = new GrowthSampleApplierService(
    growthApplier,
    collaborator<DayPlanRecalcService>({ recalcForUnit }, 'DayPlanRecalcService'),
    collaborator<FarmStockProjectionService>({ refreshContainers }, 'FarmStockProjectionService'),
  );

  const handler = new UpdateBatchWeightFromSampleHandler(
    dataSource as DataSource,
    measurementRepository,
    sampleApplier,
  );

  return {
    handler,
    mockManager,
    batchSave,
    measurementSave,
    commit,
    rollback,
    lockedBatchRow,
    lockUnitForGrowth,
    applyMeasuredWeight,
    recalcForUnit,
  };
}

/** A unit lock that holds 4800 fish of `batch` alone. */
function unitHolding(batch: Batch): LockedUnit {
  return {
    tankBatch: stub<TankBatch>({ tankId: UNIT, tenantId: TENANT_UUID }),
    batches: new Map([[batch.id, batch]]),
    details: [
      {
        batchId: batch.id,
        batchNumber: 'B-1',
        quantity: 4800,
        avgWeightG: 80,
        biomassKg: 384,
        percentageOfTank: 100,
      },
    ],
  };
}

/** The tank the sample was stamped with, after the batch moved out of it. */
function unitEmptied(): LockedUnit {
  return {
    tankBatch: stub<TankBatch>({ tankId: UNIT, tenantId: TENANT_UUID }),
    batches: new Map(),
    details: [],
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

describe('UpdateBatchWeightFromSampleHandler — the same path as recording (FARM-CRITICAL-454)', () => {
  it('locks the tank the sample names, moves it, and reprices its day plan', async () => {
    const harness = makeHarness({ measurement: { tankId: UNIT }, lockedUnit: unitHolding });

    await harness.handler.execute(makeCommand());

    expect(harness.lockUnitForGrowth).toHaveBeenCalledWith(
      harness.mockManager,
      TENANT_UUID,
      UNIT,
    );
    expect(harness.applyMeasuredWeight).toHaveBeenCalledWith(
      harness.mockManager,
      TENANT_UUID,
      expect.objectContaining({ tankBatch: expect.objectContaining({ tankId: UNIT }) }),
      { batchId: BATCH_ID, avgWeightG: 85, measuredAt: new Date('2026-03-01T00:00:00Z') },
    );
    expect(harness.recalcForUnit).toHaveBeenCalledWith(
      harness.mockManager,
      TENANT_UUID,
      UNIT,
      'growth_sample',
    );
    expect(harness.commit).toHaveBeenCalledTimes(1);
  });

  it('leaves weight.actual on a weighing from a later day (FARM-MEDIUM-453)', async () => {
    const harness = makeHarness({
      // The batch was weighed on 2026-03-05; the stored sample is from 03-01.
      lockedBatch: {
        weight: {
          initial: { avgWeight: 5, totalBiomass: 25, measuredAt: new Date('2026-01-01') },
          theoretical: {
            avgWeight: 0,
            totalBiomass: 0,
            lastCalculatedAt: new Date('2026-01-01'),
            basedOnFCR: 0,
          },
          actual: {
            avgWeight: 95,
            totalBiomass: 456,
            lastMeasuredAt: new Date('2026-03-05T00:00:00Z'),
            sampleSize: 50,
            confidencePercent: 95,
          },
          variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
        },
      },
    });

    const result = await harness.handler.execute(makeCommand());

    expect(result.weight.actual.avgWeight).toBe(95);
    expect(result.weight.actual.sampleSize).toBe(50);
    // Processed: it was applied, and a later weighing is current.
    expect(harness.measurementSave).toHaveBeenCalledTimes(1);
  });

  it('refuses a stored sample stamped with a tank the batch has since left, moving nothing', async () => {
    // Recorded (updateBatchWeight false) while the batch was in UNIT, which
    // stamped UNIT on it; the batch was moved out before it is applied.
    const harness = makeHarness({ measurement: { tankId: UNIT }, lockedUnit: unitEmptied });

    await expect(harness.handler.execute(makeCommand())).rejects.toThrow(BadRequestException);
    expect(harness.applyMeasuredWeight).not.toHaveBeenCalled();
    expect(harness.batchSave).not.toHaveBeenCalled();
    expect(harness.rollback).toHaveBeenCalledTimes(1);
  });
});
