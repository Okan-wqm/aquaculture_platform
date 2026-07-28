/**
 * Day-plan persistence against a REAL PostgreSQL (W0/W1).
 *
 * ## Why a real database
 *
 * `MealPlanGeneratorService.persistDayPlan` writes through a hand-written
 * 22-column `INSERT`, and raw SQL is the one place TypeORM offers no
 * protection: it does not check column names, it does not check that a named
 * enum type exists, and it does not check that the `ON CONFLICT` target matches
 * a real unique index. Every one of those is a runtime 42xxx error and every one
 * is invisible to a mocked EntityManager, which happily records the call and
 * returns whatever the test told it to.
 *
 * That gap has already produced two defects in this table's neighbourhood:
 *
 *   - FARM-CRITICAL-306: `feeding_day_plans.unitType` reuses the enum TYPE that
 *     `feeding_protocol_assignments` owns. Without an explicit `enumName:`,
 *     TypeORM derived a per-table name, so the type this INSERT casts to
 *     (`$6::feeding_protocol_assignments_unittype_enum`) and the type the column
 *     actually had were two different objects.
 *   - FARM-CRITICAL-242 / FARM-HIGH-300, in the sibling storage path: a quoted
 *     camelCase identifier and a case-mismatched enum literal, both silent under
 *     doubles.
 *
 * The static gate (`raw-sql-entity-backed.spec.ts`) reads these INSERT column
 * lists and checks them against entity metadata, which catches a misspelled
 * column. It cannot execute a cast or a conflict target. This suite does.
 *
 * ## Scope
 *
 * Persistence only. The arithmetic that produces a `ComputedDayPlan` is pure and
 * covered by unit specs; duplicating it here would just make a slow test of a
 * fast one. What is asserted is that the row Postgres accepts is the row the
 * caller described, and that a second identical generation is a no-op rather
 * than a duplicate or a crash — the property the 06:00 cron's at-least-once
 * retry depends on.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import { bootPostgresContainer, HarnessContext, shutdownHarness } from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import {
  FeedingDayPlan,
  FeedingDayPlanStatus,
  DayPlanResolution,
  DayPlanSnapshot,
} from '../../feeding-protocol/entities/feeding-day-plan.entity';
import { FcrResolvedSource } from '../../feeding-protocol/entities/feeding-protocol-v2.entity';
import { FeedingMeal, FeedingMealStatus } from '../../feeding-protocol/entities/feeding-meal.entity';
import {
  FeedingUnitType,
  ProtocolAssignment,
} from '../../feeding-protocol/entities/protocol-assignment.entity';
import {
  ComputedDayPlan,
  MealPlanGeneratorService,
  PersistDayPlanContext,
} from '../../feeding-protocol/services/meal-plan-generator.service';

jest.setTimeout(120_000);

const TENANT = '11111111-1111-4111-8111-111111111111';
const ASSIGNMENT = '22222222-2222-4222-8222-222222222222';
const PROTOCOL = '33333333-3333-4333-8333-333333333333';
const UNIT = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555';
const FEED = '66666666-6666-4666-8666-666666666666';

const PLAN_DATE = '2026-06-15';

const SNAPSHOT: DayPlanSnapshot = {
  avgWeightG: 120,
  fishCount: 1000,
  biomassKg: 120,
  waterTempC: 14.5,
  temperatureSource: 'sensor',
  usingDefaultTemperature: false,
  bandIndex: 1,
  feed: { id: FEED, code: 'F-2MM', name: 'Grower 2mm' },
  baseRatePercent: 1.5,
  tempMultiplier: 1,
  effectiveRatePercent: 1.5,
  expectedFcr: 1.2,
  fcrResolvedSource: FcrResolvedSource.BAND,
  mixedBatch: false,
  weightCvPercent: null,
};

const RESOLUTION: DayPlanResolution = {
  resolvedAt: '2026-06-15T06:00:00.000Z',
  bandIndex: 1,
  feed: { id: FEED, code: 'F-2MM', name: 'Grower 2mm' },
  baseRatePercent: 1.5,
  tempMultiplier: 1,
  effectiveRatePercent: 1.5,
  expectedFcr: 1.2,
  fcrResolvedSource: FcrResolvedSource.BAND,
  bandBasisWeightG: 120,
  waterTempC: 14.5,
  temperatureSource: 'sensor',
};

const CONTEXT: PersistDayPlanContext = {
  tenantId: TENANT,
  assignmentId: ASSIGNMENT,
  protocolId: PROTOCOL,
  unitId: UNIT,
  siteId: SITE,
  unitType: FeedingUnitType.TANK,
  unitName: 'Tank 1',
  unitCode: 'T-01',
  planDate: PLAN_DATE,
  growthApplicationMode: 'per_meal',
};

/** 1000 fish × 120 g × 1.5 % = 1.8 kg/day, split 40/60 across two meals. */
const COMPUTED: ComputedDayPlan = {
  snapshot: SNAPSHOT,
  resolution: RESOLUTION,
  plannedTotalKg: 1.8,
  status: FeedingDayPlanStatus.PLANNED,
  meals: [
    {
      mealIndex: 0,
      scheduledAt: new Date('2026-06-15T05:00:00.000Z'),
      percentOfDaily: 40,
      plannedKg: 0.72,
      feedId: FEED,
    },
    {
      mealIndex: 1,
      scheduledAt: new Date('2026-06-15T13:00:00.000Z'),
      percentOfDaily: 60,
      plannedKg: 1.08,
      feedId: FEED,
    },
  ],
};

