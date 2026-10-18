/**
 * RecordGrowthSampleHandler — Transactional Outbox Unit Tests
 *
 * The handler wraps the domain writes (measurement insert, locked batch
 * weight update, isProcessed flip) AND the `GrowthSampleRecorded` outbox
 * enqueue in a single runInTenantTransaction (pessimistic_write on the batch).
 * These tests pin the invariants that contract depends on:
 *
 *   1. Happy path: all 3 saves + 1 outbox enqueue + commit (once).
 *   2. Event payload carries batchId / measurementId / sampleSize /
 *      averageWeightG / weightCV / measurementDate / performance.
 *   3. `updateBatchWeight = false` skips the batch save and the
 *      isProcessed flip — but still emits the event, and stamps the sample
 *      with the one unit holding the batch.
 *   4. Enqueue failure → rollback, no partial writes.
 *   5. Measurement save failure → rollback, no event enqueued.
 *   6. Existing validation paths (NotFound / inactive batch /
 *      <3 individual measurements) throw BEFORE any transaction
 *      starts.
 *   7. Backdate policy throws BEFORE any DB or tx work — the
 *      outbox never sees a rejected event.
 *   8. The batch weight write targets the LOCKED in-tx row
 *      (queryRunner.manager.findOne with pessimistic_write), never the
 *      externally-loaded validation snapshot.
 *   9. A sample of a stocked tank takes the unit lock for that tank and
 *      moves it, then reprices its day plan, in the same transaction
 *      (FARM-CRITICAL-454); a membership change during the lock is retried;
 *      the unit it was resolved to is stamped on the sample and its event.
 *
 * The sample applier and the unit writer are the REAL services (the unit
 * lock and the re-base are spied for the stocked-tank cases); the recalc and
 * the read-model projection are typed doubles.
 *
 * tenantId is a valid UUID v4 because runInTenantTransaction pins the tenant
 * search_path and rejects non-UUIDs.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';
import { collaborator, createMockDataSource, stub } from '@aquaculture/testing';

import { RecordGrowthSampleHandler } from '../../handlers/record-growth-sample.handler';
import { RecordGrowthSampleCommand } from '../../commands/record-growth-sample.command';
import {
  GrowthMeasurement,
  MeasurementMethod,
  MeasurementType,
} from '../../entities/growth-measurement.entity';
import type { Batch } from '../../../batch/entities/batch.entity';
import type { FCRCalculationService } from '../../services/fcr-calculation.service';
import type { BackdatePolicyService } from '../../../common/services/backdate-policy.service';
import type { OutboxPublisher } from '@platform/outbox';
import type { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import {
  BiomassGrowthApplierService,
  type LockedUnit,
} from '../../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import { GrowthSampleApplierService } from '../../services/growth-sample-applier.service';

// Valid UUID v4 — runInTenantTransaction rejects non-UUID tenant IDs.
const TENANT_UUID = '11111111-1111-4111-8111-111111111111';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface HarnessOpts {
  batch?: Partial<Batch> | null;
  previousMeasurement?: Partial<GrowthMeasurement> | null;
  measurementSaveImpl?: (entity: GrowthMeasurement) => Promise<GrowthMeasurement>;
  batchSaveImpl?: (entity: Batch) => Promise<Batch>;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
  backdatePolicyImpl?: () => void;
  /** What the unit lookup answers: the tanks holding the batch. */
  unitRows?: Array<{ tankId: string }>;
  /** Builds the unit lockUnitForGrowth returns, from the locked batch row. */
  lockedUnit?: (batch: Batch) => LockedUnit | null;
  /** Membership conflicts lockUnitForGrowth raises before it succeeds. */
  lockConflicts?: number;
}

