/**
 * BiomassGrowthApplier — MEASUREMENT path (Faz 0.1 / 0.3 / 0.5 / 0.7).
 *
 * These tests pin the behaviour that did not exist before this phase: a
 * weighing reaching the unit's aggregates, and the persisted record being able
 * to tell a MEASURED weight from an FCR-PROJECTED one.
 *
 * Every test here fails on the pre-phase service: `reconcileMeasuredWeight` did
 * not exist, `TankBatch.weightProvenance` did not exist, `lastSamplingAt` had
 * no writer anywhere in the repo, and `Batch.weight.variance` was a dead block
 * nothing ever computed.
 */
import { EntityManager } from 'typeorm';

import {
  BiomassGrowthApplierService,
  type MeasurementProvenance,
} from '../services/biomass-growth-applier.service';
import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH_A = '22222222-2222-4222-8222-222222222222';
const BATCH_B = '33333333-3333-4333-8333-333333333333';
const MEASUREMENT = '44444444-4444-4444-8444-444444444444';
const MEASURED_AT = new Date('2026-08-07T06:30:00.000Z');

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

const provenance: MeasurementProvenance = {
  source: 'measurement',
  measurementId: MEASUREMENT,
  measuredAt: MEASURED_AT,
  sampleSize: 200,
  confidencePercent: 95,
};

/** Mixed tank: A = 1000 fish @100 g (100 kg), B = 500 fish @100 g (50 kg). */
function makeTankBatch(over: Partial<TankBatch> = {}): TankBatch {
  return mock<TankBatch>({
    id: 'tb-1',
    tenantId: TENANT,
    tankId: UNIT,
    totalQuantity: 1500,
    totalBiomassKg: 150,
    currentBiomassKg: 150,
    avgWeightG: 100,
    primaryBatchId: BATCH_A,
    primaryBatchNumber: 'B-A',
    batchDetails: [
      {
        batchId: BATCH_A,
        batchNumber: 'B-A',
        quantity: 1000,
        avgWeightG: 100,
        biomassKg: 100,
        percentageOfTank: 66.667,
      },
      {
        batchId: BATCH_B,
        batchNumber: 'B-B',
        quantity: 500,
        avgWeightG: 100,
        biomassKg: 50,
        percentageOfTank: 33.333,
      },
    ],
    ...over,
  });
}

function makeBatch(id: string): Batch {
  return mock<Batch>({
    id,
    tenantId: TENANT,
    stockedAt: new Date('2026-01-01T00:00:00.000Z'),
    weight: {
      initial: { avgWeight: 50, totalBiomass: 50, measuredAt: new Date(0) },
      theoretical: {
        avgWeight: 100,
        totalBiomass: 100,
        lastCalculatedAt: new Date(0),
        basedOnFCR: 1.2,
      },
      actual: {
        avgWeight: 0,
        totalBiomass: 0,
        lastMeasuredAt: new Date(0),
        sampleSize: 0,
        confidencePercent: 0,
      },
      variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
    },
  });
}

interface HarnessOpts {
  tankBatch?: Partial<TankBatch>;
  /** manager.query (cross-unit share sums) answers, in batchId order. */
  shareSums?: Array<Array<{ biomass: number; quantity: number }>>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const previewTankBatch = makeTankBatch(opts.tankBatch);
  const lockedTankBatch = makeTankBatch(opts.tankBatch);
  const batchesById = new Map([
    [BATCH_A, makeBatch(BATCH_A)],
    [BATCH_B, makeBatch(BATCH_B)],
  ]);
  const queryResults = [...(opts.shareSums ?? [])];
  const tank = mock<Tank>({ id: UNIT, currentBiomass: 0 });

  // EntityManager members are heavily overloaded — the doubles stay UNANNOTATED
  // jest.fn() so structural assignability holds without a cast.
  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown, options: { lock?: unknown }) => {
    if (entity === TankBatch) return options.lock ? lockedTankBatch : previewTankBatch;
    if (entity === Tank) return tank;
    return null;
  });
  const find = jest.fn();
  find.mockImplementation(async () =>
    [...batchesById.values()].sort((a, b) => a.id.localeCompare(b.id)),
  );
  const save = jest.fn();
  save.mockImplementation(async (entity: unknown) => entity);
  const query = jest.fn();
  query.mockImplementation(async () => queryResults.shift() ?? [{ biomass: 0, quantity: 0 }]);

  const manager = mock<EntityManager>({ findOne, find, save, query });
  const service = new BiomassGrowthApplierService(
    mock<FarmDomainMetricsService>({ recordTankProjectionMiss: jest.fn() }),
  );
  return { service, manager, lockedTankBatch, batchesById, tank };
}

