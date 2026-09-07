/**
 * DAILY growth rollup as CUMULATIVE RECONCILIATION, against a real PostgreSQL
 * (W1 / FARM-CRITICAL-238).
 *
 * ## The decision being pinned
 *
 * The rollup used to ask "has this plan been stamped yet?" and stamp it once.
 * That question is wrong in both directions, and both were reachable:
 *
 *   - a meal finalized after the sweep, or a `correctMealPour` adjustment, landed
 *     on an already-stamped plan and its growth was lost forever;
 *   - flipping the protocol's growth mode re-qualified historical plans, so up to
 *     24 months of feed could be counted a second time.
 *
 * W1 replaced it with reconciliation: the plan records HOW MUCH has been applied
 * (`rollupAppliedKg`), the candidate predicate is `rollupAppliedKg <> Σ actual`,
 * and each run converts only the difference. The mode is read from the plan's own
 * frozen column rather than from the protocol's current setting, so changing the
 * setting cannot reach into history.
 *
 * ## Why this needs a real database
 *
 * The candidate query is hand-written SQL carrying a CROSS JOIN LATERAL over
 * meals, a `resolution->>'expectedFcr'` jsonb extraction cast to numeric, a
 * `($3 || ' days')::interval` window and a `$2::date` local-day bound. None of
 * that is exercised by a mocked EntityManager, which returns whatever the test
 * hands it — the query could select the wrong rows, or not parse at all, and a
 * doubled suite would still be green. The arithmetic itself is pure and already
 * unit-tested through `computeRollupDelta`; what is unproven without Postgres is
 * that the right plans reach it and that the stamp lands where it should.
 *
 * Meals are seeded FED on purpose: the morning sweep's earlier legs select only
 * SCHEDULED and PARTIALLY_FED meals, so a fully-fed plan walks straight into the
 * rollup leg. That keeps a failure here naming the rollup rather than the sweep.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import { createTenantConnectionBootstrap, getTenantSchemaName } from '@aquaculture/backend-common';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { collaborator } from '@aquaculture/testing';
import { DataSource } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { TankAllocation } from '../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankOperation } from '../../batch/entities/tank-operation.entity';
import { Department } from '../../department/entities/department.entity';
import {
  FeedingDayPlan,
  FeedingDayPlanStatus,
  DayPlanResolution,
  DayPlanSnapshot,
} from '../../feeding-protocol/entities/feeding-day-plan.entity';
import {
  FeedingMeal,
  FeedingMealStatus,
} from '../../feeding-protocol/entities/feeding-meal.entity';
import {
  FeedingProtocolV2,
  FcrResolvedSource,
} from '../../feeding-protocol/entities/feeding-protocol-v2.entity';
import {
  FeedingUnitType,
  ProtocolAssignment,
} from '../../feeding-protocol/entities/protocol-assignment.entity';
import { BiomassGrowthApplierService } from '../../feeding-protocol/services/biomass-growth-applier.service';
import { realFinalizationService } from '../../feeding-protocol/__tests__/helpers/meal-finalization-double';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import {
  FeedingClock,
  FeedingClockService,
} from '../../feeding-protocol/services/feeding-clock.service';
import { FeedingCronV2Service } from '../../feeding-protocol/services/feeding-cron-v2.service';
import { FeedingJobRunService } from '../../feeding-protocol/services/feeding-job-run.service';
import { MealPlanGeneratorService } from '../../feeding-protocol/services/meal-plan-generator.service';
import { ProtocolFeedForecastService } from '../../feeding-protocol/services/protocol-feed-forecast.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { Species } from '../../species/entities/species.entity';
import { Site } from '../../site/entities/site.entity';
import { Tank } from '../../tank/entities/tank.entity';
import {
  createFarmTenantFixture,
  createFixtureBatchWriters,
  FIXTURE_ENTITIES,
} from './helpers/farm-tenant-fixture';
import {
  createFarmOutboxTable,
  createFarmStockReadModelTables,
  createTenantSchemaDerived,
} from './helpers/tenant-schema-harness';

jest.setTimeout(120_000);

const TENANT = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';
const PROTOCOL_ID = '33333333-3333-4333-8333-333333333333';
const ASSIGNMENT_ID = '22222222-2222-4222-8222-222222222222';
const FEED_ID = '66666666-6666-4666-8666-666666666666';

/** FCR 1.0 keeps the arithmetic legible: every kg fed is a kg of growth. */
const EXPECTED_FCR = 1;

