/**
 * THE regression this phase exists to prevent: a weighing must change the feed
 * plan.
 *
 * Before Faz 0.1 a growth sample wrote `Batch.weight.actual` and stopped. Every
 * plan path reads the UNIT (`TankBatch.avgWeightG` / `totalBiomassKg`), so
 * weighing 200 fish and finding them 40% heavier than the FCR model believed
 * changed NOTHING about the next morning's ration.
 *
 * This spec wires the REAL primitives together — no mock stands in for the
 * thing under test:
 *   BiomassGrowthApplierService.reconcileMeasuredWeight (the measurement path)
 *     → TankBatch aggregates
 *     → MealPlanGeneratorService.computeDayPlan (the 06:00 planner)
 * and asserts the ration moves, in the right direction, by the right amount,
 * and lands in the band the fish were actually measured into.
 */
import { EntityManager } from 'typeorm';

import {
  BiomassGrowthApplierService,
  type MeasurementProvenance,
} from '../services/biomass-growth-applier.service';
import {
  MealPlanGeneratorService,
  mixedTankStats,
  type ComputeDayPlanInput,
} from '../services/meal-plan-generator.service';
import { ProtocolRateService, tankBandWeightG } from '../services/protocol-rate.service';
import { FeedTypeTransitionService } from '../services/feed-transition.service';
import { ProtocolFcrSource, type MealSchedule } from '../entities/feeding-protocol-v2.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import type { EffectiveTemperature } from '../../water-quality/services/water-temperature.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH_A = '22222222-2222-4222-8222-222222222222';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

const SCHEDULE: MealSchedule = {
  mealsPerDay: 2,
  entries: [
    { time: '08:00', percentOfDaily: 60 },
    { time: '16:00', percentOfDaily: 40 },
  ],
};

/** Rate FALLS as fish grow — so a heavier measurement must not simply scale up. */
const PROTOCOL = {
  bands: [
    {
      minWeightG: 0,
      maxWeightG: 100,
      feedId: 'feed-small',
      feedCode: 'FS',
      feedName: 'Small',
      feedingRatePercent: 3,
      expectedFcr: 1.1,
    },
    {
      minWeightG: 100,
      maxWeightG: 500,
      feedId: 'feed-large',
      feedCode: 'FL',
      feedName: 'Large',
      feedingRatePercent: 2,
      expectedFcr: 1.3,
    },
  ],
  defaultMealSchedule: SCHEDULE,
  temperatureAdjustments: [],
  fcrMatrix: undefined,
  settings: {
    autoTransition: true,
    transitionBufferG: 5,
    growthApplicationMode: 'per_meal' as const,
    underfeedAlertThresholdPercent: 15,
    fcrSource: ProtocolFcrSource.BAND,
  },
};

const TEMP: EffectiveTemperature = { celsius: null, source: 'none' };

const provenance: MeasurementProvenance = {
  source: 'measurement',
  measurementId: '44444444-4444-4444-8444-444444444444',
  measuredAt: new Date('2026-08-07T06:30:00.000Z'),
  sampleSize: 200,
  confidencePercent: 95,
};

/** 10 000 fish the model projected at 80 g → 800 kg, band "small" @3%. */
function makeUnit(): TankBatch {
  return mock<TankBatch>({
    id: 'tb-1',
    tenantId: TENANT,
    tankId: UNIT,
    totalQuantity: 10_000,
    totalBiomassKg: 800,
    currentBiomassKg: 800,
    avgWeightG: 80,
    primaryBatchId: BATCH_A,
    primaryBatchNumber: 'B-A',
    batchDetails: [
      {
        batchId: BATCH_A,
        batchNumber: 'B-A',
        quantity: 10_000,
        avgWeightG: 80,
        biomassKg: 800,
        percentageOfTank: 100,
      },
    ],
  });
}

