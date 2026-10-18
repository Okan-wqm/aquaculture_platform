/**
 * BiomassGrowthApplier v2 (Faz 5 — D-1/D-2 yeniden tasarımı).
 *
 * Pinler: büyüme batchDetails paylarına biomass oranında dağıtılır ve
 * aggregate'ler detaylardan TÜRETİLİR (D-2); Batch.theoretical TÜM
 * ünitelerdeki payların toplamından hesaplanır — tek tankın değeriyle ezme
 * (v1 bug'ı) imkânsız (D-1); kilit sonrası üyelik değişimi ConflictException
 * (kanonik sıra korunur, K-1); Tank projeksiyonu kaçarsa YAPISAL metrik (P-13).
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import { stub } from '@aquaculture/testing';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH_A = '22222222-2222-4222-8222-222222222222';
const BATCH_B = '33333333-3333-4333-8333-333333333333';

interface HarnessOpts {
  tankBatch?: Partial<TankBatch>;
  lockedTankBatch?: Partial<TankBatch>;
  tankFound?: boolean;
  /** manager.query (batch payları toplamı) cevabı — batchId'ye göre sırayla. */
  shareSums?: Array<Array<{ biomass: number; quantity: number }>>;
}

function makeTankBatch(over: Partial<TankBatch> = {}): TankBatch {
  return stub<TankBatch>({
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
        percentageOfTank: 66.7,
      },
      {
        batchId: BATCH_B,
        batchNumber: 'B-B',
        quantity: 500,
        avgWeightG: 100,
        biomassKg: 50,
        percentageOfTank: 33.3,
      },
    ],
    ...over,
  });
}

