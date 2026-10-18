/**
 * GrowthSampleApplierService — how a growth sample becomes current weight
 * (FARM-CRITICAL-454, FARM-MEDIUM-453).
 *
 * Pinned here, against the real membership rule (`stockedShareOf`) and doubles
 * of the lock, the unit writer, the recalc and the read model (their own
 * behaviour has its own specs):
 *
 *   - which unit a sample weighed: the one it names (its tank, else its pond
 *     unit), the only one holding the batch, none, or a refusal when the batch
 *     is in several and none is named;
 *   - the unit is locked here and proven to hold fish of the batch under the
 *     lock: a named unit that does not is refused (400), the one unit found by
 *     membership losing the batch is a retryable conflict (409);
 *   - a sample that named no unit is stamped with the unit it was resolved to;
 *   - the batch's weight.actual takes the sample unless the batch holds a
 *     weighing from a later day (the stocking placeholder never holds one back);
 *   - when the unit's share was re-based, the read model is refreshed and the
 *     live day plan repriced for the LOCKED unit, after the re-base and in the
 *     caller's transaction; a sample older than the share is history.
 *
 * The real-PostgreSQL proof is weighing-reaches-ration.postgres.spec.ts.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { collaborator, stub } from '@aquaculture/testing';

import { Batch } from '../../../batch/entities/batch.entity';
import type { BatchDetail, TankBatch } from '../../../batch/entities/tank-batch.entity';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import {
  BiomassGrowthApplierService,
  type LockedUnit,
  type MeasuredWeightOutcome,
} from '../../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import { isUnitMembershipConflict } from '../../../feeding-protocol/services/unit-lock-retry.util';
import {
  type AppliedSample,
  GrowthSampleApplierService,
} from '../../services/growth-sample-applier.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const OTHER_BATCH = '33333333-3333-4333-8333-333333333333';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_UNIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POND = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface HarnessOpts {
  /** What the membership lookup answers. */
  holding?: string[];
  /** The lock each unit id answers with (absent: no stock row). */
  locks?: Record<string, LockedUnit>;
  /** What the unit writer did with the share. */
  outcome?: MeasuredWeightOutcome;
  /** weight.actual the batch holds before the sample. */
  actual?: Partial<Batch['weight']['actual']>;
}

function makeBatch(actual: Partial<Batch['weight']['actual']> = {}): Batch {
  return stub<Batch>({
    id: BATCH,
    tenantId: TENANT,
    weight: {
      initial: { avgWeight: 10, totalBiomass: 10, measuredAt: new Date('2026-09-01') },
      theoretical: {
        avgWeight: 12,
        totalBiomass: 12,
        lastCalculatedAt: new Date('2026-10-01'),
        basedOnFCR: 1.2,
      },
      actual: {
        avgWeight: 10,
        totalBiomass: 10,
        lastMeasuredAt: new Date('2026-10-17T10:00:00.000Z'),
        sampleSize: 0,
        confidencePercent: 0,
        ...actual,
      },
      variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
    },
  });
}

function share(batchId: string, quantity: number): BatchDetail {
  return {
    batchId,
    batchNumber: 'B',
    quantity,
    avgWeightG: 10,
    biomassKg: (quantity * 10) / 1000,
    percentageOfTank: 100,
  };
}

function lockedUnit(unitId: string, batch: Batch, details: BatchDetail[]): LockedUnit {
  const batches = new Map<string, Batch>();
  for (const detail of details) {
    batches.set(
      detail.batchId,
      detail.batchId === batch.id ? batch : stub<Batch>({ id: detail.batchId }),
    );
  }
  return {
    tankBatch: stub<TankBatch>({ tankId: unitId, tenantId: TENANT }),
    batches,
    details,
  };
}

function makeSample(over: Partial<AppliedSample> = {}): AppliedSample {
  return {
    batchId: BATCH,
    tankId: undefined,
    pondId: undefined,
    averageWeight: 30,
    estimatedBiomass: 30,
    measurementDate: new Date('2026-10-15T09:00:00.000Z'),
    sampleSize: 3,
    ...over,
  };
}

