/**
 * ONE feed-transition mechanism — the 06:00 generator and the intra-day
 * recalculation share it.
 *
 * The defect this pins: the generator selected the band from WEIGHT ALONE. A
 * fish that crossed a band boundary overnight silently got a new feed in the
 * morning plan while `assignment.currentFeedId`/`currentBandIndex` still named
 * yesterday's feed, no `FeedTypeTransitioned` was published, and the first
 * intra-day recalculation then compared against that stale index and could
 * publish a SECOND, contradictory transition for a boundary already crossed.
 *
 * What is proved here:
 *  - crossing a boundary overnight produces exactly ONE transition, with
 *    hysteresis, ONE durable event, and a non-stale assignment afterwards;
 *  - the recalculation that follows the same day publishes NOTHING (the state it
 *    reads is now fresh) — the contradictory second transition is gone;
 *  - inside the buffer the generator HOLDS the band, exactly as the intra-day
 *    path does (one rule, not two);
 *  - a second generation run for the same day (ON CONFLICT DO NOTHING) applies
 *    no transition and publishes no second event.
 */
import { EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import {
  MealPlanGeneratorService,
  type ComputeDayPlanInput,
} from '../services/meal-plan-generator.service';
import { FeedTypeTransitionService } from '../services/feed-transition.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { ProtocolRateService, derivedBandWeightG } from '../services/protocol-rate.service';
import {
  FcrResolvedSource,
  ProtocolFcrSource,
  type FeedingProtocolV2,
} from '../entities/feeding-protocol-v2.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ASSIGNMENT = 'assign-1';

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
  defaultMealSchedule: {
    mealsPerDay: 2,
    entries: [
      { time: '08:00', percentOfDaily: 60 },
      { time: '16:00', percentOfDaily: 40 },
    ],
  },
  temperatureAdjustments: [],
  settings: {
    autoTransition: true,
    transitionBufferG: 5,
    growthApplicationMode: 'per_meal',
    underfeedAlertThresholdPercent: 15,
    fcrSource: ProtocolFcrSource.BAND,
  },
});

/** Yesterday's state: the unit is on band 0 / feed-a. */
function assignmentOnBandZero(): ProtocolAssignment {
  return mock<ProtocolAssignment>({
    id: ASSIGNMENT,
    tenantId: TENANT,
    unitId: UNIT,
    unitCode: 'T-01',
    protocolId: 'protocol-1',
    status: ProtocolAssignmentStatus.ACTIVE,
    currentFeedId: 'feed-a',
    currentBandIndex: 0,
    totalTransitions: 0,
    overrides: {},
    suspensions: [],
  });
}

interface GeneratorHarness {
  generator: MealPlanGeneratorService;
  manager: EntityManager;
  enqueued: Array<{ eventType: string; [key: string]: unknown }>;
  insertedMeals: Array<Record<string, unknown>>;
}

function generatorHarness(
  assignment: ProtocolAssignment,
  opts: { planAlreadyExists?: boolean } = {},
): GeneratorHarness {
  const enqueued: Array<{ eventType: string; [key: string]: unknown }> = [];
  const insertedMeals: Array<Record<string, unknown>> = [];
  const outbox = mock<OutboxPublisher>({
    enqueue: jest.fn(async (event: { eventType: string }) => {
      enqueued.push(event);
      return undefined as never;
    }),
  });
  // Untyped jest.fn() doubles (repo spec idiom): EntityManager's overloads are
  // generic, so an inline typed lambda cannot satisfy them.
  const query = jest.fn();
  // ON CONFLICT DO NOTHING → no row when the plan already exists.
  query.mockImplementation(async () => (opts.planAlreadyExists ? [] : [{ id: 'plan-1' }]));
  const insert = jest.fn();
  insert.mockImplementation(async (_entity: unknown, values: Record<string, unknown>) => {
    insertedMeals.push(values);
  });
  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown) =>
    entity === ProtocolAssignment ? assignment : null,
  );
  const save = jest.fn();
  save.mockImplementation(async (entity: unknown) => entity);
  const manager = mock<EntityManager>({ query, insert, findOne, save });
  const rateService = new ProtocolRateService();
  const generator = new MealPlanGeneratorService(
    rateService,
    new FeedTypeTransitionService(rateService, outbox),
  );
  return { generator, manager, enqueued, insertedMeals };
}