function makeBatch(id: string): Batch {
  return stub<Batch>({
    id,
    tenantId: TENANT,
    weight: {
      initial: { avgWeight: 50, totalBiomass: 50, measuredAt: new Date() },
      theoretical: {
        avgWeight: 100,
        totalBiomass: 999, // kasıtlı bayat — yeniden hesap ezmeli
        lastCalculatedAt: new Date(0),
        basedOnFCR: 1,
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

function makeHarness(opts: HarnessOpts = {}) {
  const previewTankBatch = makeTankBatch(opts.tankBatch);
  const lockedTankBatch = makeTankBatch(opts.lockedTankBatch ?? opts.tankBatch ?? {});
  const batchesById = new Map([
    [BATCH_A, makeBatch(BATCH_A)],
    [BATCH_B, makeBatch(BATCH_B)],
  ]);
  const saved: unknown[] = [];
  const queryResults = [...(opts.shareSums ?? [])];

  // EntityManager üyeleri ağır overload'lı — double'lar ANOTASYONSUZ jest.fn()
  // (Mock<any>) bırakılır ki yapısal atanabilirlik cast'siz sağlansın; davranış
  // mockImplementation ile verilir (create-feeding-record spec emsali).
  const findOne = jest.fn();
  let tankBatchReads = 0;
  findOne.mockImplementation(async (entity: unknown, options: { lock?: unknown }) => {
    if (entity === TankBatch) {
      tankBatchReads += 1;
      return options.lock ? lockedTankBatch : previewTankBatch;
    }
    if (entity === Tank) {
      return opts.tankFound === false ? null : stub<Tank>({ id: UNIT, currentBiomass: 0 });
    }
    return null;
  });
  const find = jest.fn();
  find.mockImplementation(async () =>
    [...batchesById.values()].sort((a, b) => a.id.localeCompare(b.id)),
  );
  const save = jest.fn();
  save.mockImplementation(async (entity: unknown) => {
    saved.push(entity);
    return entity;
  });
  const query = jest.fn();
  query.mockImplementation(async () => queryResults.shift() ?? [{ biomass: 0, quantity: 0 }]);

  const manager = stub<EntityManager>({ findOne, find, save, query });
  const metrics = stub<FarmDomainMetricsService>({ recordTankProjectionMiss: jest.fn() });
  const service = new BiomassGrowthApplierService(metrics);
  return {
    service,
    manager,
    metrics,
    saved,
    lockedTankBatch,
    batchesById,
    getTankBatchReads: () => tankBatchReads,
  };
}

describe('BiomassGrowthApplierService', () => {
  it('distributes growth across batchDetails proportional to biomass share and derives aggregates (D-2)', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 103, quantity: 1000 }], [{ biomass: 51.5, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, 3, 1.2);

    const details = harness.lockedTankBatch.batchDetails!;
    // 100/150 ve 50/150 pay → +2kg / +1kg
    expect(details[0]!.biomassKg).toBeCloseTo(102);
    expect(details[1]!.biomassKg).toBeCloseTo(51);
    // Aggregate'ler DETAYLARDAN türetilir
    expect(harness.lockedTankBatch.totalBiomassKg).toBeCloseTo(153);
    expect(harness.lockedTankBatch.avgWeightG).toBeCloseTo(102);
    expect(details[0]!.percentageOfTank).toBeCloseTo(66.667, 2);
  });

  it('recomputes each batch theoretical from the SUM across ALL units in the same tx (D-1)', async () => {
    const harness = makeHarness({
      shareSums: [
        // BATCH_A bu tankta 102 + başka tankta 60.5 = 162.5 / 1600 adet
        [
          { biomass: 102, quantity: 1000 },
          { biomass: 60.5, quantity: 600 },
        ],
        [{ biomass: 51, quantity: 500 }],
      ],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, 3, 1.15);

    const batchA = harness.batchesById.get(BATCH_A)!;
    expect(batchA.weight.theoretical.totalBiomass).toBeCloseTo(162.5);
    expect(batchA.weight.theoretical.avgWeight).toBeCloseTo((162.5 * 1000) / 1600);
    expect(batchA.weight.theoretical.basedOnFCR).toBe(1.15);
    // 999 bayat değeri EZİLDİ — tek-tank ezmesi değil toplamdan hesap.
    expect(batchA.weight.theoretical.totalBiomass).not.toBe(999);
  });

  it('throws retryable ConflictException when batch membership changes during lock acquisition (K-1)', async () => {
    const harness = makeHarness({
      // Kilitli okuma önizlemede olmayan bir batch içeriyor.
      lockedTankBatch: {
        batchDetails: [
          {
            batchId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            batchNumber: 'B-X',
            quantity: 10,
            avgWeightG: 100,
            biomassKg: 1,
            percentageOfTank: 100,
          },
        ],
      },
    });
    await expect(
      harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('records the structural P-13 metric when the Tank projection row is missing', async () => {
    const harness = makeHarness({
      tankFound: false,
      shareSums: [[{ biomass: 102, quantity: 1000 }], [{ biomass: 51, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, 3, 1.2);
    expect(harness.metrics.recordTankProjectionMiss).toHaveBeenCalledWith({
      operation: 'growth_apply',
    });
  });

  it('applies NEGATIVE growth proportionally (correctMealPour rollback — C-11) without going below zero', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 98, quantity: 1000 }], [{ biomass: 49, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, -3, 1.2);

    const details = harness.lockedTankBatch.batchDetails!;
    // 100/150 ve 50/150 pay → -2kg / -1kg
    expect(details[0]!.biomassKg).toBeCloseTo(98);
    expect(details[1]!.biomassKg).toBeCloseTo(49);
    expect(harness.lockedTankBatch.totalBiomassKg).toBeCloseTo(147);
  });

  it('derives a single virtual detail from primary aggregates when batchDetails is empty', async () => {
    const harness = makeHarness({
      tankBatch: { batchDetails: [], totalQuantity: 1000, totalBiomassKg: 100, avgWeightG: 100 },
      shareSums: [[{ biomass: 103, quantity: 1000 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    expect(locked!.details).toHaveLength(1);
    expect(locked!.details[0]!.batchId).toBe(BATCH_A);
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, 3, 1.2);
    expect(harness.lockedTankBatch.totalBiomassKg).toBeCloseTo(103);
  });
});

/**
 * The weighing path (FARM-CRITICAL-454): a sample re-bases the weighed batch's
 * share of the unit, which every ration path reads, and only that share.
 */
describe('BiomassGrowthApplierService.applyMeasuredWeight', () => {
  const WEIGHED_AT = new Date('2026-10-15T09:00:00.000Z');

  it("re-bases only the weighed batch's share and derives the unit from it", async () => {
    const harness = makeHarness({
      // D-1 input after the re-base: BATCH_A's share is 1000 fish at 130 g.
      shareSums: [[{ biomass: 130, quantity: 1000 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    const moved = await harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
      batchId: BATCH_A,
      avgWeightG: 130,
      measuredAt: WEIGHED_AT,
    });

    expect(moved).toBe(true);
    const [weighed, other] = harness.lockedTankBatch.batchDetails!;
    expect(weighed).toMatchObject({ biomassKg: 130, avgWeightG: 130, quantity: 1000 });
    expect(weighed!.lastSampledAt).toBe(WEIGHED_AT.toISOString());
    // The other batch was not sampled: its share keeps its weight.
    expect(other).toMatchObject({ biomassKg: 50, avgWeightG: 100, quantity: 500 });
    expect(other!.lastSampledAt).toBeUndefined();
    // 130 + 50 = 180 kg over the unchanged 1500 fish.
    expect(harness.lockedTankBatch.totalBiomassKg).toBe(180);
    expect(harness.lockedTankBatch.currentBiomassKg).toBe(180);
    expect(harness.lockedTankBatch.avgWeightG).toBe(120);
    expect(harness.lockedTankBatch.totalQuantity).toBe(1500);
    expect(harness.lockedTankBatch.lastSamplingAt).toEqual(WEIGHED_AT);
    expect(harness.saved).toContain(harness.lockedTankBatch);
  });

  it("restamps the weighed batch's theoretical track from its shares and keeps its FCR (D-1)", async () => {
    const harness = makeHarness({ shareSums: [[{ biomass: 130, quantity: 1000 }]] });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    await harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
      batchId: BATCH_A,
      avgWeightG: 130,
      measuredAt: WEIGHED_AT,
    });

    const batchA = harness.batchesById.get(BATCH_A)!;
    expect(batchA.weight.theoretical.totalBiomass).toBe(130);
    expect(batchA.weight.theoretical.avgWeight).toBe(130);
    expect(batchA.weight.theoretical.basedOnFCR).toBe(1);
    // The unsampled batch's track is not touched.
    expect(harness.batchesById.get(BATCH_B)!.weight.theoretical.totalBiomass).toBe(999);
  });

  it('counts a missing Tank projection row under its own label (P-13)', async () => {
    const harness = makeHarness({
      tankFound: false,
      shareSums: [[{ biomass: 130, quantity: 1000 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    await harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
      batchId: BATCH_A,
      avgWeightG: 130,
      measuredAt: WEIGHED_AT,
    });

    expect(harness.metrics.recordTankProjectionMiss).toHaveBeenCalledWith({
      operation: 'growth_measure',
    });
  });

  it('refuses a sample of a batch the unit does not hold, writing nothing', async () => {
    const harness = makeHarness();
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    await expect(
      harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
        batchId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        avgWeightG: 130,
        measuredAt: WEIGHED_AT,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.saved).toEqual([]);
  });

  it('refuses an average that is not a positive weight, writing nothing', async () => {
    const harness = makeHarness();
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    await expect(
      harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
        batchId: BATCH_A,
        avgWeightG: 0,
        measuredAt: WEIGHED_AT,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.saved).toEqual([]);
  });

  it('moves nothing for a sample from an earlier day than the share was last weighed on', async () => {
    const harness = makeHarness({
      lockedTankBatch: {
        batchDetails: [
          {
            batchId: BATCH_A,
            batchNumber: 'B-A',
            quantity: 1000,
            avgWeightG: 130,
            biomassKg: 130,
            percentageOfTank: 72.2,
            lastSampledAt: WEIGHED_AT.toISOString(),
          },
          {
            batchId: BATCH_B,
            batchNumber: 'B-B',
            quantity: 500,
            avgWeightG: 100,
            biomassKg: 50,
            percentageOfTank: 27.8,
          },
        ],
      },
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    const moved = await harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
      batchId: BATCH_A,
      avgWeightG: 90,
      // A `date` column's text, one day before the share's last weighing.
      measuredAt: '2026-10-14',
    });

    expect(moved).toBe(false);
    expect(harness.lockedTankBatch.batchDetails![0]).toMatchObject({
      avgWeightG: 130,
      biomassKg: 130,
    });
    expect(harness.saved).toEqual([]);
  });

  it('applies a second sample of the same day: the later-recorded one is current', async () => {
    const harness = makeHarness({
      lockedTankBatch: {
        lastSamplingAt: WEIGHED_AT,
        batchDetails: [
          {
            batchId: BATCH_A,
            batchNumber: 'B-A',
            quantity: 1000,
            avgWeightG: 130,
            biomassKg: 130,
            percentageOfTank: 100,
            lastSampledAt: WEIGHED_AT.toISOString(),
          },
        ],
      },
      shareSums: [[{ biomass: 125, quantity: 1000 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    const moved = await harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
      batchId: BATCH_A,
      avgWeightG: 125,
      measuredAt: '2026-10-15',
    });

    expect(moved).toBe(true);
    expect(harness.lockedTankBatch.batchDetails![0]).toMatchObject({ avgWeightG: 125 });
    // The row keeps the tank's latest stamp: the same-day text reads as midnight.
    expect(harness.lockedTankBatch.lastSamplingAt).toEqual(WEIGHED_AT);
  });
});
