/**
 * The 18:00 FCR alert sweep, against a real PostgreSQL (FARM-CRITICAL-444).
 *
 * ## The defect being pinned
 *
 * The sweep selected its work with
 *
 *     isActive = true AND status IN ('ACTIVE','GROWING') AND (fcr->>'actual')::numeric > 0
 *
 * and no row can satisfy all three clauses. Every batch is created with
 * `fcr.actual = 0` (CreateBatchHandler), and the only writer of `fcr.actual` is
 * CloseBatchHandler, which sets `isActive = false` in the same block. So the
 * sweep never emitted an FCRAlert for any live batch, and alert-engine's
 * FcrAlertEventHandler never received one.
 *
 * ## What the sweep must judge instead
 *
 * - Every live batch that can be fed: `isActive` and an operational status
 *   (ACTIVE, GROWING, PRE_HARVEST, HARVESTING), the same set assertFeedable
 *   allows feeding in.
 * - Its FCR at the last weighing, the one moment at which feed, the removal
 *   ledger and the biomass are all known. Feed given after the weighing has no
 *   measured growth to set against yet, so counting it inflates FCR every day
 *   until the next weighing.
 * - Only batches weighed since stocking. Before the first weighing the batch's
 *   weight is still the stocking weight, so "growth" is only the rounding
 *   residue of the removal ledger, and FCR over it is noise in the thousands.
 *
 * ## Why this needs a real database
 *
 * The unit spec mocks `manager.query` and hands the sweep rows directly, so the
 * predicate never ran and the dead sweep stayed green. Here the batches come
 * from the production command handlers: stocking, weighing
 * (RecordGrowthSampleHandler, which writes `lastMeasuredAt`, `sampleSize` and
 * the at-weighing biomass), mortality (RecordMortalityHandler, whose ledger row
 * carries RemovalQuantityPolicy's rounding) and status changes. The sweep runs
 * with the real FCR authority, the real outbox publisher and the real tenant
 * transaction.
 *
 * ## The fixture
 *
 * Each case is its own tenant with one stocked tank (the shared fixture creates
 * one species per tenant). Unless a plan says otherwise a batch is 100 fish at
 * 10 g (1 kg). Feed is recorded as feeding records dated before the weighing,
 * and after it where a plan says so. A weighing at 30 g puts the batch at 3 kg,
 * so 2 kg grew. The species is Atlantic salmon with no override and no
 * protocol, so the target chain ends at the industry average, FCR 1.2.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { Role } from '@aquaculture/backend-common/decorators';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';
import { collaborator } from '@aquaculture/testing';
import type { FCRAlertEvent } from '@platform/event-contracts';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import {
  MortalityReason,
  RecordMortalityCommand,
} from '../../batch/commands/record-mortality.command';
import { UpdateBatchStatusCommand } from '../../batch/commands/update-batch-status.command';
import { BatchStatus } from '../../batch/entities/batch.entity';
import { OperationType } from '../../batch/entities/tank-operation.entity';
import { UpdateBatchStatusHandler } from '../../batch/handlers/update-batch-status.handler';
import { BatchLifecyclePolicyService } from '../../batch/services/batch-lifecycle-policy.service';
import { Feed, FeedStatus, FeedType, FloatingType } from '../../feed/entities/feed.entity';
import { FeedingMethod, FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import { realFinalizationService } from '../../feeding-protocol/__tests__/helpers/meal-finalization-double';
import { BiomassGrowthApplierService } from '../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { FeedingClockService } from '../../feeding-protocol/services/feeding-clock.service';
import { FeedingCronV2Service } from '../../feeding-protocol/services/feeding-cron-v2.service';
import { FeedingJobRunService } from '../../feeding-protocol/services/feeding-job-run.service';
import { MealPlanGeneratorService } from '../../feeding-protocol/services/meal-plan-generator.service';
import { ProtocolFeedForecastService } from '../../feeding-protocol/services/protocol-feed-forecast.service';
import { RecordGrowthSampleCommand } from '../../growth/commands/record-growth-sample.command';
import {
  FCRCalculationService,
  FcrAtLastWeighing,
} from '../../growth/services/fcr-calculation.service';
import { SiteTimeZoneService } from '../../localization/services/site-time-zone.service';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import {
  createFarmTenantFixture,
  createFixtureBatchRecorders,
  createFixtureBatchWriters,
  createFixtureFcrCalculationService,
  FarmTenantFixture,
  FCR_AUTHORITY_ENTITIES,
  FIXTURE_ENTITIES,
  FixtureBatchRecorders,
  FixtureBatchWriters,
} from './helpers/farm-tenant-fixture';
import {
  createFarmOutboxTable,
  createFarmStockReadModelTables,
  createTenantSchemaDerived,
} from './helpers/tenant-schema-harness';

const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';

/** Industry average for atlantic_salmon: the end of the target chain here. */
const TARGET_FCR = 1.2;

