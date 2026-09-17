/**
 * DayPlanRecalcService (Faz 5 — P-31 gün içi recalc + histerezisli geçiş).
 *
 * Pinler: boş ünite kalan öğünleri iptal eder, planı kapatır, atamayı
 * otomatik pause eder (+unit_emptied event'i); kalan öğünler KENDİ
 * yüzdeleriyle yeni günlük toplamdan fiyatlanır ve recalcLog gerekçe taşır;
 * band sınırı buffer içinde geçilirse geçiş YAPILMAZ (salınım imkânsız),
 * buffer aşılırsa assignment + kalan öğün yemleri güncellenir ve
 * FeedTypeTransitioned yazılır; sıcaklık gerekçesi yeni okumayı kullanır.
 */
import { EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { FeedTypeTransitionService } from '../services/feed-transition.service';
import { ProtocolRateService } from '../services/protocol-rate.service';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import {
  FeedingProtocolV2,
  ProtocolFcrSource,
  FcrResolvedSource,
} from '../entities/feeding-protocol-v2.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

const PROTOCOL = mock<FeedingProtocolV2>({
  id: 'protocol-1',
  bands: [
    {
      minWeightG: 0,
      maxWeightG: 100,
      feedId: 'feed-a',
      feedCode: 'FA',
      feedName: 'Feed A',
      feedingRatePercent: 3,
      expectedFcr: 1.2,
    },
    {
      minWeightG: 100,
      maxWeightG: 500,
      feedId: 'feed-b',
      feedCode: 'FB',
      feedName: 'Feed B',
      feedingRatePercent: 2,
      expectedFcr: 1.4,
    },
  ],
  defaultMealSchedule: { mealsPerDay: 2, entries: [] },
  temperatureAdjustments: [{ minC: 5, maxC: 12, rateMultiplier: 0.5 }],
  settings: {
    autoTransition: true,
    transitionBufferG: 5,
    growthApplicationMode: 'per_meal',
    underfeedAlertThresholdPercent: 15,
    fcrSource: ProtocolFcrSource.BAND,
  },
});

interface HarnessOpts {
  dayPlan?: FeedingDayPlan | null;
  meals?: FeedingMeal[];
  settledMeals?: FeedingMeal[];
  tankBatch?: Partial<TankBatch> | null;
  assignment?: Partial<ProtocolAssignment>;
}

function makeDayPlan(over: Partial<FeedingDayPlan> = {}): FeedingDayPlan {
  return mock<FeedingDayPlan>({
    id: 'plan-1',
    tenantId: TENANT,
    assignmentId: 'assign-1',
    protocolId: 'protocol-1',
    unitId: UNIT,
    unitCode: 'T-01',
    planDate: '2026-07-20',
    plannedTotalKg: 1.5,
    // Tayın tabanı = üretim anındaki biyokütle (generator bunu yazar).
    rationBasisKg: 50,
    recalcLog: [],
    status: FeedingDayPlanStatus.PLANNED,
    snapshot: {
      avgWeightG: 50,
      fishCount: 1000,
      biomassKg: 50,
      waterTempC: null,
      temperatureSource: 'none',
      usingDefaultTemperature: true,
      bandIndex: 0,
      feed: { id: 'feed-a', code: 'FA', name: 'Feed A' },
      baseRatePercent: 3,
      tempMultiplier: 1,
      effectiveRatePercent: 3,
      expectedFcr: 1.2,
      fcrResolvedSource: FcrResolvedSource.BAND,
    },
    ...over,
  });
}

function makeMeal(index: number, plannedKg: number, percent: number): FeedingMeal {
  return mock<FeedingMeal>({
    id: `meal-${index}`,
    mealIndex: index,
    dayPlanId: 'plan-1',
    percentOfDaily: percent,
    plannedKg,
    status: FeedingMealStatus.SCHEDULED,
    feedId: 'feed-a',
  });
}

function makeHarness(opts: HarnessOpts = {}) {
  const dayPlan = opts.dayPlan === undefined ? makeDayPlan() : opts.dayPlan;
  const meals = opts.meals ?? [makeMeal(0, 0.9, 60), makeMeal(1, 0.6, 40)];
  const settled = opts.settledMeals ?? [];
  const tankBatch =
    opts.tankBatch === null
      ? null
      : mock<TankBatch>({
          tankId: UNIT,
          totalQuantity: 1000,
          totalBiomassKg: 50,
          avgWeightG: 50,
          ...opts.tankBatch,
        });
  const assignment = mock<ProtocolAssignment>({
    id: 'assign-1',
    protocolId: 'protocol-1',
    status: ProtocolAssignmentStatus.ACTIVE,
    unitCode: 'T-01',
    currentFeedId: 'feed-a',
    currentBandIndex: 0,
    totalTransitions: 0,
    overrides: {},
    ...opts.assignment,
  });

  const saved: unknown[] = [];
  const enqueued: Array<{ eventType: string }> = [];

  // Chainable query-builder double: setLock/where/andWhere/orderBy passthrough.
  let qbCall = 0;
  const createQueryBuilder = jest.fn();
  createQueryBuilder.mockImplementation(() => {
    qbCall += 1;
    const call = qbCall;
    const chain = {
      setLock: () => chain,
      where: () => chain,
      andWhere: () => chain,
      orderBy: () => chain,
      getOne: async () => (call === 1 ? dayPlan : null),
      getMany: async () => (call === 2 ? meals : settled),
    };
    return chain;
  });

  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown) => {
    if (entity === TankBatch) return tankBatch;
    if (entity === ProtocolAssignment) return assignment;
    if (entity === FeedingProtocolV2) return PROTOCOL;
    return null;
  });
  const save = jest.fn();
  save.mockImplementation(async (entity: unknown) => {
    saved.push(entity);
    return entity;
  });

  const manager = mock<EntityManager>({ createQueryBuilder, findOne, save });
  const outbox = mock<OutboxPublisher>({
    enqueue: jest.fn(async (event: { eventType: string }) => {
      enqueued.push(event);
      return undefined as never;
    }),
  });
  const rateService = new ProtocolRateService();
  const service = new DayPlanRecalcService(
    rateService,
    new FeedTypeTransitionService(rateService, outbox),
    outbox,
  );
  return { service, manager, dayPlan, meals, assignment, saved, enqueued };
}