function planInput(assignment: ProtocolAssignment, avgWeightG: number): ComputeDayPlanInput {
  const fishCount = 1000;
  return {
    assignment,
    protocol: PROTOCOL,
    stock: {
      fishCount,
      biomassKg: (fishCount * avgWeightG) / 1000,
      avgWeightG: derivedBandWeightG((fishCount * avgWeightG) / 1000, fishCount),
    },
    temperature: { celsius: null, source: 'none' },
    planDate: '2026-08-08',
    timezone: 'Europe/Istanbul',
  };
}

const PERSIST_CONTEXT = {
  tenantId: TENANT,
  assignmentId: ASSIGNMENT,
  protocolId: 'protocol-1',
  unitId: UNIT,
  siteId: 'site-1',
  unitType: 'tank' as ProtocolAssignment['unitType'],
  unitName: 'Tank 01',
  unitCode: 'T-01',
  planDate: '2026-08-08',
};

describe('06:00 generation crosses a band boundary', () => {
  it('produces ONE transition with hysteresis, ONE event, and leaves the assignment fresh', async () => {
    const assignment = assignmentOnBandZero();
    const harness = generatorHarness(assignment);

    // Overnight the unit grew past 100 g + 5 g buffer.
    const computed = harness.generator.computeDayPlan(planInput(assignment, 110));
    expect(computed).not.toBeNull();
    // The plan itself feeds the NEW band…
    expect(computed!.snapshot.bandIndex).toBe(1);
    expect(computed!.snapshot.feed.id).toBe('feed-b');
    expect(computed!.meals.every((meal) => meal.feedId === 'feed-b')).toBe(true);
    // …and carries the state change it owes the assignment.
    expect(computed!.bandStateChange).toMatchObject({
      fromFeedId: 'feed-a',
      toFeedId: 'feed-b',
      toBandIndex: 1,
      feedChanged: true,
    });

    const dayPlanId = await harness.generator.persistDayPlan(
      harness.manager,
      PERSIST_CONTEXT,
      computed!,
    );

    expect(dayPlanId).toBe('plan-1');
    // The assignment is no longer stale — it names the feed the plan feeds.
    expect(assignment.currentFeedId).toBe('feed-b');
    expect(assignment.currentBandIndex).toBe(1);
    expect(assignment.totalTransitions).toBe(1);
    expect(assignment.lastTransitionAt).toBeInstanceOf(Date);
    // Exactly one durable transition.
    const transitions = harness.enqueued.filter(
      (event) => event.eventType === 'FeedTypeTransitioned',
    );
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      unitId: UNIT,
      fromFeedId: 'feed-a',
      toFeedId: 'feed-b',
      toFeedCode: 'FB',
      bandIndex: 1,
      automatic: true,
    });
  });

  it('HOLDS the band inside the hysteresis buffer — the same rule the intra-day path uses', async () => {
    const assignment = assignmentOnBandZero();
    const harness = generatorHarness(assignment);

    // 102 g: past the boundary but not past boundary + buffer (105 g).
    const computed = harness.generator.computeDayPlan(planInput(assignment, 102));

    expect(computed!.snapshot.bandIndex).toBe(0);
    expect(computed!.snapshot.feed.id).toBe('feed-a');
    expect(computed!.bandStateChange).toBeNull();

    await harness.generator.persistDayPlan(harness.manager, PERSIST_CONTEXT, computed!);

    expect(assignment.currentFeedId).toBe('feed-a');
    expect(assignment.totalTransitions).toBe(0);
    expect(harness.enqueued).toHaveLength(0);
  });

  it('a second generation run for the same day applies no transition and publishes no second event', async () => {
    const assignment = assignmentOnBandZero();
    const harness = generatorHarness(assignment, { planAlreadyExists: true });

    const computed = harness.generator.computeDayPlan(planInput(assignment, 110));
    const dayPlanId = await harness.generator.persistDayPlan(
      harness.manager,
      PERSIST_CONTEXT,
      computed!,
    );

    expect(dayPlanId).toBeNull(); // ON CONFLICT DO NOTHING
    expect(assignment.currentFeedId).toBe('feed-a'); // untouched by the losing run
    expect(harness.enqueued).toHaveLength(0);
  });

  it('the intra-day recalculation after the morning transition publishes NOTHING (no contradictory second transition)', async () => {
    // Play the whole morning: generate (transition applied), then let a mortality
    // trigger the intra-day recalculation with the same assignment row.
    const assignment = assignmentOnBandZero();
    const generation = generatorHarness(assignment);
    const computed = generation.generator.computeDayPlan(planInput(assignment, 110));
    await generation.generator.persistDayPlan(generation.manager, PERSIST_CONTEXT, computed!);
    expect(assignment.currentBandIndex).toBe(1);

    const recalcEnqueued: Array<{ eventType: string }> = [];
    const outbox = mock<OutboxPublisher>({
      enqueue: jest.fn(async (event: { eventType: string }) => {
        recalcEnqueued.push(event);
        return undefined as never;
      }),
    });
    const dayPlan = mock<FeedingDayPlan>({
      id: 'plan-1',
      tenantId: TENANT,
      assignmentId: ASSIGNMENT,
      protocolId: 'protocol-1',
      unitId: UNIT,
      unitCode: 'T-01',
      planDate: '2026-08-08',
      status: FeedingDayPlanStatus.IN_PROGRESS,
      plannedTotalKg: computed!.plannedTotalKg,
      rationBasisKg: computed!.rationBasisKg,
      recalcLog: [],
      snapshot: computed!.snapshot,
    });
    const meals = [
      mock<FeedingMeal>({
        id: 'meal-1',
        mealIndex: 1,
        dayPlanId: 'plan-1',
        percentOfDaily: 40,
        plannedKg: 0.88,
        status: FeedingMealStatus.SCHEDULED,
        feedId: 'feed-b',
      }),
    ];
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
        getMany: async () => (call === 2 ? meals : []),
      };
      return chain;
    });
    const recalcFindOne = jest.fn();
    recalcFindOne.mockImplementation(async (entity: unknown) => {
      if (entity === TankBatch) {
        return mock<TankBatch>({
          tankId: UNIT,
          totalQuantity: 950,
          totalBiomassKg: 104.5,
          avgWeightG: 110,
        });
      }
      if (entity === ProtocolAssignment) return assignment;
      return PROTOCOL;
    });
    const recalcSave = jest.fn();
    recalcSave.mockImplementation(async (entity: unknown) => entity);
    const recalcManager = mock<EntityManager>({
      createQueryBuilder,
      findOne: recalcFindOne,
      save: recalcSave,
    });
    const rateService = new ProtocolRateService();
    const recalc = new DayPlanRecalcService(
      rateService,
      new FeedTypeTransitionService(rateService, outbox),
      outbox,
    );

    const result = await recalc.recalcForUnit(recalcManager, TENANT, UNIT, {
      reason: 'mortality',
      stockBiomassDeltaKg: -5.5,
    });

    expect(result?.transitioned).toBe(false);
    expect(recalcEnqueued).toHaveLength(0);
    expect(assignment.totalTransitions).toBe(1); // still the ONE morning transition
  });
});

describe('an assignment with no band memory', () => {
  it('adopts the weight-resolved band WITHOUT publishing a transition (nothing was replaced)', async () => {
    const assignment = mock<ProtocolAssignment>({
      id: ASSIGNMENT,
      tenantId: TENANT,
      unitId: UNIT,
      unitCode: 'T-01',
      protocolId: 'protocol-1',
      status: ProtocolAssignmentStatus.ACTIVE,
      totalTransitions: 0,
      overrides: {},
      suspensions: [],
    });
    const harness = generatorHarness(assignment);

    const computed = harness.generator.computeDayPlan(planInput(assignment, 110));
    await harness.generator.persistDayPlan(harness.manager, PERSIST_CONTEXT, computed!);

    expect(assignment.currentFeedId).toBe('feed-b');
    expect(assignment.currentBandIndex).toBe(1);
    expect(assignment.totalTransitions).toBe(0);
    expect(harness.enqueued).toHaveLength(0);
    expect(computed!.snapshot.fcrResolvedSource).toBe(FcrResolvedSource.BAND);
  });
});