const SNAPSHOT: DayPlanSnapshot = {
  avgWeightG: 10,
  fishCount: 100,
  biomassKg: 1,
  waterTempC: 14,
  temperatureSource: 'manual',
  usingDefaultTemperature: false,
  bandIndex: 0,
  feed: { id: FEED_ID, code: 'F-1MM', name: 'Starter 1mm' },
  baseRatePercent: 2,
  tempMultiplier: 1,
  effectiveRatePercent: 2,
  expectedFcr: EXPECTED_FCR,
  fcrResolvedSource: FcrResolvedSource.BAND,
};

function resolutionWith(expectedFcr: number | null): DayPlanResolution {
  return {
    resolvedAt: '2026-06-14T06:00:00.000Z',
    bandIndex: 0,
    feed: { id: FEED_ID, code: 'F-1MM', name: 'Starter 1mm' },
    baseRatePercent: 2,
    tempMultiplier: 1,
    effectiveRatePercent: 2,
    // A plan whose FCR never resolved must not be stamped — see the last case.
    expectedFcr: expectedFcr as number,
    fcrResolvedSource: FcrResolvedSource.BAND,
    bandBasisWeightG: 10,
    waterTempC: 14,
    temperatureSource: 'manual',
  };
}

describe('DAILY rollup reconciliation — real Postgres', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let cron: FeedingCronV2Service;
  let unitId: string;
  let siteId: string;

  /** Yesterday in the clock's zone: the rollup only considers closed days. */
  const CLOCK: FeedingClock = {
    at: new Date('2026-06-15T05:30:00.000Z'),
    zone: 'UTC',
    localDate: '2026-06-15',
    localHour: 5,
    localMinute: 30,
    dayStartUtc: new Date('2026-06-15T00:00:00.000Z'),
    dayEndUtc: new Date('2026-06-16T00:00:00.000Z'),
  };
  const PLAN_DATE = '2026-06-14';

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-rollup-${randomBytes(4).toString('hex')}`,
      entities: [
        // The fixture's production writers declare what they need; this suite
        // adds only what IT needs on top (FARM-HIGH-109).
        ...FIXTURE_ENTITIES,
      ],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
    await createFarmOutboxTable(dataSource);
    await createFarmStockReadModelTables(dataSource);

    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();
    await createTenantSchemaDerived(dataSource, getTenantSchemaName(TENANT));

    const fixture = await createFarmTenantFixture(
      dataSource,
      createFixtureBatchWriters(dataSource),
      {
        tenantId: TENANT,
        codePrefix: 'ROLLUP',
        userId: USER_ID,
      },
    );
    unitId = fixture.tank.id;
    siteId = fixture.site.id;

    // Only the collaborators the morning sweep's rollup leg actually reaches are
    // real: the growth applier (which locks the unit and distributes growth) and
    // the outbox publisher. The generation/forecast/FCR/temperature services
    // belong to other jobs on this class and are never called by sweepTenant;
    // the recalc service is reached only for overdue meals, and this suite seeds
    // none. Each unreached collaborator is an EMPTY TYPED DOUBLE named after the
    // real service: if the sweep ever grows a call into one, the failure names
    // the service and the member instead of dying on a null dereference.
    const growthApplier = new BiomassGrowthApplierService();
    const outboxPublisher = new OutboxPublisher(FarmOutbox);
    const recalcService = collaborator<DayPlanRecalcService>(
      { recalcForUnit: jest.fn().mockResolvedValue(null) },
      'DayPlanRecalcService',
    );
    cron = new FeedingCronV2Service(
      dataSource,
      collaborator<MealPlanGeneratorService>({}, 'MealPlanGeneratorService'),
      growthApplier,
      collaborator<WaterTemperatureService>({}, 'WaterTemperatureService'),
      collaborator<FCRCalculationService>({}, 'FCRCalculationService'),
      outboxPublisher,
      collaborator<ProtocolFeedForecastService>({}, 'ProtocolFeedForecastService'),
      recalcService,
      // Finalize servisi de bu suite'te ERİŞİLMEZ (bayat öğün ekilmiyor), ama
      // boş bir çift yerine gerçeği veriliyor: ileride rollup ayağı finalize'a
      // uğrarsa spec patlamak yerine gerçek davranışı koşar (FARM-MEDIUM-276).
      realFinalizationService({ growthApplier, recalcService, outboxPublisher }),
      collaborator<FeedingClockService>({}, 'FeedingClockService'),
      collaborator<FeedingJobRunService>({}, 'FeedingJobRunService'),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  beforeEach(async () => {
    await dataSource.manager.query(`DELETE FROM "${getTenantSchemaName(TENANT)}"."feeding_meals"`);
    await dataSource.manager.query(
      `DELETE FROM "${getTenantSchemaName(TENANT)}"."feeding_day_plans"`,
    );
  });

  interface PlanSeed {
    growthApplicationMode: 'per_meal' | 'daily';
    status?: FeedingDayPlanStatus;
    rollupAppliedKg?: number;
    expectedFcr?: number | null;
    planDate?: string;
  }

  /** Writes the plan straight into the tenant schema, as the generator would. */
  async function seedPlan(seed: PlanSeed): Promise<string> {
    const schema = getTenantSchemaName(TENANT);
    const rows: Array<{ id: string }> = await dataSource.manager.query(
      `INSERT INTO "${schema}"."feeding_day_plans"
         (id, "tenantId", "assignmentId", "protocolId", "unitId", "siteId", "unitType",
          "unitName", "unitCode", "planDate", snapshot, "plannedTotalKg", "unplannedActualKg",
          "mealsPlanned", status, "recalcLog", "growthApplicationMode", "rollupAppliedKg",
          "rollupGrowthKg", resolution, version)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5,
               $6::feeding_protocol_assignments_unittype_enum, 'ROLLUP Tank', 'ROLLUP-TANK',
               $7, $8::jsonb, 1, 0, 1, $9::feeding_day_plans_status_enum, '[]'::jsonb,
               $10, $11, 0, $12::jsonb, 1)
       RETURNING id`,
      [
        TENANT,
        ASSIGNMENT_ID,
        PROTOCOL_ID,
        unitId,
        siteId,
        FeedingUnitType.TANK,
        seed.planDate ?? PLAN_DATE,
        JSON.stringify(SNAPSHOT),
        seed.status ?? FeedingDayPlanStatus.COMPLETED,
        seed.growthApplicationMode,
        seed.rollupAppliedKg ?? 0,
        JSON.stringify(
          resolutionWith(seed.expectedFcr === undefined ? EXPECTED_FCR : seed.expectedFcr),
        ),
      ],
    );
    return rows[0]!.id;
  }

  async function seedFedMeal(
    dayPlanId: string,
    mealIndex: number,
    actualKg: number,
  ): Promise<void> {
    const schema = getTenantSchemaName(TENANT);
    await dataSource.manager.query(
      `INSERT INTO "${schema}"."feeding_meals"
         (id, "tenantId", "dayPlanId", "unitId", "siteId", "mealIndex", "scheduledAt",
          "percentOfDaily", "plannedKg", status, "actualKg", pours, "feedId", version)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6,
               100, $7, $8::feeding_meals_status_enum, $7, '[]'::jsonb, $9, 1)`,
      [
        TENANT,
        dayPlanId,
        unitId,
        siteId,
        mealIndex,
        new Date(`${PLAN_DATE}T08:00:00.000Z`),
        actualKg,
        FeedingMealStatus.FED,
        FEED_ID,
      ],
    );
  }

  async function readPlan(
    dayPlanId: string,
  ): Promise<{ appliedKg: number; growthKg: number; lastRunAt: Date | null }> {
    const schema = getTenantSchemaName(TENANT);
    const rows: Array<{ applied: string; growth: string; lastRun: Date | null }> =
      await dataSource.manager.query(
        `SELECT "rollupAppliedKg"::text AS applied, "rollupGrowthKg"::text AS growth,
                "rollupLastRunAt" AS "lastRun"
           FROM "${schema}"."feeding_day_plans" WHERE id = $1`,
        [dayPlanId],
      );
    return {
      appliedKg: Number(rows[0]?.applied ?? 0),
      growthKg: Number(rows[0]?.growth ?? 0),
      lastRunAt: rows[0]?.lastRun ?? null,
    };
  }

  async function unitBiomassKg(): Promise<number> {
    const schema = getTenantSchemaName(TENANT);
    const rows: Array<{ biomass: string }> = await dataSource.manager.query(
      `SELECT "totalBiomassKg"::text AS biomass FROM "${schema}"."tank_batches"
        WHERE "tenantId" = $1 AND "tankId" = $2`,
      [TENANT, unitId],
    );
    return Number(rows[0]?.biomass ?? 0);
  }

  it('converts fed kg into growth and records how much it applied', async () => {
    const before = await unitBiomassKg();
    const planId = await seedPlan({ growthApplicationMode: 'daily' });
    await seedFedMeal(planId, 0, 0.5);

    await cron.sweepTenant(TENANT, CLOCK);

    const plan = await readPlan(planId);
    // The stamp is a QUANTITY, not a flag — that is the whole W1 change.
    expect(plan.appliedKg).toBe(0.5);
    expect(plan.growthKg).toBe(0.5); // FCR 1.0
    expect(plan.lastRunAt).not.toBeNull();
    expect(await unitBiomassKg()).toBeCloseTo(before + 0.5, 3);
  });

  it('is idempotent: a second sweep with no new actuals changes nothing', async () => {
    const planId = await seedPlan({ growthApplicationMode: 'daily' });
    await seedFedMeal(planId, 0, 0.5);

    await cron.sweepTenant(TENANT, CLOCK);
    const afterFirst = await unitBiomassKg();
    await cron.sweepTenant(TENANT, CLOCK);

    const plan = await readPlan(planId);
    expect(plan.appliedKg).toBe(0.5);
    expect(plan.growthKg).toBe(0.5);
    // Double counting here is the 24-month regression FARM-CRITICAL-238 names.
    expect(await unitBiomassKg()).toBeCloseTo(afterFirst, 3);
  });

  it('picks up a late meal on the next sweep and applies only the difference', async () => {
    const planId = await seedPlan({ growthApplicationMode: 'daily' });
    await seedFedMeal(planId, 0, 0.5);
    await cron.sweepTenant(TENANT, CLOCK);
    const afterFirst = await unitBiomassKg();

    // A meal finalized after the sweep — or a correctMealPour adjustment. Under
    // the old one-shot stamp this growth was lost permanently.
    await seedFedMeal(planId, 1, 0.2);
    await cron.sweepTenant(TENANT, CLOCK);

    const plan = await readPlan(planId);
    expect(plan.appliedKg).toBe(0.7);
    expect(plan.growthKg).toBe(0.7);
    expect(await unitBiomassKg()).toBeCloseTo(afterFirst + 0.2, 3);
  });

  it('ignores per_meal plans — the mode is read from the plan, not the protocol', async () => {
    // Growth was already applied meal-by-meal; rolling it up would count twice.
    // Reading the mode from the plan's frozen column is what makes a later
    // protocol edit unable to reach into closed days.
    const before = await unitBiomassKg();
    const planId = await seedPlan({ growthApplicationMode: 'per_meal' });
    await seedFedMeal(planId, 0, 0.5);

    await cron.sweepTenant(TENANT, CLOCK);

    const plan = await readPlan(planId);
    expect(plan.appliedKg).toBe(0);
    expect(plan.growthKg).toBe(0);
    expect(await unitBiomassKg()).toBeCloseTo(before, 3);
  });

  it('leaves a plan unstamped when its FCR never resolved, so a fix re-qualifies it', async () => {
    const before = await unitBiomassKg();
    const planId = await seedPlan({ growthApplicationMode: 'daily', expectedFcr: 0 });
    await seedFedMeal(planId, 0, 0.5);

    await cron.sweepTenant(TENANT, CLOCK);

    // Growth is uncomputable without an FCR. Stamping anyway would discard the
    // day silently; leaving it unstamped keeps it a candidate once corrected.
    const plan = await readPlan(planId);
    expect(plan.appliedKg).toBe(0);
    expect(plan.growthKg).toBe(0);
    expect(plan.lastRunAt).toBeNull();
    expect(await unitBiomassKg()).toBeCloseTo(before, 3);
  });

  it('does not reach into the current day — only closed days roll up', async () => {
    const before = await unitBiomassKg();
    const planId = await seedPlan({
      growthApplicationMode: 'daily',
      planDate: CLOCK.localDate,
    });
    await seedFedMeal(planId, 0, 0.5);

    await cron.sweepTenant(TENANT, CLOCK);

    const plan = await readPlan(planId);
    expect(plan.appliedKg).toBe(0);
    expect(await unitBiomassKg()).toBeCloseTo(before, 3);
  });
});