function makeHarness(opts: HarnessOpts = {}) {
  const measurementSave = jest.fn(async (entity: GrowthMeasurement) =>
    opts.measurementSaveImpl
      ? opts.measurementSaveImpl(entity)
      : { ...entity, id: entity.id ?? 'measurement-1' },
  );
  const batchSave = jest.fn(async (entity: Batch) =>
    opts.batchSaveImpl ? opts.batchSaveImpl(entity) : entity,
  );

  const batchRow: Partial<Batch> =
    opts.batch === null
      ? (null as unknown as Partial<Batch>)
      : {
          id: 'batch-1',
          tenantId: TENANT_UUID,
          isActive: true,
          currentQuantity: 1000,
          weight: {
            actual: {
              avgWeight: 0,
              totalBiomass: 0,
              lastMeasuredAt: new Date(),
              sampleSize: 0,
              confidencePercent: 0,
            },
          } as Batch['weight'],
          fcr: { target: 1.5 } as Batch['fcr'],
          species: {
            growthParameters: { avgDailyGrowth: 2 },
          } as unknown as Batch['species'],
          ...(opts.batch ?? {}),
        };

  const commit = jest.fn().mockResolvedValue(undefined);
  const rollback = jest.fn().mockResolvedValue(undefined);
  const release = jest.fn().mockResolvedValue(undefined);
  // EntityManager mock from the shared @aquaculture/testing factory (already
  // jest.Mocked<EntityManager> — assignable to queryRunner.manager without a
  // cast). DRIVE behaviour through mockImplementation so the heavily-overloaded
  // EntityManager.save/findOne MockInstance types stay intact; the impls route
  // by entity name to the measurementSave/batchSave spies the assertions read,
  // and the locked findOne(Batch, {..., lock}) returns the same batchRow the
  // handler then mutates + saves. WHY: a bare `mockManager.save = managerSave`
  // assignment fails to typecheck (loose jest.fn vs the overloaded
  // MockInstance) — replacing the function via mockImplementation preserves the
  // mock's typed signature instead.
  const { mockManager } = createMockDataSource();
  mockManager.save.mockImplementation((Entity, entity) => {
    const name = (Entity as { name?: string }).name;
    if (name === 'GrowthMeasurement') return measurementSave(entity as GrowthMeasurement);
    if (name === 'Batch') return batchSave(entity as Batch);
    return Promise.resolve(entity);
  });
  mockManager.findOne.mockImplementation((Entity) => {
    const name = (Entity as { name?: string }).name;
    if (name === 'Batch') {
      return Promise.resolve(opts.batch === null ? null : (batchRow as Batch));
    }
    return Promise.resolve(null);
  });
  // The unit lookup (BiomassGrowthApplierService.unitsHoldingBatch) runs on
  // the tx manager. The shared factory's manager has no `query` member, so it is
  // installed here.
  const unitLookup = jest.fn().mockResolvedValue(opts.unitRows ?? []);
  Object.assign(mockManager, { query: unitLookup });
  const queryRunner: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: commit,
    rollbackTransaction: rollback,
    release,
    // runInTenantTransaction pins the tenant search_path via queryRunner.query.
    query: jest.fn().mockResolvedValue([]),
    manager: mockManager,
  };
  const dataSource: Partial<DataSource> = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };

  const measurementRepository = {
    create: jest.fn((partial: Partial<GrowthMeasurement>) => {
      const proto: Partial<GrowthMeasurement> = {
        ...partial,
        calculateStatistics() {
          (this as GrowthMeasurement).averageWeight = 250;
          (this as GrowthMeasurement).weightCV = 8;
          (this as GrowthMeasurement).estimatedBiomass = 250 * 1000;
          (this as GrowthMeasurement).statistics = {} as GrowthMeasurement['statistics'];
        },
        evaluatePerformance() {
          (this as GrowthMeasurement).performance = 'good' as GrowthMeasurement['performance'];
        },
        generateSuggestedActions() {
          /* no-op in tests */
        },
        isProcessed: false,
      };
      return proto as GrowthMeasurement;
    }),
    findOne: jest.fn().mockResolvedValue(opts.previousMeasurement ?? null),
  };

  const batchRepository = {
    findOne: jest.fn().mockResolvedValue(opts.batch === null ? null : batchRow),
  };

  const fcrService = {
    calculatePeriodFCR: jest.fn().mockResolvedValue({ isValid: false }),
  } as unknown as FCRCalculationService;

  const backdatePolicy = {
    validate: jest
      .fn()
      .mockImplementation(opts.backdatePolicyImpl ?? (() => undefined)),
  } as unknown as BackdatePolicyService;

  const enqueue = jest.fn(async (event: unknown, em: EntityManager) => {
    if (opts.enqueueImpl) return opts.enqueueImpl(event, em);
    return undefined;
  });
  const outboxPublisher = { enqueue } as unknown as OutboxPublisher;

  const growthApplier = new BiomassGrowthApplierService();
  let conflictsLeft = opts.lockConflicts ?? 0;
  const lockUnitForGrowth = jest
    .spyOn(growthApplier, 'lockUnitForGrowth')
    .mockImplementation(async () => {
      if (conflictsLeft > 0) {
        conflictsLeft -= 1;
        throw new ConflictException(
          `Unit ${UNIT} batch membership changed during lock acquisition (missing: x). Retry.`,
        );
      }
      return opts.lockedUnit ? opts.lockedUnit(batchRow as Batch) : null;
    });
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

  const handler = new RecordGrowthSampleHandler(
    dataSource as DataSource,
    measurementRepository as unknown as Repository<GrowthMeasurement>,
    batchRepository as unknown as Repository<Batch>,
    fcrService,
    backdatePolicy,
    outboxPublisher,
    sampleApplier,
  );

  return {
    handler,
    enqueue,
    commit,
    rollback,
    release,
    measurementSave,
    batchSave,
    mockManager,
    lockUnitForGrowth,
    applyMeasuredWeight,
    recalcForUnit,
    refreshContainers,
    backdatePolicy: backdatePolicy as unknown as { validate: jest.Mock },
  };
}

