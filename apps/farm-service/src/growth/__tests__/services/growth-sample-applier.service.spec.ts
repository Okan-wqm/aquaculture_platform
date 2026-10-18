/**
 * GrowthSampleApplierService — how a growth sample becomes current weight
 * (FARM-CRITICAL-454, FARM-MEDIUM-453).
 *
 * Pinned here, against doubles of the unit writer, the recalc and the read
 * model (their own behaviour has its own specs):
 *
 *   - which tank a sample weighed: the one it names, the only one holding the
 *     batch, none, or a refusal when the batch is in several and none is named;
 *   - a sample naming a tank that does not hold the batch is refused;
 *   - the batch's weight.actual takes the sample unless the batch holds a
 *     weighing from a later day (the stocking placeholder never holds one back);
 *   - when the tank's share moved, the read model is refreshed and the live day
 *     plan repriced, after the re-base and in the caller's transaction.
 *
 * The real-PostgreSQL proof is weighing-reaches-ration.postgres.spec.ts.
 */
import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { collaborator, stub } from '@aquaculture/testing';

import { Batch } from '../../../batch/entities/batch.entity';
import type { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import {
  BiomassGrowthApplierService,
  type LockedUnit,
} from '../../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import {
  type AppliedSample,
  GrowthSampleApplierService,
} from '../../services/growth-sample-applier.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_UNIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface HarnessOpts {
  /** What the unit lookup query answers. */
  unitRows?: Array<{ tankId: string }>;
  /** Whether the unit writer re-based the share. */
  unitMoved?: boolean;
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

function lockedUnitHolding(batch: Batch): LockedUnit {
  return {
    tankBatch: stub<TankBatch>({ tankId: UNIT, tenantId: TENANT }),
    batches: new Map([[batch.id, batch]]),
    details: [],
  };
}

function makeSample(over: Partial<AppliedSample> = {}): AppliedSample {
  return {
    batchId: BATCH,
    tankId: undefined,
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

  const query = jest.fn();
  query.mockImplementation(async () => opts.unitRows ?? []);
  const save = jest.fn();
  save.mockImplementation(async (_entity: unknown, value: unknown) => {
    calls.push('save-batch');
    return value;
  });
  const manager = stub<EntityManager>({ query, save });

  // The real member answers from the unit lock when it covers the batch, and
  // locks the batch row itself otherwise.
  const lockBatchForWrite = jest.fn(
    async (
      _manager: EntityManager,
      _tenantId: string,
      batchId: string,
      locked: LockedUnit | null,
    ): Promise<Batch | null> => {
      const held = locked === null ? undefined : locked.batches.get(batchId);
      if (held !== undefined) return held;
      return batchId === BATCH ? batch : null;
    },
  );
  const applyMeasuredWeight = jest.fn(async (): Promise<boolean> => {
    calls.push('re-base');
    return opts.unitMoved ?? true;
  });
  const growthApplier = collaborator<BiomassGrowthApplierService>(
    { lockBatchForWrite, applyMeasuredWeight },
    'BiomassGrowthApplierService',
  );
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
    query,
    save,
    calls,
    applyMeasuredWeight,
    recalcForUnit,
    refreshContainers,
  };
}