describe('BiomassGrowthApplierService — measurement path', () => {
  it('moves the unit onto the MEASURED weight (this is the link that did not exist)', async () => {
    const harness = makeHarness({
      // A: 140kg here, B: 70kg here — the cross-unit sums after the write.
      shareSums: [[{ biomass: 140, quantity: 1000 }], [{ biomass: 70, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    // Fish were projected at 100 g; the scale says 140 g.
    const result = await harness.service.reconcileMeasuredWeight(
      harness.manager,
      TENANT,
      locked!,
      140,
      provenance,
    );

    expect(harness.lockedTankBatch.avgWeightG).toBeCloseTo(140);
    expect(harness.lockedTankBatch.totalBiomassKg).toBeCloseTo(210); // 1500 × 140 g
    expect(harness.lockedTankBatch.currentBiomassKg).toBeCloseTo(210);
    expect(result).toMatchObject({
      projectedAvgWeightG: 100,
      measuredAvgWeightG: 140,
      projectionErrorPercent: 40, // the model was 40% low
      appliedDeltaKg: 60,
      fishCount: 1500,
    });
  });

  it('projects the corrected biomass onto the Tank row (capacity/density read model)', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 140, quantity: 1000 }], [{ biomass: 70, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.reconcileMeasuredWeight(
      harness.manager,
      TENANT,
      locked!,
      140,
      provenance,
    );
    expect(harness.tank.currentBiomass).toBeCloseTo(210);
  });

  it('distributes a mixed tank proportionally and re-derives aggregates FROM batchDetails', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 140, quantity: 1000 }], [{ biomass: 70, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.reconcileMeasuredWeight(
      harness.manager,
      TENANT,
      locked!,
      140,
      provenance,
    );

    const details = harness.lockedTankBatch.batchDetails!;
    // +60 kg delta split by biomass share (100/150, 50/150) → +40 / +20.
    expect(details[0]!.biomassKg).toBeCloseTo(140);
    expect(details[1]!.biomassKg).toBeCloseTo(70);
    // Per-batch avg weight re-derived from that batch's own share.
    expect(details[0]!.avgWeightG).toBeCloseTo(140);
    expect(details[1]!.avgWeightG).toBeCloseTo(140);
    // Aggregates are the SUM of the details, never an independently set value.
    const sum = details.reduce((acc, d) => acc + d.biomassKg, 0);
    expect(harness.lockedTankBatch.totalBiomassKg).toBeCloseTo(sum);
    expect(details[0]!.percentageOfTank + details[1]!.percentageOfTank).toBeCloseTo(100);
  });

  it('NEVER restates the population — a sample asserts weight, not count', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 140, quantity: 1000 }], [{ biomass: 70, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    const before = {
      total: harness.lockedTankBatch.totalQuantity,
      a: harness.lockedTankBatch.batchDetails![0]!.quantity,
      b: harness.lockedTankBatch.batchDetails![1]!.quantity,
    };

    await harness.service.reconcileMeasuredWeight(
      harness.manager,
      TENANT,
      locked!,
      140,
      provenance,
    );

    expect(harness.lockedTankBatch.totalQuantity).toBe(before.total);
    expect(harness.lockedTankBatch.batchDetails![0]!.quantity).toBe(before.a);
    expect(harness.lockedTankBatch.batchDetails![1]!.quantity).toBe(before.b);
  });

  it('applies a DOWNWARD correction when the fish are lighter than projected', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 60, quantity: 1000 }], [{ biomass: 30, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    const result = await harness.service.reconcileMeasuredWeight(
      harness.manager,
      TENANT,
      locked!,
      60,
      provenance,
    );

    expect(harness.lockedTankBatch.totalBiomassKg).toBeCloseTo(90); // 1500 × 60 g
    expect(result!.appliedDeltaKg).toBeCloseTo(-60);
    expect(result!.projectionErrorPercent).toBeCloseTo(-40);
  });

  it('stamps lastSamplingAt — a column that had NO writer in the whole repo', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 140, quantity: 1000 }], [{ biomass: 70, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    expect(harness.lockedTankBatch.lastSamplingAt).toBeUndefined();

    await harness.service.reconcileMeasuredWeight(
      harness.manager,
      TENANT,
      locked!,
      140,
      provenance,
    );
    expect(harness.lockedTankBatch.lastSamplingAt).toBe(MEASURED_AT);
  });

  it('ignores a non-positive measurement rather than zeroing the unit', async () => {
    const harness = makeHarness();
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await expect(
      harness.service.reconcileMeasuredWeight(harness.manager, TENANT, locked!, 0, provenance),
    ).resolves.toBeNull();
    expect(harness.lockedTankBatch.totalBiomassKg).toBeCloseTo(150);
  });

  it('distributes by COUNT share when the unit carries fish but zero biomass', async () => {
    const harness = makeHarness({
      tankBatch: {
        totalBiomassKg: 0,
        currentBiomassKg: 0,
        avgWeightG: 0,
        batchDetails: [
          {
            batchId: BATCH_A,
            batchNumber: 'B-A',
            quantity: 1000,
            avgWeightG: 0,
            biomassKg: 0,
            percentageOfTank: 100,
          },
          {
            batchId: BATCH_B,
            batchNumber: 'B-B',
            quantity: 500,
            avgWeightG: 0,
            biomassKg: 0,
            percentageOfTank: 0,
          },
        ],
      },
      shareSums: [[{ biomass: 80, quantity: 1000 }], [{ biomass: 40, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.reconcileMeasuredWeight(harness.manager, TENANT, locked!, 80, provenance);

    const details = harness.lockedTankBatch.batchDetails!;
    expect(details[0]!.biomassKg).toBeCloseTo(80); // 1000 × 80 g
    expect(details[1]!.biomassKg).toBeCloseTo(40); // 500 × 80 g
    expect(harness.lockedTankBatch.totalBiomassKg).toBeCloseTo(120);
  });
});

describe('BiomassGrowthApplierService — provenance is distinguishable', () => {
  it('tags an FCR write as a PROJECTION on both the unit and the batch', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 102, quantity: 1000 }], [{ biomass: 51, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, 3, 1.25);

    expect(harness.lockedTankBatch.weightProvenance).toMatchObject({
      source: 'fcr_projection',
      basedOnFcr: 1.25,
    });
    // An FCR projection must NOT masquerade as a sampling event.
    expect(harness.lockedTankBatch.lastSamplingAt).toBeUndefined();

    const batchA = harness.batchesById.get(BATCH_A)!;
    expect(batchA.weight.theoretical.basedOnFCR).toBe(1.25);
    expect(batchA.weight.theoretical.totalBiomass).toBeCloseTo(102);
    // The MEASURED track is untouched by a projection.
    expect(batchA.weight.actual.avgWeight).toBe(0);
    expect(batchA.weight.actual.sampleSize).toBe(0);
  });

  it('tags a weighing as a MEASUREMENT, on the other track, carrying the error it just measured', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 140, quantity: 1000 }], [{ biomass: 70, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.reconcileMeasuredWeight(
      harness.manager,
      TENANT,
      locked!,
      140,
      provenance,
    );

    expect(harness.lockedTankBatch.weightProvenance).toMatchObject({
      source: 'measurement',
      measurementId: MEASUREMENT,
      sampleSize: 200,
      confidencePercent: 95,
      measuredAvgWeightG: 140,
      supersededProjectedAvgWeightG: 100,
      projectionErrorPercent: 40,
    });

    const batchA = harness.batchesById.get(BATCH_A)!;
    expect(batchA.weight.actual).toMatchObject({
      avgWeight: 140,
      totalBiomass: 140,
      lastMeasuredAt: MEASURED_AT,
      sampleSize: 200,
      confidencePercent: 95,
    });
    // The projection track keeps its own (now provably wrong) number — that is
    // the whole point: the two are comparable instead of indistinguishable.
    expect(batchA.weight.theoretical.avgWeight).toBe(100);
    expect(batchA.weight.theoretical.basedOnFCR).toBe(1.2);
  });

  it('computes Batch.weight.variance — a block that previously had NO writer', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 140, quantity: 1000 }], [{ biomass: 70, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.reconcileMeasuredWeight(
      harness.manager,
      TENANT,
      locked!,
      140,
      provenance,
    );

    const batchA = harness.batchesById.get(BATCH_A)!;
    // actual 140 g vs theoretical 100 g.
    expect(batchA.weight.variance.weightDifference).toBeCloseTo(40);
    expect(batchA.weight.variance.percentageDifference).toBeCloseTo(40);
    expect(batchA.weight.variance.isSignificant).toBe(true);
  });

  it('does not flag a small projection error as significant', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 105, quantity: 1000 }], [{ biomass: 52.5, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.reconcileMeasuredWeight(
      harness.manager,
      TENANT,
      locked!,
      105,
      provenance,
    );
    const batchA = harness.batchesById.get(BATCH_A)!;
    expect(batchA.weight.variance.percentageDifference).toBeCloseTo(5);
    expect(batchA.weight.variance.isSignificant).toBe(false);
  });

  it('BUILDS a missing weight block instead of silently skipping the write', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 140, quantity: 1000 }], [{ biomass: 70, quantity: 500 }]],
    });
    // Legacy row: partial JSONB with no `actual` block at all. The pre-phase
    // code did `if (batch.weight?.actual)` and wrote NOTHING.
    const batchA = harness.batchesById.get(BATCH_A)!;
    batchA.weight = mock<Batch['weight']>({
      initial: { avgWeight: 50, totalBiomass: 50, measuredAt: new Date(0) },
    });

    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.reconcileMeasuredWeight(
      harness.manager,
      TENANT,
      locked!,
      140,
      provenance,
    );

    expect(batchA.weight.actual.avgWeight).toBeCloseTo(140);
    expect(batchA.weight.actual.sampleSize).toBe(200);
  });
});