/** A unit lock that holds 1000 fish of `batch` alone. */
function unitHolding(batch: Batch): LockedUnit {
  return {
    tankBatch: stub<TankBatch>({ tankId: UNIT, tenantId: TENANT_UUID }),
    batches: new Map([[batch.id, batch]]),
    details: [
      {
        batchId: batch.id,
        batchNumber: 'B-1',
        quantity: 1000,
        avgWeightG: 200,
        biomassKg: 200,
        percentageOfTank: 100,
      },
    ],
  };
}

function makeCommand(overrides: Partial<{
  individualMeasurements: Array<{ weightG: number }>;
  updateBatchWeight: boolean | undefined;
  measurementDate: Date;
  tankId: string;
}> = {}) {
  return new RecordGrowthSampleCommand(
    TENANT_UUID,
    {
      batchId: 'batch-1',
      tankId: overrides.tankId,
      measurementDate: overrides.measurementDate ?? new Date('2026-04-10T09:00:00Z'),
      measurementType: MeasurementType.ROUTINE,
      measurementMethod: MeasurementMethod.MANUAL_SCALE,
      individualMeasurements:
        overrides.individualMeasurements ?? [
          { weightG: 240 },
          { weightG: 250 },
          { weightG: 260 },
        ],
      populationSize: 1000,
      measuredBy: 'user-1',
      updateBatchWeight: overrides.updateBatchWeight,
    } as unknown as RecordGrowthSampleCommand['payload'],
    'user-1',
  );
}

