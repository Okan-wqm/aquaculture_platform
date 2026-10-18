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
/** The feeding day the growth in these cases belongs to. */
const FED_ON = '2026-10-15';

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
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, 3, 1.2, FED_ON);

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
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, 3, 1.15, FED_ON);

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
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, 3, 1.2, FED_ON);
    expect(harness.metrics.recordTankProjectionMiss).toHaveBeenCalledWith({
      operation: 'growth_apply',
    });
  });

  it('applies NEGATIVE growth proportionally (correctMealPour rollback — C-11) without going below zero', async () => {
    const harness = makeHarness({
      shareSums: [[{ biomass: 98, quantity: 1000 }], [{ biomass: 49, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, -3, 1.2, FED_ON);

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
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, 3, 1.2, FED_ON);
    expect(harness.lockedTankBatch.totalBiomassKg).toBeCloseTo(103);
  });

  it('stamps every share that takes growth with its feeding day, keeping a later stamp', async () => {
    const harness = makeHarness({
      lockedTankBatch: {
        batchDetails: [
          {
            batchId: BATCH_A,
            batchNumber: 'B-A',
            quantity: 1000,
            avgWeightG: 100,
            biomassKg: 100,
            percentageOfTank: 66.7,
            grownThrough: '2026-10-14',
          },
          {
            batchId: BATCH_B,
            batchNumber: 'B-B',
            quantity: 500,
            avgWeightG: 100,
            biomassKg: 50,
            percentageOfTank: 33.3,
            grownThrough: '2026-10-16',
          },
        ],
      },
      shareSums: [[{ biomass: 102, quantity: 1000 }], [{ biomass: 51, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    // A Date carries its UTC day: 2026-10-15.
    await harness.service.applyGrowth(
      harness.manager,
      TENANT,
      locked!,
      3,
      1.2,
      new Date('2026-10-15T18:00:00.000Z'),
    );

    const [a, b] = harness.lockedTankBatch.batchDetails!;
    expect(a!.grownThrough).toBe('2026-10-15');
    // A pour correction for an earlier day does not move a later stamp back.
    expect(b!.grownThrough).toBe('2026-10-16');
    expect(a!.biomassKg).toBeCloseTo(102);
    expect(b!.biomassKg).toBeCloseTo(51);
  });

  it("keeps a feeding day's growth off a share weighed on a later day; the other share takes only its part", async () => {
    const harness = makeHarness({
      lockedTankBatch: {
        batchDetails: [
          {
            batchId: BATCH_A,
            batchNumber: 'B-A',
            quantity: 1000,
            avgWeightG: 100,
            biomassKg: 100,
            percentageOfTank: 66.7,
            // Weighed the day after the feeding whose growth arrives now (a
            // daily rollup or pour correction landing after the weighing).
            weighedOn: '2026-10-16',
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
      },
      shareSums: [[{ biomass: 100, quantity: 1000 }], [{ biomass: 51, quantity: 500 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, 3, 1.2, FED_ON);

    const [weighed, other] = harness.lockedTankBatch.batchDetails!;
    // The weighing measured the fish after that feeding: their share is the measurement.
    expect(weighed).toMatchObject({ biomassKg: 100, avgWeightG: 100 });
    expect(weighed!.grownThrough).toBeUndefined();
    // 50/150 of 3 kg: the other fish ate only their part of the feed.
    expect(other!.biomassKg).toBeCloseTo(51);
    expect(other!.grownThrough).toBe(FED_ON);
    expect(harness.lockedTankBatch.totalBiomassKg).toBeCloseTo(151);
  });

  it('lets growth of the weighing day itself land on the weighed share', async () => {
    const harness = makeHarness({
      lockedTankBatch: {
        batchDetails: [
          {
            batchId: BATCH_A,
            batchNumber: 'B-A',
            quantity: 1000,
            avgWeightG: 100,
            biomassKg: 100,
            percentageOfTank: 100,
            weighedOn: FED_ON,
          },
        ],
      },
      tankBatch: {
        batchDetails: [
          {
            batchId: BATCH_A,
            batchNumber: 'B-A',
            quantity: 1000,
            avgWeightG: 100,
            biomassKg: 100,
            percentageOfTank: 100,
          },
        ],
      },
      shareSums: [[{ biomass: 103, quantity: 1000 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);
    await harness.service.applyGrowth(harness.manager, TENANT, locked!, 3, 1.2, FED_ON);

    expect(harness.lockedTankBatch.batchDetails![0]!.biomassKg).toBeCloseTo(103);
  });

  it('holds nothing in an emptied row that still names the batch that left (no share, no batch lock)', async () => {
    const emptied: Partial<TankBatch> = {
      batchDetails: [],
      totalQuantity: 0,
      totalBiomassKg: 0,
      avgWeightG: 0,
      // Left behind by the writer before it cleared the primary of an emptied tank.
      primaryBatchId: BATCH_A,
    };
    const harness = makeHarness({ tankBatch: emptied });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    expect(locked!.details).toEqual([]);
    expect(locked!.batches.size).toBe(0);
    expect(harness.service.stockedShareOf(locked!, BATCH_A)).toBeNull();
  });
});

describe('BiomassGrowthApplierService membership', () => {
  it('stockedShareOf returns a share only when it has fish in it', async () => {
    const harness = makeHarness({
      tankBatch: {
        batchDetails: [
          {
            batchId: BATCH_A,
            batchNumber: 'B-A',
            quantity: 0,
            avgWeightG: 100,
            biomassKg: 0,
            percentageOfTank: 0,
          },
          {
            batchId: BATCH_B,
            batchNumber: 'B-B',
            quantity: 500,
            avgWeightG: 100,
            biomassKg: 50,
            percentageOfTank: 100,
          },
        ],
      },
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    expect(harness.service.stockedShareOf(locked!, BATCH_A)).toBeNull();
    expect(harness.service.stockedShareOf(locked!, BATCH_B)).toMatchObject({ quantity: 500 });
    expect(harness.service.stockedShareOf(locked!, 'not-in-unit')).toBeNull();
  });

  it('unitsHoldingBatch counts a share with fish, or a pre-SSoT primary with fish, never an emptied primary', async () => {
    const harness = makeHarness({ shareSums: [[{ biomass: 0, quantity: 0 }]] });
    const query = jest.fn();
    query.mockResolvedValue([{ tankId: 'unit-1' }, { tankId: 'unit-2' }]);
    const manager = stub<EntityManager>({ query });

    await expect(harness.service.unitsHoldingBatch(manager, TENANT, BATCH_A)).resolves.toEqual([
      'unit-1',
      'unit-2',
    ]);
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(params).toEqual([TENANT, BATCH_A]);
    expect(sql).toContain(`(detail.value->>'quantity')::numeric > 0`);
    expect(sql).toMatch(
      /"primaryBatchId"::text = \$2[\s\S]*jsonb_array_length[\s\S]*"totalQuantity" > 0/,
    );
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

    const outcome = await harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
      batchId: BATCH_A,
      avgWeightG: 130,
      measuredAt: WEIGHED_AT,
    });

    expect(outcome).toBe('rebased');
    const [weighed, other] = harness.lockedTankBatch.batchDetails!;
    expect(weighed).toMatchObject({ biomassKg: 130, avgWeightG: 130, quantity: 1000 });
    expect(weighed!.weighedOn).toBe('2026-10-15');
    // The other batch was not sampled: its share keeps its weight.
    expect(other).toMatchObject({ biomassKg: 50, avgWeightG: 100, quantity: 500 });
    expect(other!.weighedOn).toBeUndefined();
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

  it('refuses a share with no fish in it (an emptied share is not membership), writing nothing', async () => {
    const harness = makeHarness({
      tankBatch: {
        batchDetails: [
          {
            batchId: BATCH_A,
            batchNumber: 'B-A',
            quantity: 0,
            avgWeightG: 100,
            biomassKg: 0,
            percentageOfTank: 0,
          },
        ],
      },
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    await expect(
      harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
        batchId: BATCH_A,
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
            weighedOn: '2026-10-15',
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

    const outcome = await harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
      batchId: BATCH_A,
      avgWeightG: 90,
      // A `date` column's text, one day before the share's last weighing.
      measuredAt: '2026-10-14',
    });

    expect(outcome).toBe('older_than_share');
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
            weighedOn: '2026-10-15',
          },
        ],
      },
      shareSums: [[{ biomass: 125, quantity: 1000 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    const outcome = await harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
      batchId: BATCH_A,
      avgWeightG: 125,
      measuredAt: '2026-10-15',
    });

    expect(outcome).toBe('rebased');
    expect(harness.lockedTankBatch.batchDetails![0]).toMatchObject({ avgWeightG: 125 });
    // The row keeps the tank's latest stamp: the same-day text reads as midnight.
    expect(harness.lockedTankBatch.lastSamplingAt).toEqual(WEIGHED_AT);
  });

  it('moves nothing for a sample dated before the last feeding day whose growth the share holds', async () => {
    const shares: Partial<TankBatch> = {
      batchDetails: [
        {
          batchId: BATCH_A,
          batchNumber: 'B-A',
          quantity: 1000,
          avgWeightG: 180,
          biomassKg: 180,
          percentageOfTank: 100,
          // Twenty days of fed meals: the projection holds growth through 10-15.
          grownThrough: '2026-10-15',
        },
      ],
    };
    const harness = makeHarness({ tankBatch: shares });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    // A day-5 weighing entered on day 20: it agrees with the projection on day 5,
    // and re-basing onto it would throw away fifteen days of growth.
    const outcome = await harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
      batchId: BATCH_A,
      avgWeightG: 116,
      measuredAt: '2026-09-30',
    });

    expect(outcome).toBe('older_than_share');
    expect(harness.lockedTankBatch.batchDetails![0]).toMatchObject({
      biomassKg: 180,
      avgWeightG: 180,
    });
    expect(harness.saved).toEqual([]);
  });

  it('applies a sample of the last fed day itself', async () => {
    const harness = makeHarness({
      tankBatch: {
        batchDetails: [
          {
            batchId: BATCH_A,
            batchNumber: 'B-A',
            quantity: 1000,
            avgWeightG: 180,
            biomassKg: 180,
            percentageOfTank: 100,
            grownThrough: '2026-10-15',
          },
        ],
      },
      shareSums: [[{ biomass: 190, quantity: 1000 }]],
    });
    const locked = await harness.service.lockUnitForGrowth(harness.manager, TENANT, UNIT);

    const outcome = await harness.service.applyMeasuredWeight(harness.manager, TENANT, locked!, {
      batchId: BATCH_A,
      avgWeightG: 190,
      measuredAt: '2026-10-15',
    });

    expect(outcome).toBe('rebased');
    expect(harness.lockedTankBatch.batchDetails![0]).toMatchObject({
      biomassKg: 190,
      weighedOn: '2026-10-15',
      grownThrough: '2026-10-15',
    });
  });
});