describe('MealPlanGeneratorService.persistDayPlan — real Postgres', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  // computeDayPlan is not exercised here, so the pure collaborators it needs are
  // irrelevant to this suite's surface — persistDayPlan touches neither.
  const service = new MealPlanGeneratorService(null as never, null as never);

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-day-plan-generation-${randomBytes(4).toString('hex')}`,
      // ProtocolAssignment is registered because it OWNS the shared unit-type
      // enum the day-plan INSERT casts to. Dropping it from this list would
      // leave the type uncreated and the cast unresolvable — which is precisely
      // the coupling FARM-CRITICAL-306 was.
      entities: [ProtocolAssignment, FeedingDayPlan, FeedingMeal],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  beforeEach(async () => {
    await dataSource.manager.clear(FeedingMeal);
    await dataSource.manager.clear(FeedingDayPlan);
  });

  it('writes the plan the caller described, through the raw 22-column INSERT', async () => {
    const dayPlanId = await service.persistDayPlan(dataSource.manager, CONTEXT, COMPUTED);

    expect(dayPlanId).not.toBeNull();

    const saved = await dataSource.manager.findOneOrFail(FeedingDayPlan, {
      where: { id: dayPlanId as string },
    });

    // Identity + denormalised display columns.
    expect(saved.tenantId).toBe(TENANT);
    expect(saved.assignmentId).toBe(ASSIGNMENT);
    expect(saved.protocolId).toBe(PROTOCOL);
    expect(saved.unitId).toBe(UNIT);
    expect(saved.siteId).toBe(SITE);
    // The enum cast under test: a mismatch between the cast target and the
    // column's real type raises 42704/42804 rather than returning a wrong value.
    expect(saved.unitType).toBe(FeedingUnitType.TANK);
    expect(saved.unitName).toBe('Tank 1');
    expect(saved.unitCode).toBe('T-01');
    expect(saved.planDate).toBe(PLAN_DATE);

    // Numerics and the second enum cast.
    expect(Number(saved.plannedTotalKg)).toBe(1.8);
    expect(Number(saved.unplannedActualKg)).toBe(0);
    expect(saved.mealsPlanned).toBe(2);
    expect(saved.status).toBe(FeedingDayPlanStatus.PLANNED);

    // jsonb round-trips, including the null the snapshot is allowed to carry.
    expect(saved.snapshot).toEqual(SNAPSHOT);
    expect(saved.resolution).toEqual(RESOLUTION);
    expect(saved.recalcLog).toEqual([]);

    // Growth accounting starts at zero and the mode is frozen at generation
    // time (FARM-CRITICAL-244) — rollup reads the plan, not the live protocol.
    expect(saved.growthApplicationMode).toBe('per_meal');
    expect(Number(saved.rollupAppliedKg)).toBe(0);
    expect(Number(saved.rollupGrowthKg)).toBe(0);
    expect(saved.version).toBe(1);
  });

  it('writes one meal row per computed meal', async () => {
    const dayPlanId = await service.persistDayPlan(dataSource.manager, CONTEXT, COMPUTED);

    const meals = await dataSource.manager.find(FeedingMeal, {
      where: { dayPlanId: dayPlanId as string },
      order: { mealIndex: 'ASC' },
    });

    expect(meals).toHaveLength(2);
    expect(meals.map((meal) => meal.mealIndex)).toEqual([0, 1]);
    expect(meals.map((meal) => Number(meal.percentOfDaily))).toEqual([40, 60]);
    expect(meals.map((meal) => Number(meal.plannedKg))).toEqual([0.72, 1.08]);
    // Meals denormalise unit + site so the meal board and the 15-minute window
    // cron read them from their own indexes rather than joining the plan.
    expect(meals.every((meal) => meal.tenantId === TENANT)).toBe(true);
    expect(meals.every((meal) => meal.unitId === UNIT)).toBe(true);
    expect(meals.every((meal) => meal.siteId === SITE)).toBe(true);
    expect(meals.every((meal) => meal.status === FeedingMealStatus.SCHEDULED)).toBe(true);
    expect(meals.every((meal) => Number(meal.actualKg) === 0)).toBe(true);
    expect(meals.every((meal) => meal.feedId === FEED)).toBe(true);

    // Σ meal.plannedKg == plannedTotalKg — the invariant the day-plan status
    // settlement and the variance report both assume.
    const total = meals.reduce((sum, meal) => sum + Number(meal.plannedKg), 0);
    expect(Number(total.toFixed(3))).toBe(1.8);
  });

  it('is idempotent: a re-run for the same unit and date writes nothing new', async () => {
    // The 06:00 cron is at-least-once. A second pass must resolve through the
    // ON CONFLICT target — which only works if that target names a real unique
    // index. A missing index makes this a duplicate row, not an error.
    const first = await service.persistDayPlan(dataSource.manager, CONTEXT, COMPUTED);
    const second = await service.persistDayPlan(dataSource.manager, CONTEXT, COMPUTED);

    expect(first).not.toBeNull();
    // `null` is how the caller learns it did not win the race, so it can skip
    // meal generation instead of duplicating it.
    expect(second).toBeNull();

    expect(await dataSource.manager.count(FeedingDayPlan, { where: { tenantId: TENANT } })).toBe(1);
    expect(await dataSource.manager.count(FeedingMeal, { where: { tenantId: TENANT } })).toBe(2);
  });

  it('keeps plans for other dates and other units side by side', async () => {
    await service.persistDayPlan(dataSource.manager, CONTEXT, COMPUTED);
    const nextDay = await service.persistDayPlan(
      dataSource.manager,
      { ...CONTEXT, planDate: '2026-06-16' },
      COMPUTED,
    );
    const otherUnit = await service.persistDayPlan(
      dataSource.manager,
      { ...CONTEXT, unitId: '77777777-7777-4777-8777-777777777777', unitCode: 'T-02' },
      COMPUTED,
    );

    expect(nextDay).not.toBeNull();
    expect(otherUnit).not.toBeNull();
    expect(await dataSource.manager.count(FeedingDayPlan, { where: { tenantId: TENANT } })).toBe(3);
  });

  it('persists a skipped plan with its reason (fasting and medication windows)', async () => {
    // A suspension window produces a SKIPPED plan rather than no plan at all,
    // so the unit is visibly accounted for instead of looking unplanned.
    const dayPlanId = await service.persistDayPlan(dataSource.manager, CONTEXT, {
      ...COMPUTED,
      status: FeedingDayPlanStatus.SKIPPED,
      skipReason: 'fasting',
      plannedTotalKg: 0,
      meals: [],
    });

    const saved = await dataSource.manager.findOneOrFail(FeedingDayPlan, {
      where: { id: dayPlanId as string },
    });

    expect(saved.status).toBe(FeedingDayPlanStatus.SKIPPED);
    expect(saved.skipReason).toBe('fasting');
    expect(saved.mealsPlanned).toBe(0);
    expect(await dataSource.manager.count(FeedingMeal, { where: { tenantId: TENANT } })).toBe(0);
  });
});