describe('RecordGrowthSampleHandler — transactional outbox', () => {
  it('happy path: 3 writes + 1 enqueue + commit', async () => {
    const { handler, enqueue, commit, rollback, measurementSave, batchSave } =
      makeHarness();

    await handler.execute(makeCommand());

    // Initial measurement save + isProcessed flip = 2 measurement saves
    expect(measurementSave).toHaveBeenCalledTimes(2);
    // Batch weight snapshot save = 1
    expect(batchSave).toHaveBeenCalledTimes(1);
    // Outbox enqueue exactly once, with the queryRunner.manager
    expect(enqueue).toHaveBeenCalledTimes(1);
    const enqueuedEvent = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(enqueuedEvent['eventType']).toBe('GrowthSampleRecorded');
    expect(enqueuedEvent['batchId']).toBe('batch-1');
    expect(enqueuedEvent['tenantId']).toBe(TENANT_UUID);
    expect(enqueuedEvent['sampleSize']).toBe(3);
    expect(enqueuedEvent['averageWeightG']).toBe(250);
    expect(enqueuedEvent['weightCV']).toBe(8);
    expect(enqueuedEvent['performance']).toBe('good');
    expect(typeof enqueuedEvent['measurementDate']).toBe('string');

    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('updateBatchWeight=false skips the batch save and the isProcessed flip but still emits the event', async () => {
    const { handler, enqueue, commit, measurementSave, batchSave } = makeHarness();

    await handler.execute(makeCommand({ updateBatchWeight: false }));

    // The insert, then the save that records the unit the sample was resolved to.
    expect(measurementSave).toHaveBeenCalledTimes(2);
    expect((measurementSave.mock.calls[1]![0] as GrowthMeasurement).isProcessed).toBe(false);
    expect(batchSave).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('outbox enqueue failure rolls back every domain write', async () => {
    const { handler, rollback, commit } = makeHarness({
      enqueueImpl: async () => {
        throw new Error('outbox enqueue failed');
      },
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      'outbox enqueue failed',
    );
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('measurement save failure rolls back and never enqueues', async () => {
    const { handler, rollback, commit, enqueue } = makeHarness({
      measurementSaveImpl: async () => {
        throw new Error('db offline');
      },
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow('db offline');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when batch does not exist — no tx started', async () => {
    const { handler, enqueue } = makeHarness({ batch: null });

    await expect(handler.execute(makeCommand())).rejects.toThrow(NotFoundException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when batch is not active — no tx started', async () => {
    const { handler, enqueue } = makeHarness({
      batch: { isActive: false } as Batch,
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      BadRequestException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when fewer than 3 individual measurements — no tx started', async () => {
    const { handler, enqueue } = makeHarness();

    await expect(
      handler.execute(
        makeCommand({
          individualMeasurements: [{ weightG: 100 }, { weightG: 110 }],
        }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('backdate policy violation throws BEFORE any DB or tx work', async () => {
    const { handler, enqueue, backdatePolicy } = makeHarness({
      backdatePolicyImpl: () => {
        throw new BadRequestException('backdate window exceeded');
      },
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      'backdate window exceeded',
    );
    expect(backdatePolicy.validate).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('RecordGrowthSampleHandler — the sample reaches the tank (FARM-CRITICAL-454)', () => {
  it('locks the unit holding the batch, moves it, and reprices its day plan in the same tx', async () => {
    const harness = makeHarness({ unitRows: [{ tankId: UNIT }], lockedUnit: unitHolding });

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
      {
        batchId: 'batch-1',
        avgWeightG: 250,
        measuredAt: new Date('2026-04-10T09:00:00Z'),
      },
    );
    expect(harness.refreshContainers).toHaveBeenCalledWith(harness.mockManager, TENANT_UUID, [UNIT]);
    expect(harness.recalcForUnit).toHaveBeenCalledWith(
      harness.mockManager,
      TENANT_UUID,
      UNIT,
      'growth_sample',
    );
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
    expect(harness.commit).toHaveBeenCalledTimes(1);
  });

  it('refuses a sample naming a tank that does not hold the batch; nothing commits', async () => {
    const otherBatch = stub<Batch>({ id: 'batch-2' });
    const harness = makeHarness({ lockedUnit: () => unitHolding(otherBatch) });

    await expect(harness.handler.execute(makeCommand({ tankId: UNIT }))).rejects.toThrow(
      BadRequestException,
    );
    expect(harness.applyMeasuredWeight).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.rollback).toHaveBeenCalledTimes(1);
    expect(harness.commit).not.toHaveBeenCalled();
  });

  it('retries the whole command when the unit membership changes during the lock', async () => {
    const harness = makeHarness({
      unitRows: [{ tankId: UNIT }],
      lockedUnit: unitHolding,
      lockConflicts: 1,
    });

    await harness.handler.execute(makeCommand());

    expect(harness.lockUnitForGrowth).toHaveBeenCalledTimes(2);
    expect(harness.rollback).toHaveBeenCalledTimes(1);
    expect(harness.commit).toHaveBeenCalledTimes(1);
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it('takes no unit lock when the sample is recorded without applying it', async () => {
    const harness = makeHarness({ unitRows: [{ tankId: UNIT }], lockedUnit: unitHolding });

    await harness.handler.execute(makeCommand({ updateBatchWeight: false }));

    expect(harness.lockUnitForGrowth).not.toHaveBeenCalled();
    expect(harness.recalcForUnit).not.toHaveBeenCalled();
  });

  it('stamps a sample kept as history with the one tank holding the batch, and carries it on the event', async () => {
    const harness = makeHarness({ unitRows: [{ tankId: UNIT }], lockedUnit: unitHolding });

    await harness.handler.execute(makeCommand({ updateBatchWeight: false }));

    const stored = harness.measurementSave.mock.calls[1]![0] as GrowthMeasurement;
    expect(stored.tankId).toBe(UNIT);
    const event = harness.enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['tankId']).toBe(UNIT);
  });

  it('stamps an applied sample that named no tank with the tank it moved', async () => {
    const harness = makeHarness({ unitRows: [{ tankId: UNIT }], lockedUnit: unitHolding });

    await harness.handler.execute(makeCommand());

    const stored = harness.measurementSave.mock.calls[1]![0] as GrowthMeasurement;
    expect(stored.tankId).toBe(UNIT);
    expect(stored.isProcessed).toBe(true);
  });

  it('answers a retryable conflict, then weighs the batch where it went, when it left its one tank before the lock', async () => {
    const harness = makeHarness({
      unitRows: [{ tankId: UNIT }],
      // First lock: the tank no longer holds the batch (a concurrent move); the
      // retry finds it again.
      lockedUnit: (batch) => unitHolding(batch),
    });
    harness.lockUnitForGrowth.mockImplementationOnce(async () => ({
      tankBatch: stub<TankBatch>({ tankId: UNIT, tenantId: TENANT_UUID }),
      batches: new Map(),
      details: [],
    }));

    await harness.handler.execute(makeCommand());

    expect(harness.lockUnitForGrowth).toHaveBeenCalledTimes(2);
    expect(harness.rollback).toHaveBeenCalledTimes(1);
    expect(harness.commit).toHaveBeenCalledTimes(1);
    expect(harness.applyMeasuredWeight).toHaveBeenCalledTimes(1);
  });
});
