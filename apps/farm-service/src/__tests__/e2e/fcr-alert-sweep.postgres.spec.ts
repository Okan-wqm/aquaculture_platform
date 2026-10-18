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
 * - The biomass at the weighing is the batch's own head count at the end of the
 *   weighing day times the weighed average. The count is the live count with
 *   the ledger's removals after that day added back, so it describes the same
 *   moment as the ledger cut, whatever order the weighing and the removals were
 *   recorded in, and whatever population the operator typed on the sample.
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
 * Each plan is one batch with its own stocked tank. Every plan is its own
 * tenant except the paired one, whose two batches share a tenant (and its
 * species) so that one sweep computes two windows with different weighing days
 * in the same statements. Unless a plan says otherwise
 * a batch is 100 fish at 10 g (1 kg). A plan's steps are recorded in the order
 * listed: feed as feeding records, weighings through RecordGrowthSampleHandler,
 * deaths through RecordMortalityHandler, status changes through
 * UpdateBatchStatusHandler. A weighing at 30 g of all 100 fish puts the batch at
 * 3 kg, so 2 kg grew. The species is Atlantic salmon with no override and no
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
import { TransferBatchCommand } from '../../batch/commands/transfer-batch.command';
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
import { Tank } from '../../tank/entities/tank.entity';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import {
  createFarmTenantFixture,
  createFixtureBatchRecorders,
  createFixtureBatchWriters,
  createFixtureFcrCalculationService,
  createFixtureTank,
  FarmTenantFixture,
  FCR_AUTHORITY_ENTITIES,
  FIXTURE_ENTITIES,
  FixtureBatchRecorders,
  FixtureBatchWriters,
  StockedTank,
  stockFixtureTank,
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

/** The calendar days the plans date their events on. */
const FED_BEFORE_WEIGHING = daysAgo(10);
const WEIGHED_ON = daysAgo(7);
const MOVED_BEFORE_WEIGHING = daysAgo(8);
const DIED_AFTER_WEIGHING = daysAgo(5);
const MOVED_AFTER_WEIGHING = daysAgo(5);
const FED_AFTER_WEIGHING = daysAgo(3);
const DIED_ON = daysAgo(2);
/** The paired tenant's two weighing days, and the days between them. */
const WEIGHED_EARLY = daysAgo(9);
const DIED_BETWEEN = daysAgo(8);
const FED_BETWEEN = daysAgo(6);
const WEIGHED_LATE = daysAgo(4);

/**
 * One recorded event. A plan records its steps in the order listed, so the
 * order of recording is part of the plan, apart from the dates the steps carry.
 */
type Step =
  /** Feed given on `on`, kg. */
  | { readonly feedKg: number; readonly on: Date }
  /**
   * A 3-fish sample at `weighG` grams from the batch's first tank, dated `on`.
   * `populationSize` is the count the operator types on the sample; the
   * stocked count when omitted.
   */
  | { readonly weighG: number; readonly on: Date; readonly populationSize?: number }
  /** Dead fish recorded by count only (no weight, no kg), dated `on`. */
  | { readonly deadByCount: number; readonly on: Date }
  /**
   * Fish moved between the batch's first tank and a second, empty one (created
   * on first use) through the production transfer handler, dated `on`. The
   * ledger gets a TRANSFER_OUT and a TRANSFER_IN row for the same batch.
   */
  | { readonly transferFish: number; readonly from: 'first' | 'second'; readonly on: Date }
  /**
   * A status change through the production status handler. The
   * initial-stocking allocation already moves the batch to ACTIVE.
   */
  | { readonly status: BatchStatus };

/** One batch: how it is stocked, and what is recorded against it, in order. */
interface BatchPlan {
  readonly tenantId: string;
  readonly code: string;
  /** Fish stocked; the fixture default (100) when omitted. */
  readonly initialQuantity?: number;
  /** Stocking weight in grams; the fixture default (10) when omitted. */
  readonly initialAvgWeightG?: number;
  readonly steps: readonly Step[];
}

/** The tenant both paired batches live in. */
const PAIRED_TENANT_ID = '4d8b1f63-7a2e-4c95-b0d6-3e9a5c1f7b28';

const PLANS = {
  // FCR 5 / 2 = 2.5, +108% over target: critical.
  critical: {
    tenantId: '7d3c2a61-4f0e-4b8a-9c15-2e6f8d0a4b37',
    code: 'FCR-CRIT',
    steps: [
      { feedKg: 5, on: FED_BEFORE_WEIGHING },
      { weighG: 30, on: WEIGHED_ON },
    ],
  },
  // FCR 2.7 / 2 = 1.35, +12.5% over target: warning.
  warning: {
    tenantId: '0b6e9f42-8a1d-4c37-b5e2-61f4d9c8a703',
    code: 'FCR-WARN',
    steps: [
      { feedKg: 2.7, on: FED_BEFORE_WEIGHING },
      { weighG: 30, on: WEIGHED_ON },
      { status: BatchStatus.GROWING },
    ],
  },
  // FCR 2.4 / 2 = 1.2, on target: no alert.
  onTarget: {
    tenantId: 'c41a7e95-2d6b-4f08-9e3c-8b5d0f7a1e26',
    code: 'FCR-OK',
    steps: [
      { feedKg: 2.4, on: FED_BEFORE_WEIGHING },
      { weighG: 30, on: WEIGHED_ON },
    ],
  },
  // On target at the weighing (2.4 / 2 = 1.2), then fed 0.3 kg more. Counting
  // that feed against the growth measured before it reads 2.7 / 2 = 1.35, a
  // warning, and the figure would climb every day until the next weighing.
  fedAfterWeighing: {
    tenantId: '3a9e5c70-1b2d-4f86-a4c3-9d7e0b5f2c18',
    code: 'FCR-LATE',
    steps: [
      { feedKg: 2.4, on: FED_BEFORE_WEIGHING },
      { weighG: 30, on: WEIGHED_ON },
      { feedKg: 0.3, on: FED_AFTER_WEIGHING },
    ],
  },
  // Fed but never weighed: growth is unknown, so there is no FCR to judge.
  unweighed: {
    tenantId: '5f2d8c17-9b4e-4a61-8d0f-3c7e2a9b6d54',
    code: 'FCR-NOGROW',
    steps: [{ feedKg: 3, on: FED_BEFORE_WEIGHING }],
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
    steps: [
      { feedKg: 20, on: FED_BEFORE_WEIGHING },
      { deadByCount: 3, on: DIED_ON },
    ],
  },
  // PRE_HARVEST keeps isActive=true and stays feedable: FCR 2.5, critical.
  preHarvest: {
    tenantId: 'b2f6d913-4e8a-4c57-9a1d-7f3e0c6b8d25',
    code: 'FCR-PREH',
    steps: [
      { feedKg: 5, on: FED_BEFORE_WEIGHING },
      { weighG: 30, on: WEIGHED_ON },
      { status: BatchStatus.GROWING },
      { status: BatchStatus.PRE_HARVEST },
    ],
  },
  // HARVESTING keeps isActive=true and stays feedable: FCR 2.5, critical.
  harvesting: {
    tenantId: '6e1a8f4c-2b97-4d30-8c6e-5a9d1f3b7e42',
    code: 'FCR-HARV',
    steps: [
      { feedKg: 5, on: FED_BEFORE_WEIGHING },
      { weighG: 30, on: WEIGHED_ON },
      { status: BatchStatus.GROWING },
      { status: BatchStatus.PRE_HARVEST },
      { status: BatchStatus.HARVESTING },
    ],
  },
  // Weighed at 9 g after 3 kg of feed: 0.9 kg against 1 kg stocked, so no
  // realized growth. FCR is undefined; the authority says not-growing.
  notGrowing: {
    tenantId: '1781c2e6-208f-44e3-967f-e9c4e16ae7ac',
    code: 'FCR-LOSS',
    steps: [
      { feedKg: 3, on: FED_BEFORE_WEIGHING },
      { weighG: 9, on: WEIGHED_ON },
    ],
  },
  // Same numbers as the critical batch, but FAILED retires it (isActive=false).
  retired: {
    tenantId: 'e8b03a5d-6c1f-4e92-a7d4-0f9b5c2e8a61',
    code: 'FCR-FAILED',
    steps: [
      { feedKg: 5, on: FED_BEFORE_WEIGHING },
      { weighG: 30, on: WEIGHED_ON },
      { status: BatchStatus.FAILED },
    ],
  },
  // A HARVESTING batch weighed at 30 g (all 100 fish, 3 kg) after 2.7 kg of
  // feed, so FCR 2.7 / 2 = 1.35, a warning. Later the same day 30 fish leave
  // (0.9 kg at the weighed average), recorded after the sample and dated on
  // the weighing day, so the ledger cut keeps them. Counting them both in the
  // weighed 3 kg and in the ledger reads growth 3 + 0.9 - 1 = 2.9 and FCR 0.93:
  // no alert for a batch 12.5% over target. At the end of the weighing day the
  // batch holds 70 fish, 2.1 kg: growth 2.1 + 0.9 - 1 = 2. (The weighing has
  // re-based the tank to 3 kg, FARM-CRITICAL-454, so the mortality path, which
  // refuses to take more biomass out of a tank than it holds, takes the 0.9 kg.)
  thinnedOnWeighingDay: {
    tenantId: 'a5c3e817-0d4b-4f2a-9e61-7b8d2c4f0a93',
    code: 'FCR-THIN',
    steps: [
      { status: BatchStatus.GROWING },
      { status: BatchStatus.PRE_HARVEST },
      { status: BatchStatus.HARVESTING },
      { feedKg: 2.7, on: FED_BEFORE_WEIGHING },
      { weighG: 30, on: WEIGHED_ON },
      { deadByCount: 30, on: WEIGHED_ON },
    ],
  },
  // On target: 2.4 kg fed, then weighed at 30 g on WEIGHED_ON, so 3 kg and
  // FCR 1.2. But 40 fish died two days after the weighing and were recorded
  // first; the backdated sample is entered afterwards with the count at that
  // time, 60. Reading the typed 60 x 30 g = 1.8 kg as the weighed biomass gives
  // growth 0.8 and FCR 3.0, a critical alert for an on-target batch. At the
  // end of the weighing day the batch held 60 + 40 = 100 fish.
  weighedBackdatedAcrossDeaths: {
    tenantId: 'f0e6b2d4-9c18-4a7e-8d53-2b4f6a9c1e07',
    code: 'FCR-BACK',
    steps: [
      { feedKg: 2.4, on: FED_BEFORE_WEIGHING },
      { deadByCount: 40, on: DIED_AFTER_WEIGHING },
      { weighG: 30, on: WEIGHED_ON, populationSize: 60 },
    ],
  },
  // A batch split across two tanks: 50 fish move to a second tank before the
  // weighing, the first tank's 50 are weighed at 30 g and the sample is typed
  // with that tank's count, 50. 10 fish move back after the weighing. On
  // target (2.4 kg fed, all 100 fish at 30 g, FCR 1.2), but the typed
  // 50 x 30 g = 1.5 kg reads growth 0.5 and FCR 4.8, critical. Both moves stay
  // inside the batch: each nets to zero in the ledger biomass (TRANSFER_IN
  // counts negative) and in the count added back after the weighing day.
  weighedOneTankOfTwo: {
    tenantId: '2c9f4a71-6e3b-4d08-b5a2-8f1d7c3e9b64',
    code: 'FCR-TANKS',
    steps: [
      { feedKg: 2.4, on: FED_BEFORE_WEIGHING },
      { transferFish: 50, from: 'first', on: MOVED_BEFORE_WEIGHING },
      { weighG: 30, on: WEIGHED_ON, populationSize: 50 },
      { transferFish: 10, from: 'second', on: MOVED_AFTER_WEIGHING },
    ],
  },
  // The paired tenant: two batches, weighed on different days, judged in one
  // sweep. Early: 2.4 kg fed, weighed on WEIGHED_EARLY at 30 g (3 kg), so FCR
  // 1.2. After the weighing it is fed 0.6 kg and 10 fish die: neither is in
  // its window, and the 10 dead fish are still in its count at the weighing.
  pairedEarly: {
    tenantId: PAIRED_TENANT_ID,
    code: 'FCR-PAIR-E',
    steps: [
      { feedKg: 2.4, on: FED_BEFORE_WEIGHING },
      { weighG: 30, on: WEIGHED_EARLY },
      { deadByCount: 10, on: DIED_BETWEEN },
      { feedKg: 0.6, on: FED_BETWEEN },
    ],
  },
  // Late: 2.0 kg fed, 20 fish die before its weighing (0.2 kg at the stocking
  // weight), 0.4 kg more fed, then weighed on WEIGHED_LATE at 30 g with the
  // 80 fish left (2.4 kg). Growth 2.4 + 0.2 - 1 = 1.6 on 2.4 kg of feed: FCR
  // 1.5, +25%, critical. Given the early batch's window it would read
  // 2.0 / 2 = 1.0 and raise nothing.
  pairedLate: {
    tenantId: PAIRED_TENANT_ID,
    code: 'FCR-PAIR-L',
    steps: [
      { feedKg: 2.0, on: FED_BEFORE_WEIGHING },
      { deadByCount: 20, on: DIED_BETWEEN },
      { feedKg: 0.4, on: FED_BETWEEN },
      { weighG: 30, on: WEIGHED_LATE, populationSize: 80 },
    ],
  },
} as const satisfies Record<string, BatchPlan>;

type PlanKey = keyof typeof PLANS;

const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];

