/**
 * BiomassGrowthApplier v2 (Faz 5 — D-1/D-2 yeniden tasarımı).
 *
 * Pinler: büyüme batchDetails paylarına biomass oranında dağıtılır ve
 * aggregate'ler detaylardan TÜRETİLİR (D-2); Batch.theoretical TÜM
 * ünitelerdeki payların toplamından hesaplanır — tek tankın değeriyle ezme
 * (v1 bug'ı) imkânsız (D-1); kilit sonrası üyelik değişimi ConflictException
 * (kanonik sıra korunur, K-1); Tank projeksiyonu kaçarsa YAPISAL metrik (P-13).
 */
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH_A = '22222222-2222-4222-8222-222222222222';
const BATCH_B = '33333333-3333-4333-8333-333333333333';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface HarnessOpts {
  tankBatch?: Partial<TankBatch>;
  lockedTankBatch?: Partial<TankBatch>;
  tankFound?: boolean;
  /** manager.query (batch payları toplamı) cevabı — batchId'ye göre sırayla. */
  shareSums?: Array<Array<{ biomass: number; quantity: number }>>;
}

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
  return mock<Batch>({
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
      return opts.tankFound === false ? null : mock<Tank>({ id: UNIT, currentBiomass: 0 });
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

  const manager = mock<EntityManager>({ findOne, find, save, query });
  const metrics = mock<FarmDomainMetricsService>({ recordTankProjectionMiss: jest.fn() });
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