function makeHarness(opts: HarnessOpts = {}) {
  const batch = makeBatch(opts.actual);
  const calls: string[] = [];

  const save = jest.fn();
  save.mockImplementation(async (_entity: unknown, value: unknown) => {
    calls.push('save-batch');
    return value;
  });
  const manager = stub<EntityManager>({ save });

  // The real service supplies the membership rule; the database-facing members
  // are doubled.
  const growthApplier = new BiomassGrowthApplierService();
  const unitsHoldingBatch = jest
    .spyOn(growthApplier, 'unitsHoldingBatch')
    .mockImplementation(async () => opts.holding ?? []);
  const lockUnitForGrowth = jest
    .spyOn(growthApplier, 'lockUnitForGrowth')
    .mockImplementation(async (_manager, _tenantId, unitId) => {
      calls.push(`lock:${unitId}`);
      return opts.locks?.[unitId] ?? null;
    });
  // The real member answers from the unit lock when it covers the batch, and
  // locks the batch row itself otherwise.
  jest
    .spyOn(growthApplier, 'lockBatchForWrite')
    .mockImplementation(async (_manager, _tenantId, batchId, locked) => {
      const held = locked === null ? undefined : locked.batches.get(batchId);
      if (held !== undefined) return held;
      return batchId === BATCH ? batch : null;
    });
  const applyMeasuredWeight = jest
    .spyOn(growthApplier, 'applyMeasuredWeight')
    .mockImplementation(async () => {
      calls.push('re-base');
      return opts.outcome ?? 'rebased';
    });

  const recalcForUnit = jest.fn(async () => {
    calls.push('recalc');
    return null;
  });
  const dayPlanRecalc = collaborator<DayPlanRecalcService>(
    { recalcForUnit },
    'DayPlanRecalcService',
  );
  const refreshContainers = jest.fn(async (): Promise<void> => {
    calls.push('refresh');
  });
  const farmStockProjection = collaborator<FarmStockProjectionService>(
    { refreshContainers },
    'FarmStockProjectionService',
  );

  const service = new GrowthSampleApplierService(growthApplier, dayPlanRecalc, farmStockProjection);
  return {
    service,
    manager,
    batch,
    save,
    calls,
    unitsHoldingBatch,
    lockUnitForGrowth,
    applyMeasuredWeight,
    recalcForUnit,
    refreshContainers,
  };
}

describe('GrowthSampleApplierService.locate', () => {
  it('takes the tank the sample names, without a lookup', async () => {
    const harness = makeHarness();

    await expect(
      harness.service.locate(harness.manager, TENANT, makeSample({ tankId: UNIT })),
    ).resolves.toEqual({ kind: 'named', unitId: UNIT });
    expect(harness.unitsHoldingBatch).not.toHaveBeenCalled();
  });

  it('takes the pond unit a sample names when it names no tank (one key space with tanks)', async () => {
    const harness = makeHarness({ holding: [UNIT] });

    await expect(
      harness.service.locate(harness.manager, TENANT, makeSample({ pondId: POND })),
    ).resolves.toEqual({ kind: 'named', unitId: POND });
    expect(harness.unitsHoldingBatch).not.toHaveBeenCalled();
  });

  it('takes the only unit holding fish of the batch', async () => {
    const harness = makeHarness({ holding: [UNIT] });

    await expect(harness.service.locate(harness.manager, TENANT, makeSample())).resolves.toEqual({
      kind: 'held',
      unitId: UNIT,
    });
    expect(harness.unitsHoldingBatch).toHaveBeenCalledWith(harness.manager, TENANT, BATCH);
  });

  it('answers none when no unit holds the batch, and ambiguous when several do', async () => {
    const none = makeHarness({ holding: [] });
    await expect(none.service.locate(none.manager, TENANT, makeSample())).resolves.toEqual({
      kind: 'none',
    });

    const several = makeHarness({ holding: [UNIT, OTHER_UNIT] });
    await expect(several.service.locate(several.manager, TENANT, makeSample())).resolves.toEqual({
      kind: 'ambiguous',
      unitIds: [UNIT, OTHER_UNIT],
    });
  });
});