describe('18:00 FCR alert sweep — real Postgres (FARM-CRITICAL-444)', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let fcrAuthority: FCRCalculationService;
  const batchIds = new Map<PlanKey, string>();
  /** Each tenant's fixture, from its first plan; later plans stock further tanks in it. */
  const tenantFixtures = new Map<string, FarmTenantFixture>();

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

    const tenantIds = [...new Set(PLAN_KEYS.map((key) => PLANS[key].tenantId))];
    for (const tenantId of tenantIds) {
      await createTenantSchemaDerived(dataSource, getTenantSchemaName(tenantId));
      for (const key of PLAN_KEYS.filter((planKey) => PLANS[planKey].tenantId === tenantId)) {
        batchIds.set(key, await seedBatch(writers, recorders, statusHandler, PLANS[key]));
      }
      await cron.sweepFcrForTenant(tenantId);
    }
    // Fifteen batches in fourteen tenants, each stocked, fed, weighed and
    // moved through the production handlers: more than the 120 s default the
    // integration config gives a hook.
  }, 420_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  async function recordFeed(
    fixture: StockedTank,
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

  /**
   * Stocks the plan's batch: in a new tenant fixture for the tenant's first
   * plan, in a further tank of that fixture for the next one.
   */
  async function stockPlan(writers: FixtureBatchWriters, plan: BatchPlan): Promise<StockedTank> {
    const params = {
      tenantId: plan.tenantId,
      codePrefix: plan.code,
      userId: USER_ID,
      initialQuantity: plan.initialQuantity ?? 100,
      initialAvgWeightG: plan.initialAvgWeightG ?? 10,
    };
    const tenantFixture = tenantFixtures.get(plan.tenantId);
    if (tenantFixture !== undefined) {
      return stockFixtureTank(dataSource, writers, tenantFixture, params);
    }
    const created = await createFarmTenantFixture(dataSource, writers, params);
    tenantFixtures.set(plan.tenantId, created);
    return created;
  }

  async function seedBatch(
    writers: FixtureBatchWriters,
    recorders: FixtureBatchRecorders,
    statusHandler: UpdateBatchStatusHandler,
    plan: BatchPlan,
  ): Promise<string> {
    const { tenantId } = plan;
    const initialQuantity = plan.initialQuantity ?? 100;
    const fixture = await stockPlan(writers, plan);
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

    // The batch's second tank, created empty on the plan's first transfer.
    let secondTank: Tank | undefined;
    async function secondTankId(): Promise<string> {
      if (secondTank === undefined) {
        const tenantFixture = tenantFixtures.get(tenantId);
        if (tenantFixture === undefined) throw new Error(`tenant ${tenantId} has no fixture`);
        secondTank = await createFixtureTank(dataSource, tenantFixture.department, {
          tenantId,
          code: `${plan.code}-TANK2`,
          userId: USER_ID,
          count: 0,
          biomassKg: 0,
        });
      }
      return secondTank.id;
    }

    for (const step of plan.steps) {
      if ('feedKg' in step) {
        await recordFeed(fixture, feed, plan, step.on, step.feedKg);
      } else if ('weighG' in step) {
        const weightG = step.weighG;
        await withTenantContext(tenantId, () =>
          recorders.recordGrowthSample.execute(
            new RecordGrowthSampleCommand(
              tenantId,
              {
                batchId,
                tankId: fixture.tank.id,
                measurementDate: step.on,
                populationSize: step.populationSize ?? initialQuantity,
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
      } else if ('deadByCount' in step) {
        await withTenantContext(tenantId, () =>
          recorders.recordMortality.execute(
            new RecordMortalityCommand(
              tenantId,
              batchId,
              {
                tankId: fixture.tank.id,
                quantity: step.deadByCount,
                reason: MortalityReason.DISEASE,
                observedAt: step.on,
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
      } else if ('transferFish' in step) {
        const otherTankId = await secondTankId();
        const [sourceTankId, destinationTankId] =
          step.from === 'first' ? [fixture.tank.id, otherTankId] : [otherTankId, fixture.tank.id];
        await withTenantContext(tenantId, () =>
          writers.transferBatch.execute(
            new TransferBatchCommand(
              tenantId,
              batchId,
              {
                sourceTankId,
                destinationTankId,
                quantity: step.transferFish,
                transferredAt: step.on,
                transferReason: 'fcr sweep fixture: batch split across tanks',
              },
              USER_ID,
              [Role.MODULE_MANAGER],
              [],
              // The production transfer path rejects a call without an
              // idempotency envelope, as the GraphQL input and REST DTO require.
              {
                clientCommandId: randomUUID(),
                payloadHash: 'd'.repeat(64),
                operationType: 'transferBatch',
              },
            ),
          ),
        );
      } else {
        await withTenantContext(tenantId, () =>
          statusHandler.execute(
            new UpdateBatchStatusCommand(
              tenantId,
              batchId,
              step.status,
              'fcr sweep fixture',
              USER_ID,
            ),
          ),
        );
      }
    }
    return batchId;
  }

  function batchId(key: PlanKey): string {
    const id = batchIds.get(key);
    if (id === undefined) throw new Error(`fixture batch ${key} was not seeded`);
    return id;
  }

  /** The FCRAlerts the sweep wrote for one plan's batch. */
  async function fcrAlerts(key: PlanKey): Promise<FCRAlertEvent[]> {
    const rows: Array<{ payload: FCRAlertEvent }> = await dataSource.manager.query(
      `SELECT "payload" FROM "farm"."outbox_events"
        WHERE "tenantId" = $1 AND "eventType" = 'FCRAlert'
          AND "payload"->>'batchId' = $2`,
      [PLANS[key].tenantId, batchId(key)],
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

  it('weighs through the production handler: weight.actual carries what the authority reads', async () => {
    // The weighed average, the weighing day and the sample size, written in
    // one locked update by RecordGrowthSampleHandler. The authority takes the
    // count at the weighing from the ledger, not from the typed populationSize.
    const rows: Array<{ sampleSize: number; avgWeight: string; lastMeasuredAt: string }> =
      await dataSource.manager.query(
        `SELECT ("weight"->'actual'->>'sampleSize')::int AS "sampleSize",
                "weight"->'actual'->>'avgWeight' AS "avgWeight",
                "weight"->'actual'->>'lastMeasuredAt' AS "lastMeasuredAt"
           FROM "${getTenantSchemaName(PLANS.critical.tenantId)}"."batches_v2" WHERE "id" = $1`,
        [batchId('critical')],
      );
    expect(rows).toEqual([
      {
        sampleSize: 3,
        avgWeight: '30',
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

  it('counts a removal dated on the weighing day once, however late it was recorded', async () => {
    // 30 of 100 fish leave on the weighing day, recorded after the sample. The
    // ledger cut keeps their 0.9 kg; the biomass at the end of that day is the
    // 70 fish left. Growth 2.1 + 0.9 - 1 = 2, FCR 1.35: a warning.
    expect(await storedBatch('thinnedOnWeighingDay')).toMatchObject({
      status: BatchStatus.HARVESTING,
      isActive: true,
    });
    expect(await atLastWeighing('thinnedOnWeighingDay')).toEqual({
      kind: 'converting',
      weighedOn: new Date(WEIGHED_ON.toISOString()),
      fcr: expect.closeTo(1.35, 10),
      totalFeed: 2.7,
      totalGrowth: expect.closeTo(2, 10),
      removedBiomassKg: 0.9,
    });
    expect(await fcrAlerts('thinnedOnWeighingDay')).toEqual([
      expect.objectContaining({
        batchId: batchId('thinnedOnWeighingDay'),
        currentFCR: 1.35,
        variancePercent: expect.closeTo(12.5, 3),
        alertLevel: 'warning',
      }),
    ]);
  });

  it('takes the count at a backdated weighing from the ledger, not from the count when it was entered', async () => {
    // The 40 deaths after the weighing day are outside the window and are
    // added back to the live 60: 100 fish at 30 g, growth 2, FCR 1.2.
    expect(await atLastWeighing('weighedBackdatedAcrossDeaths')).toEqual({
      kind: 'converting',
      weighedOn: new Date(WEIGHED_ON.toISOString()),
      fcr: expect.closeTo(1.2, 10),
      totalFeed: 2.4,
      totalGrowth: expect.closeTo(2, 10),
      removedBiomassKg: 0,
    });
    expect(await fcrAlerts('weighedBackdatedAcrossDeaths')).toEqual([]);
  });

  it('judges a one-tank weighing of a split batch at the batch count, with its moves netting to zero', async () => {
    // Precondition: the moves are real ledger rows of this batch, both ways.
    const moves: Array<{ operationType: string; quantity: number }> =
      await dataSource.manager.query(
        `SELECT "operationType"::text AS "operationType", "quantity"
           FROM "${getTenantSchemaName(PLANS.weighedOneTankOfTwo.tenantId)}"."tank_operations"
          WHERE "batchId" = $1
          ORDER BY "operationDate", "operationType"`,
        [batchId('weighedOneTankOfTwo')],
      );
    expect(moves).toEqual([
      { operationType: OperationType.TRANSFER_IN, quantity: 50 },
      { operationType: OperationType.TRANSFER_OUT, quantity: 50 },
      { operationType: OperationType.TRANSFER_IN, quantity: 10 },
      { operationType: OperationType.TRANSFER_OUT, quantity: 10 },
    ]);
    // 100 fish at 30 g on the weighing day, whatever the sample was typed with.
    expect(await atLastWeighing('weighedOneTankOfTwo')).toEqual({
      kind: 'converting',
      weighedOn: new Date(WEIGHED_ON.toISOString()),
      fcr: expect.closeTo(1.2, 10),
      totalFeed: 2.4,
      totalGrowth: expect.closeTo(2, 10),
      removedBiomassKg: 0,
    });
    expect(await fcrAlerts('weighedOneTankOfTwo')).toEqual([]);
  });

  it('gives each batch of one sweep its own window: its weighing day, its ledger cut, its count', async () => {
    // Early: the death and the feed after its weighing are outside its window,
    // and the 10 dead fish are added back to its count at the weighing.
    expect(await atLastWeighing('pairedEarly')).toEqual({
      kind: 'converting',
      weighedOn: new Date(WEIGHED_EARLY.toISOString()),
      fcr: expect.closeTo(1.2, 10),
      totalFeed: 2.4,
      totalGrowth: expect.closeTo(2, 10),
      removedBiomassKg: 0,
    });
    // Late: the death before its weighing is in its ledger (0.2 kg at the
    // stocking weight) and not in its count, and the feed between both
    // weighings is in its window.
    expect(await atLastWeighing('pairedLate')).toEqual({
      kind: 'converting',
      weighedOn: new Date(WEIGHED_LATE.toISOString()),
      fcr: expect.closeTo(1.5, 10),
      totalFeed: 2.4,
      totalGrowth: expect.closeTo(1.6, 10),
      removedBiomassKg: 0.2,
    });
    // The one sweep of the paired tenant alerted on the late batch only.
    expect(await fcrAlerts('pairedEarly')).toEqual([]);
    expect(await fcrAlerts('pairedLate')).toEqual([
      expect.objectContaining({
        batchId: batchId('pairedLate'),
        currentFCR: 1.5,
        variancePercent: expect.closeTo(25, 3),
        alertLevel: 'critical',
      }),
    ]);
  });
});