const DAY_MS = 86_400_000;

/**
 * Noon UTC, `days` calendar days before the run. Noon keeps every `date`
 * column on the same calendar day for any server zone within ±11 h, and a past
 * day is inside the backdate windows (growth 30 days, mortality 14 days).
 */
function daysAgo(days: number): Date {
  const day = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  return new Date(`${day}T12:00:00.000Z`);
}

/** The order of events every plan follows: feed, weigh, feed again, deaths. */
const FED_BEFORE_WEIGHING = daysAgo(10);
const WEIGHED_ON = daysAgo(7);
const FED_AFTER_WEIGHING = daysAgo(3);
const DIED_ON = daysAgo(2);

/** One tenant's batch: how it is stocked, fed, weighed, thinned and moved. */
interface BatchPlan {
  readonly tenantId: string;
  readonly code: string;
  /** Fish stocked; the fixture default (100) when omitted. */
  readonly initialQuantity?: number;
  /** Stocking weight in grams; the fixture default (10) when omitted. */
  readonly initialAvgWeightG?: number;
  /**
   * Status changes after the feeding, weighing and deaths, through the
   * production status handler. The initial-stocking allocation already moves
   * the batch to ACTIVE.
   */
  readonly transitions: readonly BatchStatus[];
  /** Feed recorded before the weighing day, kg. */
  readonly fedKg: number;
  /** Feed recorded after the weighing day, kg. */
  readonly fedAfterWeighingKg: number;
  /** Weighed average weight in grams; null leaves the batch unweighed. */
  readonly weighedAvgWeightG: number | null;
  /** Dead fish recorded by count only (no weight, no kg), after the weighing day. */
  readonly deadByCount: number;
}

