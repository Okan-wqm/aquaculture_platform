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
 *   3. `updateBatchWeight = false` skips the batch save AND the
 *      isProcessed second save — but still emits the event.
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
 *
 * tenantId is a valid UUID v4 because runInTenantTransaction pins the tenant
 * search_path and rejects non-UUIDs.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';
import { createMockDataSource } from '@aquaculture/testing';

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
import {
  BiomassGrowthApplierService,
  type LockedUnit,
} from '../../../feeding-protocol/services/biomass-growth-applier.service';
import type { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';

/**
 * Partial double. The repo's standard spec idiom (see
 * biomass-growth-applier.service.spec.ts): double-widening casts are a banned
 * construct, and a Partial<T> widened once here keeps every call site free of
 * them.
 */
function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

// Valid UUID v4 — runInTenantTransaction rejects non-UUID tenant IDs.
const TENANT_UUID = '11111111-1111-4111-8111-111111111111';

interface HarnessOpts {
  batch?: Partial<Batch> | null;
  /** Unit returned by lockUnitForGrowth; null = the batch is in no tank. */
  lockedUnit?: LockedUnit | null;
  /** Rows resolveUnitHoldingBatch's raw lookup answers with. */
  unitLookupRows?: Array<{ tankId: string }>;
  previousMeasurement?: Partial<GrowthMeasurement> | null;
  measurementSaveImpl?: (entity: GrowthMeasurement) => Promise<GrowthMeasurement>;
  batchSaveImpl?: (entity: Batch) => Promise<Batch>;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
  backdatePolicyImpl?: () => void;
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
          // GrowthMeasurement.calculateStatistics defines estimatedBiomass as
          // averageWeight × populationSize / 1000. The double must honour that
          // invariant: the handler now DERIVES the batch's measured average
          // back out of the biomass, so a double that breaks the relation makes
          // the batch look 1000× heavier than the fish it just weighed.
          (this as GrowthMeasurement).estimatedBiomass =
            (250 * (this as GrowthMeasurement).populationSize) / 1000;
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

  // resolveUnitHoldingBatch's jsonb lookup runs on the tx manager. Installed via
  // Object.assign (not `mockManager.query.mockResolvedValue(...)`) because the
  // shared createMockDataSource factory has historically shipped without a
  // `query` double, and this spec must not depend on which revision of it the
  // resolver picks up.
  const managerQuery = jest.fn().mockResolvedValue(opts.unitLookupRows ?? []);
  Object.assign(mockManager, { query: managerQuery });

  // The applier's OWN behaviour is proven in biomass-growth-applier*.spec.ts.
  // Here the unit under test is the HANDLER'S WIRING, so lockUnitForGrowth /
  // reconcileMeasuredWeight are spies — but stampBatchWeight delegates to the
  // REAL implementation, because the no-unit branch's batch provenance write is
  // behaviour this spec does assert.
  const realApplier = new BiomassGrowthApplierService();
  const lockUnitForGrowth = jest.fn().mockResolvedValue(opts.lockedUnit ?? null);
  const reconcileMeasuredWeight = jest.fn().mockResolvedValue(null);
  const growthApplier = mock<BiomassGrowthApplierService>({
    lockUnitForGrowth,
    reconcileMeasuredWeight,
    stampBatchWeight: realApplier.stampBatchWeight.bind(realApplier),
  });

  const recalcForUnit = jest.fn().mockResolvedValue(null);
  const recalcService = mock<DayPlanRecalcService>({ recalcForUnit });

  const handler = new RecordGrowthSampleHandler(
    dataSource as DataSource,
    measurementRepository as unknown as Repository<GrowthMeasurement>,
    batchRepository as unknown as Repository<Batch>,
    fcrService,
    backdatePolicy,
    outboxPublisher,
    growthApplier,
    recalcService,
  );

  return {
    handler,
    enqueue,
    commit,
    rollback,
    release,
    measurementSave,
    batchSave,
    backdatePolicy: backdatePolicy as unknown as { validate: jest.Mock },
    lockUnitForGrowth,
    reconcileMeasuredWeight,
    recalcForUnit,
    managerQuery,
    batchRow,
  };
}

function makeCommand(overrides: Partial<{
  individualMeasurements: Array<{ weightG: number }>;
  updateBatchWeight: boolean | undefined;
  measurementDate: Date;
}> = {}) {
  return new RecordGrowthSampleCommand(
    TENANT_UUID,
    {
      batchId: 'batch-1',
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

  it('updateBatchWeight=false skips both batch save and isProcessed flip but still emits the event', async () => {
    const { handler, enqueue, commit, measurementSave, batchSave } = makeHarness();

    await handler.execute(makeCommand({ updateBatchWeight: false }));

    expect(measurementSave).toHaveBeenCalledTimes(1);
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

describe('RecordGrowthSampleHandler — the weighing reaches the TANK (Faz 0.1)', () => {
  const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  /** A locked unit that holds the sampled batch. */
  const lockedUnitHolding = (batchId: string): LockedUnit =>
    ({
      tankBatch: { tankId: UNIT } as LockedUnit['tankBatch'],
      batches: new Map([[batchId, mock<Batch>({ id: batchId })]]),
      details: [],
    }) as LockedUnit;

  it('re-bases the unit onto the MEASURED weight and reprices the live day plan', async () => {
    const harness = makeHarness({
      unitLookupRows: [{ tankId: UNIT }],
      lockedUnit: lockedUnitHolding('batch-1'),
    });

    await harness.handler.execute(makeCommand());

    // The link that did not exist: the measurement is handed to the unit
    // primitive with the measured average weight and measurement provenance.
    expect(harness.lockUnitForGrowth).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_UUID,
      UNIT,
    );
    expect(harness.reconcileMeasuredWeight).toHaveBeenCalledTimes(1);
    const call = harness.reconcileMeasuredWeight.mock.calls[0]!;
    expect(call[3]).toBe(250); // measurement.averageWeight
    expect(call[4]).toMatchObject({ source: 'measurement', sampleSize: 3, confidencePercent: 95 });

    // …and today's remaining meals are re-costed from the measured biomass.
    expect(harness.recalcForUnit).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_UUID,
      UNIT,
      { reason: 'growth_sample' },
    );
  });

  it('publishes the unit on the event so the read model can converge (0.7)', async () => {
    const harness = makeHarness({
      unitLookupRows: [{ tankId: UNIT }],
      lockedUnit: lockedUnitHolding('batch-1'),
    });

    await harness.handler.execute(makeCommand());

    const event = harness.enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('GrowthSampleRecorded');
    expect(event['tankId']).toBe(UNIT);
  });

  it('refuses a sample filed against a tank that does not hold the batch', async () => {
    const harness = makeHarness({
      unitLookupRows: [{ tankId: UNIT }],
      // Locked unit holds a DIFFERENT batch — applying this sample would move
      // another cohort's weight.
      lockedUnit: lockedUnitHolding('some-other-batch'),
    });

    await expect(harness.handler.execute(makeCommand())).rejects.toThrow(BadRequestException);
    expect(harness.reconcileMeasuredWeight).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('fails closed when the batch spans several tanks and none was named', async () => {
    const harness = makeHarness({
      unitLookupRows: [{ tankId: UNIT }, { tankId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
    });

    await expect(harness.handler.execute(makeCommand())).rejects.toThrow(BadRequestException);
    // Guessing a "dominant" tank would silently re-base fish nobody weighed.
    expect(harness.reconcileMeasuredWeight).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('records batch-level provenance (and no tankId) when the batch is in no unit', async () => {
    const harness = makeHarness({ unitLookupRows: [] });

    await harness.handler.execute(makeCommand());

    expect(harness.reconcileMeasuredWeight).not.toHaveBeenCalled();
    expect(harness.recalcForUnit).not.toHaveBeenCalled();
    // The real stampBatchWeight ran on the locked batch row. `batchRow` is a
    // Partial<Batch> fixture, so narrow it before reading the JSONB block.
    const weight = harness.batchRow.weight;
    expect(weight).toBeDefined();
    expect(weight?.actual.avgWeight).toBe(250);
    expect(weight?.actual.sampleSize).toBe(3);
    expect(weight?.actual.confidencePercent).toBe(95);
    const event = harness.enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['tankId']).toBeUndefined();
  });
});