describe('DayPlanRecalcService.recalcForUnit', () => {
  it('cancels remaining meals, closes the plan and auto-pauses the assignment on an empty unit', async () => {
    const harness = makeHarness({ tankBatch: { totalQuantity: 0, totalBiomassKg: 0 } });
    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, {
      reason: 'harvest',
      stockBiomassDeltaKg: -50,
    });

    expect(result?.outcome).toBe('cancelled_empty_unit');
    expect(harness.meals.every((meal) => meal.status === FeedingMealStatus.CANCELLED)).toBe(true);
    expect(harness.dayPlan!.status).toBe(FeedingDayPlanStatus.CANCELLED);
    expect(harness.assignment.status).toBe(ProtocolAssignmentStatus.PAUSED);
    expect(harness.enqueued.map((event) => event.eventType)).toContain(
      'FeedingProtocolAssignmentPaused',
    );
  });

  it('reprices remaining meals from the new daily total with their OWN percents and logs the reason', async () => {
    // Ölüm sonrası biomass 50→40kg: yeni günlük %3 × 40 = 1.2kg → 0.72 / 0.48
    const harness = makeHarness({ tankBatch: { totalBiomassKg: 40, avgWeightG: 50 } });
    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, {
      reason: 'mortality',
      stockBiomassDeltaKg: -10,
    });

    expect(result?.outcome).toBe('repriced');
    expect(harness.meals[0]!.plannedKg).toBeCloseTo(0.72);
    expect(harness.meals[1]!.plannedKg).toBeCloseTo(0.48);
    expect(harness.dayPlan!.plannedTotalKg).toBeCloseTo(1.2);
    expect(harness.dayPlan!.recalcLog.at(-1)?.reason).toBe('mortality');
  });

  it('holds the current band inside the hysteresis buffer (no oscillation)', async () => {
    // 102g: yeni band min 100 + buffer 5 = 105 AŞILMADI → band 0 korunur.
    const harness = makeHarness({
      tankBatch: { avgWeightG: 102, totalBiomassKg: 102 },
      dayPlan: makeDayPlan({ rationBasisKg: 102 }),
    });
    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, { reason: 'grading' });

    expect(result?.transitioned).toBe(false);
    expect(harness.assignment.currentFeedId).toBe('feed-a');
    expect(harness.meals.every((meal) => meal.feedId === 'feed-a')).toBe(true);
  });

  it('transitions feed beyond the buffer: assignment + remaining meals + durable event (P-12)', async () => {
    const harness = makeHarness({
      tankBatch: { avgWeightG: 110, totalBiomassKg: 110 },
      dayPlan: makeDayPlan({ rationBasisKg: 110 }),
    });
    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, { reason: 'grading' });

    expect(result?.transitioned).toBe(true);
    expect(harness.assignment.currentFeedId).toBe('feed-b');
    expect(harness.assignment.currentBandIndex).toBe(1);
    expect(harness.assignment.totalTransitions).toBe(1);
    expect(harness.meals.every((meal) => meal.feedId === 'feed-b')).toBe(true);
    expect(harness.enqueued.map((event) => event.eventType)).toContain('FeedTypeTransitioned');
    // Yeni band oranı %2: 110kg × 2% = 2.2 → 1.32 / 0.88
    expect(harness.meals[0]!.plannedKg).toBeCloseTo(1.32);
  });

  it('uses the fresh reading for temperature-triggered recalcs', async () => {
    const harness = makeHarness({});
    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, {
      reason: 'temperature',
      newTemperatureC: 8, // 5–12°C bandı → ×0.5
    });
    expect(result?.outcome).toBe('repriced');
    // 50kg × 3% × 0.5 = 0.75 → 0.45 / 0.30
    expect(harness.meals[0]!.plannedKg).toBeCloseTo(0.45);
    expect(harness.meals[1]!.plannedKg).toBeCloseTo(0.3);
  });

  // ==========================================================================
  // RATION BASIS — the day's ration follows FISH, never the day's own feed
  // ==========================================================================

  it('a growth application does NOT enlarge the same day\'s remaining ration', async () => {
    // per_meal mode: finalising the morning meal wrote FCR growth into the
    // unit's biomass (50 → 55 kg) and then asked for a recalculation. The old
    // code repriced from 55 kg, so the morning meal enlarged the noon meal,
    // which enlarged the evening meal — the day's total drifting above the
    // prescribed rate once per meal, every day.
    const harness = makeHarness({ tankBatch: { totalBiomassKg: 55, avgWeightG: 55 } });
    const before = harness.meals.map((meal) => meal.plannedKg);

    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, {
      reason: 'meal_growth',
    });

    expect(result?.outcome).toBe('repriced');
    expect(harness.meals.map((meal) => meal.plannedKg)).toEqual(before);
    expect(result?.rationBasisKg).toBe(50); // start-of-day biomass, untouched
    expect(harness.dayPlan!.plannedTotalKg).toBeCloseTo(1.5);
  });

  it('an unplanned feed does not enlarge the remaining ration either (same growth path)', async () => {
    const harness = makeHarness({ tankBatch: { totalBiomassKg: 58, avgWeightG: 58 } });
    const before = harness.meals.map((meal) => meal.plannedKg);

    await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, {
      reason: 'unplanned_feed',
    });

    expect(harness.meals.map((meal) => meal.plannedKg)).toEqual(before);
  });

  it('stocking a unit RAISES the day\'s remaining meals (the allocation gap)', async () => {
    // +500 fish at 50 g = +25 kg. Basis 50 → 75 kg; %3 → 2.25 kg/day.
    const harness = makeHarness({ tankBatch: { totalQuantity: 1500, totalBiomassKg: 75, avgWeightG: 50 } });

    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, {
      reason: 'allocation',
      stockBiomassDeltaKg: 25,
    });

    expect(result?.rationBasisKg).toBe(75);
    expect(harness.meals[0]!.plannedKg).toBeCloseTo(1.35); // %60
    expect(harness.meals[1]!.plannedKg).toBeCloseTo(0.9); // %40
    expect(harness.dayPlan!.recalcLog.at(-1)?.reason).toBe('allocation');
  });

  it('a weighing RE-BASELINES the day onto the measured biomass (evidence beats the model)', async () => {
    const harness = makeHarness({ tankBatch: { totalBiomassKg: 60, avgWeightG: 60 } });

    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, {
      reason: 'growth_sample',
    });

    expect(result?.rationBasisKg).toBe(60);
    expect(harness.dayPlan!.plannedTotalKg).toBeCloseTo(1.8); // 60 × %3
  });

  it('returns null when the unit has no active day plan (nothing to recalc)', async () => {
    const harness = makeHarness({ dayPlan: null });
    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, {
      reason: 'mortality',
      stockBiomassDeltaKg: -10,
    });
    expect(result).toBeNull();
  });
});