const PLANS = {
  // FCR 5 / 2 = 2.5, +108% over target: critical.
  critical: {
    tenantId: '7d3c2a61-4f0e-4b8a-9c15-2e6f8d0a4b37',
    code: 'FCR-CRIT',
    transitions: [],
    fedKg: 5,
    fedAfterWeighingKg: 0,
    weighedAvgWeightG: 30,
    deadByCount: 0,
  },
  // FCR 2.7 / 2 = 1.35, +12.5% over target: warning.
  warning: {
    tenantId: '0b6e9f42-8a1d-4c37-b5e2-61f4d9c8a703',
    code: 'FCR-WARN',
    transitions: [BatchStatus.GROWING],
    fedKg: 2.7,
    fedAfterWeighingKg: 0,
    weighedAvgWeightG: 30,
    deadByCount: 0,
  },
  // FCR 2.4 / 2 = 1.2, on target: no alert.
  onTarget: {
    tenantId: 'c41a7e95-2d6b-4f08-9e3c-8b5d0f7a1e26',
    code: 'FCR-OK',
    transitions: [],
    fedKg: 2.4,
    fedAfterWeighingKg: 0,
    weighedAvgWeightG: 30,
    deadByCount: 0,
  },
  // On target at the weighing (2.4 / 2 = 1.2), then fed 0.3 kg more. Counting
  // that feed against the growth measured before it reads 2.7 / 2 = 1.35, a
  // warning, and the figure would climb every day until the next weighing.
  fedAfterWeighing: {
    tenantId: '3a9e5c70-1b2d-4f86-a4c3-9d7e0b5f2c18',
    code: 'FCR-LATE',
    transitions: [],
    fedKg: 2.4,
    fedAfterWeighingKg: 0.3,
    weighedAvgWeightG: 30,
    deadByCount: 0,
  },
  // Fed but never weighed: growth is unknown, so there is no FCR to judge.
  unweighed: {
    tenantId: '5f2d8c17-9b4e-4a61-8d0f-3c7e2a9b6d54',
    code: 'FCR-NOGROW',
    transitions: [],
    fedKg: 3,
    fedAfterWeighingKg: 0,
    weighedAvgWeightG: null,
    deadByCount: 0,
  },
  // Never weighed, 3 deaths recorded by count. The ledger takes 3 x 12.5 g =
  // 0.0375 kg, RemovalQuantityPolicy rounds it to 0.038 and numeric(15,2)
  // stores 0.04, so "growth" is the 0.0025 kg residue and 20 kg of feed over
  // it reads FCR 8000.
  unweighedCountedDeaths: {
    tenantId: '9c47e2b8-6d15-4a03-b8f9-1e2d5c7a4b60',
    code: 'FCR-DEAD',
    initialQuantity: 1000,
    initialAvgWeightG: 12.5,
    transitions: [],
    fedKg: 20,
    fedAfterWeighingKg: 0,
    weighedAvgWeightG: null,
    deadByCount: 3,
  },
  // PRE_HARVEST keeps isActive=true and stays feedable: FCR 2.5, critical.
  preHarvest: {
    tenantId: 'b2f6d913-4e8a-4c57-9a1d-7f3e0c6b8d25',
    code: 'FCR-PREH',
    transitions: [BatchStatus.GROWING, BatchStatus.PRE_HARVEST],
    fedKg: 5,
    fedAfterWeighingKg: 0,
    weighedAvgWeightG: 30,
    deadByCount: 0,
  },
  // HARVESTING keeps isActive=true and stays feedable: FCR 2.5, critical.
  harvesting: {
    tenantId: '6e1a8f4c-2b97-4d30-8c6e-5a9d1f3b7e42',
    code: 'FCR-HARV',
    transitions: [BatchStatus.GROWING, BatchStatus.PRE_HARVEST, BatchStatus.HARVESTING],
    fedKg: 5,
    fedAfterWeighingKg: 0,
    weighedAvgWeightG: 30,
    deadByCount: 0,
  },
  // Weighed at 9 g after 3 kg of feed: 0.9 kg against 1 kg stocked, so no
  // realized growth. FCR is undefined; the authority says not-growing.
  notGrowing: {
    tenantId: '1781c2e6-208f-44e3-967f-e9c4e16ae7ac',
    code: 'FCR-LOSS',
    transitions: [],
    fedKg: 3,
    fedAfterWeighingKg: 0,
    weighedAvgWeightG: 9,
    deadByCount: 0,
  },
  // Same numbers as the critical batch, but FAILED retires it (isActive=false).
  retired: {
    tenantId: 'e8b03a5d-6c1f-4e92-a7d4-0f9b5c2e8a61',
    code: 'FCR-FAILED',
    transitions: [BatchStatus.FAILED],
    fedKg: 5,
    fedAfterWeighingKg: 0,
    weighedAvgWeightG: 30,
    deadByCount: 0,
  },
} as const satisfies Record<string, BatchPlan>;

type PlanKey = keyof typeof PLANS;

const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];