describe('GrowthSampleApplierService.unitOf', () => {
  it('takes the tank the sample names, without a lookup', async () => {
    const harness = makeHarness();

    await expect(
      harness.service.unitOf(harness.manager, TENANT, { batchId: BATCH, tankId: UNIT }),
    ).resolves.toBe(UNIT);
    expect(harness.query).not.toHaveBeenCalled();
  });

  it('takes the only tank holding the batch, by primary batch or batchDetails entry', async () => {
    const harness = makeHarness({ unitRows: [{ tankId: UNIT }] });

    await expect(
      harness.service.unitOf(harness.manager, TENANT, { batchId: BATCH, tankId: undefined }),
    ).resolves.toBe(UNIT);
    const [sql, params] = harness.query.mock.calls[0]!;
    expect(sql).toContain('"primaryBatchId" = $2');
    expect(sql).toContain('"batchDetails" @> $3::jsonb');
    expect(params).toEqual([TENANT, BATCH, JSON.stringify([{ batchId: BATCH }])]);
  });

  it('answers null when no tank holds the batch', async () => {
    const harness = makeHarness({ unitRows: [] });

    await expect(
      harness.service.unitOf(harness.manager, TENANT, { batchId: BATCH, tankId: undefined }),
    ).resolves.toBeNull();
  });

  it('refuses a batch stocked in several tanks when the sample names none', async () => {
    const harness = makeHarness({ unitRows: [{ tankId: UNIT }, { tankId: OTHER_UNIT }] });

    await expect(
      harness.service.unitOf(harness.manager, TENANT, { batchId: BATCH, tankId: undefined }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('GrowthSampleApplierService.apply', () => {
  it('re-bases the tank, then refreshes the read model and reprices the day plan', async () => {
    const harness = makeHarness();
    const sample = makeSample();

    const saved = await harness.service.apply(
      harness.manager,
      TENANT,
      sample,
      UNIT,
      lockedUnitHolding(harness.batch),
    );

    expect(saved).toBe(harness.batch);
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
    expect(harness.calls).toEqual(['save-batch', 're-base', 'refresh', 'recalc']);
  });

  it("writes the sample onto the batch's weight.actual", async () => {
    const harness = makeHarness();
    const sample = makeSample();

    await harness.service.apply(
      harness.manager,
      TENANT,
      sample,
      UNIT,
      lockedUnitHolding(harness.batch),
    );

    expect(harness.batch.weight.actual).toEqual({
      avgWeight: 30,
      totalBiomass: 30,
      lastMeasuredAt: sample.measurementDate,
      sampleSize: 3,
      confidencePercent: 95,
    });
    expect(harness.save).toHaveBeenCalledWith(Batch, harness.batch);
  });

  it('leaves the day plan alone when the tank already holds a later weighing', async () => {
    const harness = makeHarness({ unitMoved: false });

    await harness.service.apply(
      harness.manager,
      TENANT,
      makeSample(),
      UNIT,
      lockedUnitHolding(harness.batch),
    );

    expect(harness.refreshContainers).not.toHaveBeenCalled();
    expect(harness.recalcForUnit).not.toHaveBeenCalled();
  });

  it('writes only the batch when no tank holds it', async () => {
    const harness = makeHarness();

    await harness.service.apply(harness.manager, TENANT, makeSample(), null, null);

    expect(harness.batch.weight.actual.avgWeight).toBe(30);
    expect(harness.applyMeasuredWeight).not.toHaveBeenCalled();
    expect(harness.recalcForUnit).not.toHaveBeenCalled();
    expect(harness.refreshContainers).not.toHaveBeenCalled();
  });

  it('refuses a sample naming a tank that does not hold the batch, writing nothing', async () => {
    const harness = makeHarness();
    const otherBatch = stub<Batch>({ id: '33333333-3333-4333-8333-333333333333' });
    const lockedElsewhere: LockedUnit = {
      tankBatch: stub<TankBatch>({ tankId: UNIT, tenantId: TENANT }),
      batches: new Map([[otherBatch.id, otherBatch]]),
      details: [],
    };

    await expect(
      harness.service.apply(harness.manager, TENANT, makeSample(), UNIT, lockedElsewhere),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.applyMeasuredWeight).not.toHaveBeenCalled();
  });

  it('refuses a sample naming a tank with no stock row at all', async () => {
    const harness = makeHarness();

    await expect(
      harness.service.apply(harness.manager, TENANT, makeSample(), UNIT, null),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('keeps weight.actual on a weighing from a later day (FARM-MEDIUM-453)', async () => {
    const latest = new Date('2026-10-16T09:00:00.000Z');
    const harness = makeHarness({
      actual: { avgWeight: 50, totalBiomass: 50, lastMeasuredAt: latest, sampleSize: 3 },
    });

    await harness.service.apply(harness.manager, TENANT, makeSample(), null, null);

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

    await harness.service.apply(harness.manager, TENANT, makeSample(), null, null);

    expect(harness.batch.weight.actual.avgWeight).toBe(30);
  });

  it('never holds a sample back on the stocking placeholder (sampleSize 0)', async () => {
    // CreateBatchHandler stamps lastMeasuredAt with the creation time, which is
    // later than any backdated first weighing.
    const harness = makeHarness({
      actual: { lastMeasuredAt: new Date('2026-10-17T10:00:00.000Z'), sampleSize: 0 },
    });

    await harness.service.apply(harness.manager, TENANT, makeSample(), null, null);

    expect(harness.batch.weight.actual.avgWeight).toBe(30);
    expect(harness.batch.weight.actual.sampleSize).toBe(3);
  });
});