describe('GrowthSampleApplierService.recordLocatedUnit', () => {
  it('stamps a sample kept as history with the one unit holding the batch', async () => {
    const harness = makeHarness({ holding: [UNIT] });
    const sample = makeSample();

    await harness.service.recordLocatedUnit(harness.manager, TENANT, sample);

    expect(sample.tankId).toBe(UNIT);
    expect(harness.lockUnitForGrowth).not.toHaveBeenCalled();
  });

  it('leaves a sample of a batch held in several units unstamped, without refusing it', async () => {
    const harness = makeHarness({ holding: [UNIT, OTHER_UNIT] });
    const sample = makeSample();

    await harness.service.recordLocatedUnit(harness.manager, TENANT, sample);

    expect(sample.tankId).toBeUndefined();
  });
});

describe('GrowthSampleApplierService.applySample', () => {
  it('re-bases the held unit, stamps the sample with it, then refreshes the read model and reprices the day plan', async () => {
    const batch = makeBatch();
    const harness = makeHarness({
      holding: [UNIT],
      locks: { [UNIT]: lockedUnit(UNIT, batch, [share(BATCH, 1000)]) },
    });
    const sample = makeSample();

    const saved = await harness.service.applySample(harness.manager, TENANT, sample);

    expect(saved).toBe(batch);
    expect(sample.tankId).toBe(UNIT);
    expect(harness.applyMeasuredWeight).toHaveBeenCalledWith(
      harness.manager,
      TENANT,
      expect.objectContaining({ tankBatch: expect.objectContaining({ tankId: UNIT }) }),
      { batchId: BATCH, avgWeightG: 30, measuredAt: sample.measurementDate },
    );
    expect(harness.refreshContainers).toHaveBeenCalledWith(harness.manager, TENANT, [UNIT]);
    expect(harness.recalcForUnit).toHaveBeenCalledWith(
      harness.manager,
      TENANT,
      UNIT,
      'growth_sample',
    );
    expect(harness.calls).toEqual([`lock:${UNIT}`, 'save-batch', 're-base', 'refresh', 'recalc']);
  });

  it("writes the sample onto the batch's weight.actual", async () => {
    const harness = makeHarness({ holding: [] });
    const sample = makeSample();

    await harness.service.applySample(harness.manager, TENANT, sample);

    expect(harness.batch.weight.actual).toEqual({
      avgWeight: 30,
      totalBiomass: 30,
      lastMeasuredAt: sample.measurementDate,
      sampleSize: 3,
      confidencePercent: 95,
    });
    expect(harness.save).toHaveBeenCalledWith(Batch, harness.batch);
  });

  it('leaves the read model and the day plan alone when the share already knows a later day', async () => {
    const batch = makeBatch();
    const harness = makeHarness({
      locks: { [UNIT]: lockedUnit(UNIT, batch, [share(BATCH, 1000)]) },
      outcome: 'older_than_share',
    });

    await harness.service.applySample(harness.manager, TENANT, makeSample({ tankId: UNIT }));

    expect(harness.applyMeasuredWeight).toHaveBeenCalled();
    expect(harness.refreshContainers).not.toHaveBeenCalled();
    expect(harness.recalcForUnit).not.toHaveBeenCalled();
  });

  it('writes only the batch when no unit holds it', async () => {
    const harness = makeHarness({ holding: [] });

    await harness.service.applySample(harness.manager, TENANT, makeSample());

    expect(harness.batch.weight.actual.avgWeight).toBe(30);
    expect(harness.lockUnitForGrowth).not.toHaveBeenCalled();
    expect(harness.applyMeasuredWeight).not.toHaveBeenCalled();
    expect(harness.recalcForUnit).not.toHaveBeenCalled();
    expect(harness.refreshContainers).not.toHaveBeenCalled();
  });

  it('refuses a batch held in several units when the sample names none, locking and writing nothing', async () => {
    const harness = makeHarness({ holding: [UNIT, OTHER_UNIT] });

    await expect(
      harness.service.applySample(harness.manager, TENANT, makeSample()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.lockUnitForGrowth).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('refuses a sample naming a tank that holds another batch, writing nothing', async () => {
    const batch = makeBatch();
    const harness = makeHarness({
      locks: { [UNIT]: lockedUnit(UNIT, batch, [share(OTHER_BATCH, 500)]) },
    });

    await expect(
      harness.service.applySample(harness.manager, TENANT, makeSample({ tankId: UNIT })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.applyMeasuredWeight).not.toHaveBeenCalled();
  });

  it('refuses a sample naming a tank with no stock row at all', async () => {
    const harness = makeHarness({ locks: {} });

    await expect(
      harness.service.applySample(harness.manager, TENANT, makeSample({ tankId: UNIT })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('refuses a sample naming a tank whose share of the batch has no fish (an emptied tank)', async () => {
    const batch = makeBatch();
    const harness = makeHarness({
      // The departed batch is still locked (its row named it), but holds no fish here.
      locks: { [UNIT]: lockedUnit(UNIT, batch, [share(BATCH, 0)]) },
    });

    await expect(
      harness.service.applySample(harness.manager, TENANT, makeSample({ tankId: UNIT })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.applyMeasuredWeight).not.toHaveBeenCalled();
  });

  it('refuses a pond sample whose pond holds no stock row, and never re-bases the tank that holds the batch', async () => {
    const batch = makeBatch();
    const harness = makeHarness({
      holding: [UNIT],
      locks: { [UNIT]: lockedUnit(UNIT, batch, [share(BATCH, 200)]) },
    });

    await expect(
      harness.service.applySample(harness.manager, TENANT, makeSample({ pondId: POND })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.lockUnitForGrowth).toHaveBeenCalledWith(harness.manager, TENANT, POND);
    expect(harness.lockUnitForGrowth).not.toHaveBeenCalledWith(harness.manager, TENANT, UNIT);
    expect(harness.applyMeasuredWeight).not.toHaveBeenCalled();
  });

  it('answers a retryable conflict when the one unit that held the batch lost it before the lock', async () => {
    const batch = makeBatch();
    const harness = makeHarness({
      // Read unlocked: the batch was in UNIT. Locked: a concurrent transfer emptied it.
      holding: [UNIT],
      locks: { [UNIT]: lockedUnit(UNIT, batch, []) },
    });
    const sample = makeSample();

    const failure = await harness.service.applySample(harness.manager, TENANT, sample).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConflictException);
    // withUnitLockRetry retries exactly this class of conflict.
    expect(isUnitMembershipConflict(failure)).toBe(true);
    expect(sample.tankId).toBeUndefined();
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('refreshes and reprices the unit the lock holds', async () => {
    const batch = makeBatch();
    const harness = makeHarness({
      locks: { [UNIT]: lockedUnit(UNIT, batch, [share(BATCH, 1000)]) },
    });

    await harness.service.applySample(harness.manager, TENANT, makeSample({ tankId: UNIT }));

    expect(harness.refreshContainers).toHaveBeenCalledWith(harness.manager, TENANT, [UNIT]);
    expect(harness.recalcForUnit).toHaveBeenCalledWith(
      harness.manager,
      TENANT,
      UNIT,
      'growth_sample',
    );
  });

  it('keeps weight.actual on a weighing from a later day (FARM-MEDIUM-453)', async () => {
    const latest = new Date('2026-10-16T09:00:00.000Z');
    const harness = makeHarness({
      actual: { avgWeight: 50, totalBiomass: 50, lastMeasuredAt: latest, sampleSize: 3 },
    });

    await harness.service.applySample(harness.manager, TENANT, makeSample());

    expect(harness.batch.weight.actual).toMatchObject({
      avgWeight: 50,
      lastMeasuredAt: latest,
      sampleSize: 3,
    });
  });

  it('applies a sample of the same day as the last weighing (the later-recorded one is current)', async () => {
    const harness = makeHarness({
      actual: {
        avgWeight: 50,
        lastMeasuredAt: new Date('2026-10-15T17:00:00.000Z'),
        sampleSize: 3,
      },
    });

    await harness.service.applySample(harness.manager, TENANT, makeSample());

    expect(harness.batch.weight.actual.avgWeight).toBe(30);
  });

  it('never holds a sample back on the stocking placeholder (sampleSize 0)', async () => {
    // CreateBatchHandler stamps lastMeasuredAt with the creation time, which is
    // later than any backdated first weighing.
    const harness = makeHarness({
      actual: { lastMeasuredAt: new Date('2026-10-17T10:00:00.000Z'), sampleSize: 0 },
    });

    await harness.service.applySample(harness.manager, TENANT, makeSample());

    expect(harness.batch.weight.actual.avgWeight).toBe(30);
    expect(harness.batch.weight.actual.sampleSize).toBe(3);
  });
});