describe('18:00 FCR alert sweep — real Postgres (FARM-CRITICAL-444)', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let fcrAuthority: FCRCalculationService;
  const batchIds = new Map<PlanKey, string>();

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-fcr-sweep-${randomBytes(4).toString('hex')}`,
      entities: [...FIXTURE_ENTITIES, ...FCR_AUTHORITY_ENTITIES],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
    await createFarmOutboxTable(dataSource);
    await createFarmStockReadModelTables(dataSource);

    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();

    const outboxPublisher = new OutboxPublisher(FarmOutbox);
    const writers = createFixtureBatchWriters(dataSource);
    const recorders = createFixtureBatchRecorders(dataSource);
    const statusHandler = new UpdateBatchStatusHandler(
      dataSource,
      outboxPublisher,
      new BatchLifecyclePolicyService(),
    );

    // Only the FCR leg of this class runs here, so only its collaborators are
    // real: the FCR authority and the outbox publisher. Every other one is an
    // empty typed double named after the real service, so a new call into one
    // fails with its name instead of a null dereference.
    const growthApplier = new BiomassGrowthApplierService();
    const recalcService = collaborator<DayPlanRecalcService>({}, 'DayPlanRecalcService');
    fcrAuthority = createFixtureFcrCalculationService(dataSource);
    const cron = new FeedingCronV2Service(
      dataSource,
      createScheduledJobTestExecutor().executor,
      collaborator<MealPlanGeneratorService>({}, 'MealPlanGeneratorService'),
      growthApplier,
      collaborator<WaterTemperatureService>({}, 'WaterTemperatureService'),
      fcrAuthority,
      outboxPublisher,
      collaborator<ProtocolFeedForecastService>({}, 'ProtocolFeedForecastService'),
      recalcService,
      realFinalizationService({ growthApplier, recalcService, outboxPublisher }),
      collaborator<FeedingClockService>({}, 'FeedingClockService'),
      collaborator<FeedingJobRunService>({}, 'FeedingJobRunService'),
      collaborator<SiteTimeZoneService>({}, 'SiteTimeZoneService'),
    );

    for (const key of PLAN_KEYS) {
      const plan: BatchPlan = PLANS[key];
      await createTenantSchemaDerived(dataSource, getTenantSchemaName(plan.tenantId));
      batchIds.set(key, await seedBatch(writers, recorders, statusHandler, plan));
      await cron.sweepFcrForTenant(plan.tenantId);
    }
    // Eleven tenants, each stocked, fed, weighed and moved through the
    // production handlers: more than the 120 s default the integration config
    // gives a hook.
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  async function recordFeed(
    fixture: FarmTenantFixture,
    feed: Feed,
    plan: BatchPlan,
    feedingDate: Date,
    kg: number,
  ): Promise<void> {
    const { tenantId } = plan;
    const manager = dataSource.manager;
    await withTenantContext(tenantId, () =>
      manager.save(
        manager.create(FeedingRecord, {
          tenantId,
          batchId: fixture.batch.id,
          tankId: fixture.tank.id,
          feedingDate,
          feedingTime: '08:00',
          feedingSequence: 1,
          totalMealsToday: 1,
          feedId: feed.id,
          plannedAmount: kg,
          actualAmount: kg,
          // DecimalTransformer turns an omitted value into an explicit NULL,
          // so the column default never applies.
          variance: 0,
          variancePercent: 0,
          feedingMethod: FeedingMethod.MANUAL,
          fedBy: USER_ID,
        }),
      ),
    );
  }

  async function seedBatch(
    writers: FixtureBatchWriters,
    recorders: FixtureBatchRecorders,
    statusHandler: UpdateBatchStatusHandler,
    plan: BatchPlan,
  ): Promise<string> {
    const { tenantId } = plan;
    const initialQuantity = plan.initialQuantity ?? 100;
    const fixture = await createFarmTenantFixture(dataSource, writers, {
      tenantId,
      codePrefix: plan.code,
      userId: USER_ID,
      initialQuantity,
      initialAvgWeightG: plan.initialAvgWeightG ?? 10,
    });
    const batchId = fixture.batch.id;
    const manager = dataSource.manager;

    const feed = await withTenantContext(tenantId, () =>
      manager.save(
        manager.create(Feed, {
          tenantId,
          name: `${plan.code} Grower`,
          code: `${plan.code}-FEED`,
          type: FeedType.GROWER,
          targetSpecies: 'SALMON',
          floatingType: FloatingType.FLOATING,
          status: FeedStatus.AVAILABLE,
          quantity: 100,
          minStock: 10,
          pricePerKg: 2.5,
          currency: 'USD',
          isActive: true,
          isDeleted: false,
          createdBy: USER_ID,
          updatedBy: USER_ID,
        }),
      ),
    );

    await recordFeed(fixture, feed, plan, FED_BEFORE_WEIGHING, plan.fedKg);

    if (plan.weighedAvgWeightG !== null) {
      const weightG = plan.weighedAvgWeightG;
      await withTenantContext(tenantId, () =>
        recorders.recordGrowthSample.execute(
          new RecordGrowthSampleCommand(
            tenantId,
            {
              batchId,
              tankId: fixture.tank.id,
              measurementDate: WEIGHED_ON,
              populationSize: initialQuantity,
              individualMeasurements: [1, 2, 3].map((sampleNumber) => ({
                sampleNumber,
                weight: weightG,
              })),
              measuredBy: USER_ID,
            },
            USER_ID,
          ),
        ),
      );
    }

    if (plan.fedAfterWeighingKg > 0) {
      await recordFeed(fixture, feed, plan, FED_AFTER_WEIGHING, plan.fedAfterWeighingKg);
    }

    if (plan.deadByCount > 0) {
      await withTenantContext(tenantId, () =>
        recorders.recordMortality.execute(
          new RecordMortalityCommand(
            tenantId,
            batchId,
            {
              tankId: fixture.tank.id,
              quantity: plan.deadByCount,
              reason: MortalityReason.DISEASE,
              observedAt: DIED_ON,
              notes: 'fcr sweep fixture: dead fish counted, not weighed',
            },
            USER_ID,
            [Role.MODULE_MANAGER],
            [],
            // The production mortality path rejects a call without an
            // idempotency envelope, as the GraphQL input and REST DTO require.
            {
              clientCommandId: randomUUID(),
              payloadHash: 'c'.repeat(64),
              operationType: 'recordMortality',
            },
          ),
        ),
      );
    }

    for (const status of plan.transitions) {
      await withTenantContext(tenantId, () =>
        statusHandler.execute(
          new UpdateBatchStatusCommand(tenantId, batchId, status, 'fcr sweep fixture', USER_ID),
        ),
      );
    }
    return batchId;
  }

  function batchId(key: PlanKey): string {
    const id = batchIds.get(key);
    if (id === undefined) throw new Error(`fixture batch ${key} was not seeded`);
    return id;
  }

  async function fcrAlerts(key: PlanKey): Promise<FCRAlertEvent[]> {
    const rows: Array<{ payload: FCRAlertEvent }> = await dataSource.manager.query(
      `SELECT "payload" FROM "farm"."outbox_events"
        WHERE "tenantId" = $1 AND "eventType" = 'FCRAlert'`,
      [PLANS[key].tenantId],
    );
    return rows.map((row) => row.payload);
  }

  /** The FCR authority's verdict at the last weighing, read as the sweep reads it. */
  async function atLastWeighing(key: PlanKey): Promise<FcrAtLastWeighing | undefined> {
    const { tenantId } = PLANS[key];
    const id = batchId(key);
    const verdicts = await withTenantContext(tenantId, () =>
      fcrAuthority.calculateFcrAtLastWeighingMany(tenantId, [id]),
    );
    return verdicts.get(id);
  }

  async function storedBatch(
    key: PlanKey,
  ): Promise<{ status: string; isActive: boolean; storedFcrActual: number }> {
    const rows: Array<{ status: string; isActive: boolean; actual: string }> =
      await dataSource.manager.query(
        `SELECT "status"::text AS status, "isActive", ("fcr"->>'actual') AS actual
           FROM "${getTenantSchemaName(PLANS[key].tenantId)}"."batches_v2" WHERE "id" = $1`,
        [batchId(key)],
      );
    const row = rows[0];
    if (row === undefined) throw new Error(`fixture batch ${key} is missing`);
    return { status: row.status, isActive: row.isActive, storedFcrActual: Number(row.actual) };
  }

  it('leaves every live batch with the stored fcr.actual production writes: 0', async () => {
    // The precondition the defect hinges on. If a writer ever maintains
    // fcr.actual for live batches, this fixture stops reproducing production.
    expect(await storedBatch('critical')).toEqual({
      status: BatchStatus.ACTIVE,
      isActive: true,
      storedFcrActual: 0,
    });
    expect(await storedBatch('warning')).toEqual({
      status: BatchStatus.GROWING,
      isActive: true,
      storedFcrActual: 0,
    });
  });

  it('weighs through the production handler: weight.actual carries its provenance', async () => {
    const rows: Array<{ sampleSize: number; totalBiomass: string; lastMeasuredAt: string }> =
      await dataSource.manager.query(
        `SELECT ("weight"->'actual'->>'sampleSize')::int AS "sampleSize",
                "weight"->'actual'->>'totalBiomass' AS "totalBiomass",
                "weight"->'actual'->>'lastMeasuredAt' AS "lastMeasuredAt"
           FROM "${getTenantSchemaName(PLANS.critical.tenantId)}"."batches_v2" WHERE "id" = $1`,
        [batchId('critical')],
      );
    expect(rows).toEqual([
      {
        sampleSize: 3,
        totalBiomass: '3',
        lastMeasuredAt: WEIGHED_ON.toISOString(),
      },
    ]);
  });

  it('emits a critical FCRAlert for an ACTIVE batch running at FCR 2.5', async () => {
    expect(await fcrAlerts('critical')).toEqual([
      expect.objectContaining({
        eventType: 'FCRAlert',
        tenantId: PLANS.critical.tenantId,
        batchId: batchId('critical'),
        currentFCR: 2.5,
        targetFCR: TARGET_FCR,
        variancePercent: expect.closeTo(108.333, 3),
        alertLevel: 'critical',
      }),
    ]);
  });

  it('emits a warning FCRAlert for a GROWING batch running at FCR 1.35', async () => {
    expect(await fcrAlerts('warning')).toEqual([
      expect.objectContaining({
        batchId: batchId('warning'),
        currentFCR: 1.35,
        targetFCR: TARGET_FCR,
        alertLevel: 'warning',
      }),
    ]);
  });

  it('emits nothing for an on-target batch', async () => {
    expect(await fcrAlerts('onTarget')).toEqual([]);
  });

  it('emits nothing for a batch on target at its weighing and fed after it', async () => {
    // Feed after the weighing has no measured growth to set against yet.
    expect(await fcrAlerts('fedAfterWeighing')).toEqual([]);
    expect(await atLastWeighing('fedAfterWeighing')).toEqual({
      kind: 'converting',
      weighedOn: new Date(WEIGHED_ON.toISOString()),
      fcr: expect.closeTo(1.2, 10),
      totalFeed: 2.4,
      totalGrowth: expect.closeTo(2, 10),
      removedBiomassKg: 0,
    });
  });

  it('emits nothing for a fed batch that was never weighed', async () => {
    expect(await fcrAlerts('unweighed')).toEqual([]);
  });

  it('emits nothing for an unweighed batch whose counted deaths leave a ledger rounding residue', async () => {
    // Precondition: the residue is real. The ledger row holds 0.04 kg where
    // the dead fish weighed 0.0375 kg at the stocking weight.
    const ledger: Array<{ biomassKg: string }> = await dataSource.manager.query(
      `SELECT "biomassKg"::text AS "biomassKg"
         FROM "${getTenantSchemaName(PLANS.unweighedCountedDeaths.tenantId)}"."tank_operations"
        WHERE "batchId" = $1 AND "operationType" = $2`,
      [batchId('unweighedCountedDeaths'), OperationType.MORTALITY],
    );
    expect(ledger).toEqual([{ biomassKg: '0.04' }]);
    expect(await fcrAlerts('unweighedCountedDeaths')).toEqual([]);
    expect(await atLastWeighing('unweighedCountedDeaths')).toEqual({ kind: 'unweighed' });
  });

  it('reports a weighed, fed batch with no realized growth as not-growing', async () => {
    // 100 fish at 9 g is 0.9 kg against 1 kg stocked. FCR is undefined here;
    // the FCRAlert contract cannot carry it, so no alert is raised for it
    // (FARM-HIGH-449, registered with the contract change it needs).
    expect(await atLastWeighing('notGrowing')).toMatchObject({
      kind: 'not-growing',
      totalFeed: 3,
      totalGrowth: expect.closeTo(-0.1, 10),
    });
  });

  it('emits a critical FCRAlert for a fed PRE_HARVEST batch running at FCR 2.5', async () => {
    expect(await storedBatch('preHarvest')).toMatchObject({
      status: BatchStatus.PRE_HARVEST,
      isActive: true,
    });
    expect(await fcrAlerts('preHarvest')).toEqual([
      expect.objectContaining({
        batchId: batchId('preHarvest'),
        currentFCR: 2.5,
        alertLevel: 'critical',
      }),
    ]);
  });

  it('emits a critical FCRAlert for a fed HARVESTING batch running at FCR 2.5', async () => {
    expect(await storedBatch('harvesting')).toMatchObject({
      status: BatchStatus.HARVESTING,
      isActive: true,
    });
    expect(await fcrAlerts('harvesting')).toEqual([
      expect.objectContaining({
        batchId: batchId('harvesting'),
        currentFCR: 2.5,
        alertLevel: 'critical',
      }),
    ]);
  });

  it('emits nothing for a retired batch, whatever its running FCR', async () => {
    // FAILED sets isActive=false: the sweep watches live batches only.
    expect(await storedBatch('retired')).toMatchObject({ isActive: false });
    expect(await fcrAlerts('retired')).toEqual([]);
  });
});
