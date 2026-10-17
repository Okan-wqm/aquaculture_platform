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
 * ## Why this needs a real database
 *
 * The unit spec mocks `manager.query` and hands the sweep rows directly, so the
 * predicate never ran and the dead sweep stayed green. Here the batches come
 * from the production command handlers, which leave `fcr.actual` exactly as
 * production leaves it (0), and the sweep runs with the real FCR authority, the
 * real outbox publisher and the real tenant transaction.
 *
 * ## The fixture
 *
 * Each case is its own tenant with one stocked tank (the shared fixture creates
 * one species per tenant). Every batch is 100 fish at 10 g (1 kg). Feed is
 * recorded as a feeding record, and a weighing is the `weight.actual.avgWeight`
 * that the growth-sample handler writes. A weighing at 30 g puts the batch at
 * 3 kg, so 2 kg grew. The species is Atlantic salmon with no override and no
 * protocol, so the target chain ends at the industry average, FCR 1.2.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
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

import { UpdateBatchStatusCommand } from '../../batch/commands/update-batch-status.command';
import { BatchStatus } from '../../batch/entities/batch.entity';
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
import { SiteTimeZoneService } from '../../localization/services/site-time-zone.service';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import {
  createFarmTenantFixture,
  createFixtureBatchWriters,
  createFixtureFcrCalculationService,
  FCR_AUTHORITY_ENTITIES,
  FIXTURE_ENTITIES,
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

/** One tenant's batch: how it is fed, weighed and moved through its lifecycle. */
interface BatchPlan {
  readonly tenantId: string;
  readonly code: string;
  /**
   * Status changes after stocking, through the production status handler. The
   * initial-stocking allocation already moves the batch to ACTIVE.
   */
  readonly transitions: readonly BatchStatus[];
  readonly fedKg: number;
  /** Weighed average weight in grams; null leaves the batch unweighed. */
  readonly weighedAvgWeightG: number | null;
}

const PLANS = {
  // FCR 5 / 2 = 2.5, +108% over target: critical.
  critical: {
    tenantId: '7d3c2a61-4f0e-4b8a-9c15-2e6f8d0a4b37',
    code: 'FCR-CRIT',
    transitions: [],
    fedKg: 5,
    weighedAvgWeightG: 30,
  },
  // FCR 2.7 / 2 = 1.35, +12.5% over target: warning.
  warning: {
    tenantId: '0b6e9f42-8a1d-4c37-b5e2-61f4d9c8a703',
    code: 'FCR-WARN',
    transitions: [BatchStatus.GROWING],
    fedKg: 2.7,
    weighedAvgWeightG: 30,
  },
  // FCR 2.4 / 2 = 1.2, on target: no alert.
  onTarget: {
    tenantId: 'c41a7e95-2d6b-4f08-9e3c-8b5d0f7a1e26',
    code: 'FCR-OK',
    transitions: [],
    fedKg: 2.4,
    weighedAvgWeightG: 30,
  },
  // Fed but never weighed: no realized growth, so no FCR to judge.
  unweighed: {
    tenantId: '5f2d8c17-9b4e-4a61-8d0f-3c7e2a9b6d54',
    code: 'FCR-NOGROW',
    transitions: [],
    fedKg: 3,
    weighedAvgWeightG: null,
  },
  // Same numbers as the critical batch, but FAILED retires it (isActive=false).
  retired: {
    tenantId: 'e8b03a5d-6c1f-4e92-a7d4-0f9b5c2e8a61',
    code: 'FCR-FAILED',
    transitions: [BatchStatus.FAILED],
    fedKg: 5,
    weighedAvgWeightG: 30,
  },
} as const satisfies Record<string, BatchPlan>;

type PlanKey = keyof typeof PLANS;

const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];

describe('18:00 FCR alert sweep — real Postgres (FARM-CRITICAL-444)', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
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
    const cron = new FeedingCronV2Service(
      dataSource,
      createScheduledJobTestExecutor().executor,
      collaborator<MealPlanGeneratorService>({}, 'MealPlanGeneratorService'),
      growthApplier,
      collaborator<WaterTemperatureService>({}, 'WaterTemperatureService'),
      createFixtureFcrCalculationService(dataSource),
      outboxPublisher,
      collaborator<ProtocolFeedForecastService>({}, 'ProtocolFeedForecastService'),
      recalcService,
      realFinalizationService({ growthApplier, recalcService, outboxPublisher }),
      collaborator<FeedingClockService>({}, 'FeedingClockService'),
      collaborator<FeedingJobRunService>({}, 'FeedingJobRunService'),
      collaborator<SiteTimeZoneService>({}, 'SiteTimeZoneService'),
    );

    for (const key of PLAN_KEYS) {
      const plan = PLANS[key];
      await createTenantSchemaDerived(dataSource, getTenantSchemaName(plan.tenantId));
      batchIds.set(key, await seedBatch(writers, statusHandler, plan));
      await cron.sweepFcrForTenant(plan.tenantId);
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  async function seedBatch(
    writers: FixtureBatchWriters,
    statusHandler: UpdateBatchStatusHandler,
    plan: BatchPlan,
  ): Promise<string> {
    const { tenantId } = plan;
    const fixture = await createFarmTenantFixture(dataSource, writers, {
      tenantId,
      codePrefix: plan.code,
      userId: USER_ID,
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

    await withTenantContext(tenantId, () =>
      manager.save(
        manager.create(FeedingRecord, {
          tenantId,
          batchId,
          tankId: fixture.tank.id,
          feedingDate: new Date('2026-05-10T00:00:00.000Z'),
          feedingTime: '08:00',
          feedingSequence: 1,
          totalMealsToday: 1,
          feedId: feed.id,
          plannedAmount: plan.fedKg,
          actualAmount: plan.fedKg,
          // DecimalTransformer turns an omitted value into an explicit NULL,
          // so the column default never applies.
          variance: 0,
          variancePercent: 0,
          feedingMethod: FeedingMethod.MANUAL,
          fedBy: USER_ID,
        }),
      ),
    );

    if (plan.weighedAvgWeightG !== null) {
      await manager.query(
        `UPDATE "${getTenantSchemaName(tenantId)}"."batches_v2"
            SET "weight" = jsonb_set("weight", '{actual,avgWeight}', to_jsonb($2::numeric))
          WHERE "id" = $1`,
        [batchId, plan.weighedAvgWeightG],
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

  it('emits nothing for a fed batch with no realized growth yet', async () => {
    // FCR 0 here means nothing to judge yet, not perfect conversion.
    expect(await fcrAlerts('unweighed')).toEqual([]);
  });

  it('emits nothing for a retired batch, whatever its running FCR', async () => {
    // FAILED sets isActive=false: the sweep watches live batches only.
    expect(await storedBatch('retired')).toMatchObject({ isActive: false });
    expect(await fcrAlerts('retired')).toEqual([]);
  });
});