function makeManager(unit: TankBatch, shareSums: Array<{ biomass: number; quantity: number }>) {
  const batch = mock<Batch>({
    id: BATCH_A,
    tenantId: TENANT,
    stockedAt: new Date('2026-01-01T00:00:00.000Z'),
    weight: {
      initial: { avgWeight: 5, totalBiomass: 50, measuredAt: new Date(0) },
      theoretical: {
        avgWeight: 80,
        totalBiomass: 800,
        lastCalculatedAt: new Date(0),
        basedOnFCR: 1.1,
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
  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown) => {
    if (entity === TankBatch) return unit;
    if (entity === Tank) return mock<Tank>({ id: UNIT, currentBiomass: 0 });
    return null;
  });
  const find = jest.fn();
  find.mockImplementation(async () => [batch]);
  const save = jest.fn();
  save.mockImplementation(async (entity: unknown) => entity);
  const query = jest.fn();
  query.mockImplementation(async () => shareSums);
  return { manager: mock<EntityManager>({ findOne, find, save, query }), batch };
}

/** The 06:00 planner, run against whatever state the unit is in right now. */
function planFor(unit: TankBatch): ReturnType<MealPlanGeneratorService['computeDayPlan']> {
  const rateService = new ProtocolRateService();
  const generator = new MealPlanGeneratorService(
    rateService,
    new FeedTypeTransitionService(rateService, {
      enqueue: jest.fn().mockResolvedValue(undefined),
    } as never),
  );
  const input: ComputeDayPlanInput = {
    assignment: { overrides: {}, suspensions: [], currentFeedId: undefined },
    protocol: PROTOCOL,
    stock: {
      fishCount: unit.totalQuantity,
      biomassKg: Number(unit.totalBiomassKg),
      avgWeightG: tankBandWeightG(unit),
      ...mixedTankStats(unit.batchDetails),
    },
    temperature: TEMP,
    planDate: '2026-08-08',
    timezone: 'Europe/Istanbul',
  };
  return generator.computeDayPlan(input);
}

describe('a weighing is authoritative for the feeding plan', () => {
  it("changes the NEXT day's plannedTotalKg", async () => {
    const unit = makeUnit();
    const before = planFor(unit)!;
    // Model: 800 kg × 3% (band "small") = 24 kg.
    expect(before.plannedTotalKg).toBeCloseTo(24);
    expect(before.snapshot.feed.id).toBe('feed-small');

    // The scale says 112 g, not the projected 80 g (the model was 40% low).
    const applier = new BiomassGrowthApplierService();
    const { manager } = makeManager(unit, [{ biomass: 1120, quantity: 10_000 }]);
    const locked = await applier.lockUnitForGrowth(manager, TENANT, UNIT);
    await applier.reconcileMeasuredWeight(manager, TENANT, locked!, 112, provenance);

    const after = planFor(unit)!;

    // THE ASSERTION: the ration moved because somebody weighed the fish.
    expect(after.plannedTotalKg).not.toBeCloseTo(before.plannedTotalKg);
    // 10 000 × 112 g = 1120 kg, now in the >100 g band at 2% → 22.4 kg.
    expect(after.snapshot.biomassKg).toBeCloseTo(1120);
    expect(after.snapshot.avgWeightG).toBeCloseTo(112);
    expect(after.plannedTotalKg).toBeCloseTo(22.4);
    // …and the measured weight crossed a band boundary, so the FEED changes too.
    expect(after.snapshot.feed.id).toBe('feed-large');
    expect(after.snapshot.expectedFcr).toBeCloseTo(1.3);
  });

  it('also moves the plan DOWN when the fish are lighter than the model claimed', async () => {
    const unit = makeUnit();
    const before = planFor(unit)!;

    const applier = new BiomassGrowthApplierService();
    const { manager } = makeManager(unit, [{ biomass: 500, quantity: 10_000 }]);
    const locked = await applier.lockUnitForGrowth(manager, TENANT, UNIT);
    // 50 g measured against 80 g projected — the tank was being overfed.
    await applier.reconcileMeasuredWeight(manager, TENANT, locked!, 50, provenance);

    const after = planFor(unit)!;
    expect(after.snapshot.biomassKg).toBeCloseTo(500);
    expect(after.plannedTotalKg).toBeCloseTo(15); // 500 kg × 3%
    expect(after.plannedTotalKg).toBeLessThan(before.plannedTotalKg);
  });

  it('leaves the plan untouched when the measurement confirms the projection', async () => {
    const unit = makeUnit();
    const before = planFor(unit)!;

    const applier = new BiomassGrowthApplierService();
    const { manager } = makeManager(unit, [{ biomass: 800, quantity: 10_000 }]);
    const locked = await applier.lockUnitForGrowth(manager, TENANT, UNIT);
    await applier.reconcileMeasuredWeight(manager, TENANT, locked!, 80, provenance);

    const after = planFor(unit)!;
    expect(after.plannedTotalKg).toBeCloseTo(before.plannedTotalKg);
    // The measurement is still RECORDED — provenance flips even at zero delta,
    // so "nobody has weighed this tank" stays distinguishable from "weighed,
    // and the model was right".
    expect(unit.weightProvenance).toMatchObject({
      source: 'measurement',
      projectionErrorPercent: 0,
    });
  });
});
