/**
 * A weighing reaches the feeding ration, against a real PostgreSQL
 * (FARM-CRITICAL-454, FARM-MEDIUM-453).
 *
 * ## The defect being pinned
 *
 * Every ration path sizes a tank's feed from its `tank_batches` row: the 06:00
 * day plan (`feeding-cron-v2.service.ts` computePlanFor), the intra-day recalc
 * (`DayPlanRecalcService.recalcForUnit`) and the feed forecast. The growth-sample
 * writers wrote the sample to `Batch.weight.actual` and stopped, so the only
 * writer of a stocked tank's weight was the FCR projection. Weighing fish at
 * three times their stocking weight changed no meal, no band and no feed.
 *
 * ## What is asserted
 *
 * - A weighing re-bases the weighed batch's share of its tank onto the measured
 *   average, and the tank's live day plan is repriced from it in the same
 *   transaction: the remaining meals, the band and the feed (an automatic band
 *   transition), plus the farm-stock read model the apps show.
 * - A weighing dated before the batch's last weighing moves neither the batch's
 *   `weight.actual` nor the tank (FARM-MEDIUM-453); it stays as history.
 * - A batch split across two tanks: a sample that does not name its tank is
 *   refused, and a sample that names one moves that tank's share only.
 *
 * ## Why this needs a real database
 *
 * The unit specs double the EntityManager. Here the batch is stocked, moved and
 * weighed through the production command handlers, the unit lookup runs as SQL,
 * and the day plan is written by the production day-plan writer and repriced by
 * the production recalc.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { Role } from '@aquaculture/backend-common/decorators';
import { collaborator } from '@aquaculture/testing';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TransferBatchCommand } from '../../batch/commands/transfer-batch.command';
import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import {
  FeedingDayPlan,
  FeedingDayPlanStatus,
} from '../../feeding-protocol/entities/feeding-day-plan.entity';
import { FeedingMeal } from '../../feeding-protocol/entities/feeding-meal.entity';
import {
  FcrResolvedSource,
  FeedingProtocolStatus,
  FeedingProtocolV2,
  ProtocolFcrSource,
} from '../../feeding-protocol/entities/feeding-protocol-v2.entity';
import {
  FeedingUnitType,
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../../feeding-protocol/entities/protocol-assignment.entity';
import { MealPlanGeneratorService } from '../../feeding-protocol/services/meal-plan-generator.service';
import { ProtocolRateService } from '../../feeding-protocol/services/protocol-rate.service';
import { ProtocolResolutionService } from '../../feeding-protocol/services/protocol-resolution.service';
import { RecordGrowthSampleCommand } from '../../growth/commands/record-growth-sample.command';
import { GrowthMeasurement } from '../../growth/entities/growth-measurement.entity';
import {
  createFarmTenantFixture,
  createFixtureBatchRecorders,
  createFixtureBatchWriters,
  createFixtureTank,
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

const USER_ID = '6c2f4e8a-1b3d-4f5a-9c7e-0d2b4a6c8e1f';

const RATION_TENANT = '0b6e3a9d-4c1f-4e27-8a5b-9d3c7f1e2a64';
const OUT_OF_ORDER_TENANT = '7d1a5c3e-9b2f-4a68-b0e4-3f6a8c2d1e95';
const SPLIT_TENANT = 'c4e8a2f6-3d7b-4915-8e0a-6b2d9f4c1a73';

const STARTER_FEED = '1f0c9e8d-7b6a-4543-8211-0fedcba98765';
const GROWER_FEED = '2e1dafe9-8c7b-4654-9322-10fedcba9876';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Two bands: below 25 g the starter at 3% of biomass a day, from 25 g the
 * grower at 1.5%. A 1 g hysteresis buffer, automatic transitions, no
 * temperature table (multiplier 1).
 */
const BANDS = [
  {
    minWeightG: 0,
    maxWeightG: 25,
    feedId: STARTER_FEED,
    feedCode: 'STARTER',
    feedName: 'Starter 1mm',
    feedingRatePercent: 3,
    expectedFcr: 1.0,
  },
  {
    minWeightG: 25,
    maxWeightG: 1000,
    feedId: GROWER_FEED,
    feedCode: 'GROWER',
    feedName: 'Grower 3mm',
    feedingRatePercent: 1.5,
    expectedFcr: 1.2,
  },
];

describe('A weighing reaches the feeding ration — real Postgres (FARM-CRITICAL-454)', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let writers: FixtureBatchWriters;
  let recorders: FixtureBatchRecorders;
  // Only persistDayPlan runs here, and it touches neither collaborator.
  const dayPlanWriter = new MealPlanGeneratorService(
    collaborator<ProtocolRateService>({}, 'ProtocolRateService'),
    collaborator<ProtocolResolutionService>({}, 'ProtocolResolutionService'),
  );

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-weighing-ration-${randomBytes(4).toString('hex')}`,
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

    writers = createFixtureBatchWriters(dataSource);
    recorders = createFixtureBatchRecorders(dataSource);

    for (const tenantId of [RATION_TENANT, OUT_OF_ORDER_TENANT, SPLIT_TENANT]) {
      await createTenantSchemaDerived(dataSource, getTenantSchemaName(tenantId));
    }
  }, 240_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  /** Records a 3-fish sample at `weightG` through the production handler. */
  async function weigh(
    tenantId: string,
    batchId: string,
    weightG: number,
    measurementDate: Date,
    populationSize: number,
    tankId?: string,
  ): Promise<GrowthMeasurement> {
    return withTenantContext(tenantId, () =>
      recorders.recordGrowthSample.execute(
        new RecordGrowthSampleCommand(
          tenantId,
          {
            batchId,
            ...(tankId !== undefined ? { tankId } : {}),
            measurementDate,
            populationSize,
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

  async function tankRow(tenantId: string, tankId: string): Promise<TankBatch> {
    return withTenantContext(tenantId, () =>
      dataSource.manager.findOneOrFail(TankBatch, { where: { tenantId, tankId } }),
    );
  }

  async function batchRow(tenantId: string, batchId: string): Promise<Batch> {
    return withTenantContext(tenantId, () =>
      dataSource.manager.findOneOrFail(Batch, { where: { tenantId, id: batchId } }),
    );
  }

  /**
   * A protocol, an ACTIVE assignment on the starter band and today's day plan
   * with two scheduled meals (40% / 60%), sized from the tank as stocked.
   */
  async function planFeeding(
    fixture: FarmTenantFixture,
    tenantId: string,
    stockedBiomassKg: number,
    fishCount: number,
  ): Promise<string> {
    const manager = dataSource.manager;
    const protocol = await withTenantContext(tenantId, () =>
      manager.save(
        manager.create(FeedingProtocolV2, {
          tenantId,
          name: 'Salmon fry two-band',
          status: FeedingProtocolStatus.ACTIVE,
          bands: BANDS,
          defaultMealSchedule: {
            mealsPerDay: 2,
            entries: [
              { time: '08:00', percentOfDaily: 40 },
              { time: '16:00', percentOfDaily: 60 },
            ],
          },
          settings: {
            autoTransition: true,
            transitionBufferG: 1,
            growthApplicationMode: 'per_meal',
            underfeedAlertThresholdPercent: -20,
            fcrSource: ProtocolFcrSource.BAND,
          },
          isDefault: false,
          isDeleted: false,
        }),
      ),
    );
    const assignment = await withTenantContext(tenantId, () =>
      manager.save(
        manager.create(ProtocolAssignment, {
          tenantId,
          unitId: fixture.tank.id,
          unitType: FeedingUnitType.TANK,
          unitName: fixture.tank.name,
          unitCode: fixture.tank.code,
          siteId: fixture.site.id,
          protocolId: protocol.id,
          status: ProtocolAssignmentStatus.ACTIVE,
          effectiveFrom: new Date(Date.now() - 2 * DAY_MS),
          overrides: {},
          suspensions: [],
          currentFeedId: STARTER_FEED,
          currentBandIndex: 0,
          totalTransitions: 0,
        }),
      ),
    );

    const dailyKg = (stockedBiomassKg * 3) / 100;
    const today = new Date().toISOString().slice(0, 10);
    const resolution = {
      resolvedAt: new Date().toISOString(),
      bandIndex: 0,
      feed: { id: STARTER_FEED, code: 'STARTER', name: 'Starter 1mm' },
      baseRatePercent: 3,
      tempMultiplier: 1,
      effectiveRatePercent: 3,
      expectedFcr: 1.0,
      fcrResolvedSource: FcrResolvedSource.BAND,
      bandBasisWeightG: (stockedBiomassKg * 1000) / fishCount,
      waterTempC: 12,
      temperatureSource: 'manual' as const,
    };
    const dayPlanId = await withTenantContext(tenantId, () =>
      dayPlanWriter.persistDayPlan(
        manager,
        {
          tenantId,
          assignmentId: assignment.id,
          protocolId: protocol.id,
          unitId: fixture.tank.id,
          siteId: fixture.site.id,
          unitType: FeedingUnitType.TANK,
          unitName: fixture.tank.name,
          unitCode: fixture.tank.code,
          planDate: today,
          growthApplicationMode: 'per_meal',
        },
        {
          snapshot: {
            avgWeightG: resolution.bandBasisWeightG,
            fishCount,
            biomassKg: stockedBiomassKg,
            waterTempC: 12,
            temperatureSource: 'manual',
            usingDefaultTemperature: false,
            bandIndex: 0,
            feed: resolution.feed,
            baseRatePercent: 3,
            tempMultiplier: 1,
            effectiveRatePercent: 3,
            expectedFcr: 1.0,
            fcrResolvedSource: FcrResolvedSource.BAND,
            mixedBatch: false,
            weightCvPercent: null,
          },
          resolution,
          plannedTotalKg: dailyKg,
          status: FeedingDayPlanStatus.PLANNED,
          meals: [
            {
              mealIndex: 0,
              scheduledAt: new Date(Date.now() + 2 * HOUR_MS),
              percentOfDaily: 40,
              plannedKg: dailyKg * 0.4,
              feedId: STARTER_FEED,
            },
            {
              mealIndex: 1,
              scheduledAt: new Date(Date.now() + 6 * HOUR_MS),
              percentOfDaily: 60,
              plannedKg: dailyKg * 0.6,
              feedId: STARTER_FEED,
            },
          ],
        },
      ),
    );
    if (dayPlanId === null) throw new Error('the day plan was not written');
    return dayPlanId;
  }

  describe('a stocked tank on a live day plan, weighed without naming the tank', () => {
    let fixture: FarmTenantFixture;
    let dayPlanId: string;
    const weighedAt = new Date(Date.now() - HOUR_MS);

    beforeAll(async () => {
      // 1000 fish at 10 g: 10 kg, the starter band, 0.3 kg a day.
      fixture = await createFarmTenantFixture(dataSource, writers, {
        tenantId: RATION_TENANT,
        codePrefix: 'RATION',
        userId: USER_ID,
        initialQuantity: 1000,
        initialAvgWeightG: 10,
      });
      dayPlanId = await planFeeding(fixture, RATION_TENANT, 10, 1000);

      // The fish weigh 30 g, three times what the tank row says.
      await weigh(RATION_TENANT, fixture.batch.id, 30, weighedAt, 1000);
    });

    it("moves the tank's weight and biomass to the measured average", async () => {
      const unit = await tankRow(RATION_TENANT, fixture.tank.id);

      expect(Number(unit.avgWeightG)).toBe(30);
      expect(Number(unit.totalBiomassKg)).toBe(30);
      expect(unit.totalQuantity).toBe(1000);
      expect(unit.batchDetails).toEqual([
        expect.objectContaining({ batchId: fixture.batch.id, quantity: 1000, avgWeightG: 30 }),
      ]);
      expect(unit.lastSamplingAt?.getTime()).toBe(weighedAt.getTime());
    });

    it('reprices the remaining meals from the measured biomass, on the next band and feed', async () => {
      const meals = await withTenantContext(RATION_TENANT, () =>
        dataSource.manager.find(FeedingMeal, {
          where: { tenantId: RATION_TENANT, dayPlanId },
          order: { mealIndex: 'ASC' },
        }),
      );
      // 30 kg x 1.5% = 0.45 kg a day, split 40/60.
      expect(meals.map((meal) => Number(meal.plannedKg))).toEqual([0.18, 0.27]);
      expect(meals.map((meal) => meal.feedId)).toEqual([GROWER_FEED, GROWER_FEED]);

      const plan = await withTenantContext(RATION_TENANT, () =>
        dataSource.manager.findOneOrFail(FeedingDayPlan, {
          where: { tenantId: RATION_TENANT, id: dayPlanId },
        }),
      );
      expect(Number(plan.plannedTotalKg)).toBe(0.45);
      expect(plan.resolution.bandIndex).toBe(1);
      expect(plan.resolution.bandBasisWeightG).toBe(30);
      expect(plan.recalcLog.map((entry) => entry.reason)).toEqual(['growth_sample']);

      const assignment = await withTenantContext(RATION_TENANT, () =>
        dataSource.manager.findOneOrFail(ProtocolAssignment, {
          where: { tenantId: RATION_TENANT, unitId: fixture.tank.id },
        }),
      );
      expect(assignment.currentFeedId).toBe(GROWER_FEED);
      expect(assignment.currentBandIndex).toBe(1);

      const transitions: Array<{ count: string }> = await dataSource.manager.query(
        `SELECT count(*) AS "count" FROM "farm"."outbox_events"
          WHERE "tenantId" = $1 AND "eventType" = 'FeedTypeTransitioned'`,
        [RATION_TENANT],
      );
      expect(Number(transitions[0]?.count)).toBe(1);
    });

    it('refreshes the farm-stock read model the apps show', async () => {
      // Read inside the tenant context, as the farmStockInventory query does.
      const rows: Array<{ biomass: string }> = await withTenantContext(RATION_TENANT, () =>
        dataSource.manager.query(
          `SELECT "currentBiomassKg" AS "biomass"
             FROM farm_stock_container_snapshots
            WHERE "tenantId" = $1 AND "containerId" = $2`,
          [RATION_TENANT, fixture.tank.id],
        ),
      );
      expect(rows.map((row) => Number(row.biomass))).toEqual([30]);
    });
  });

  describe('a sample dated before the last weighing (FARM-MEDIUM-453)', () => {
    let fixture: FarmTenantFixture;
    const latest = new Date(Date.now() - DAY_MS);
    const older = new Date(Date.now() - 5 * DAY_MS);

    beforeAll(async () => {
      fixture = await createFarmTenantFixture(dataSource, writers, {
        tenantId: OUT_OF_ORDER_TENANT,
        codePrefix: 'ORDER',
        userId: USER_ID,
        initialQuantity: 100,
        initialAvgWeightG: 10,
      });
      await weigh(OUT_OF_ORDER_TENANT, fixture.batch.id, 30, latest, 100, fixture.tank.id);
      // Entered afterwards, dated four days earlier.
      await weigh(OUT_OF_ORDER_TENANT, fixture.batch.id, 20, older, 100, fixture.tank.id);
    });

    it("leaves the batch's weight.actual on the latest weighing", async () => {
      const batch = await batchRow(OUT_OF_ORDER_TENANT, fixture.batch.id);

      expect(batch.weight.actual.avgWeight).toBe(30);
      expect(new Date(batch.weight.actual.lastMeasuredAt).getTime()).toBe(latest.getTime());
    });

    it('leaves the tank on the latest weighing', async () => {
      const unit = await tankRow(OUT_OF_ORDER_TENANT, fixture.tank.id);

      expect(Number(unit.avgWeightG)).toBe(30);
      expect(Number(unit.totalBiomassKg)).toBe(3);
      expect(unit.lastSamplingAt?.getTime()).toBe(latest.getTime());
    });

    it('keeps the older sample as history', async () => {
      const samples = await withTenantContext(OUT_OF_ORDER_TENANT, () =>
        dataSource.manager.find(GrowthMeasurement, {
          where: { tenantId: OUT_OF_ORDER_TENANT, batchId: fixture.batch.id },
          order: { measurementDate: 'ASC' },
        }),
      );
      expect(samples.map((sample) => Number(sample.averageWeight))).toEqual([20, 30]);
    });
  });

  describe('a batch split across two tanks', () => {
    let fixture: FarmTenantFixture;
    let secondTankId: string;

    beforeAll(async () => {
      // 100 fish at 10 g, 40 of them moved to a second tank.
      fixture = await createFarmTenantFixture(dataSource, writers, {
        tenantId: SPLIT_TENANT,
        codePrefix: 'SPLIT',
        userId: USER_ID,
        initialQuantity: 100,
        initialAvgWeightG: 10,
      });
      const second = await createFixtureTank(dataSource, fixture.department, {
        tenantId: SPLIT_TENANT,
        code: 'SPLIT-TANK2',
        userId: USER_ID,
        count: 0,
        biomassKg: 0,
      });
      secondTankId = second.id;
      await withTenantContext(SPLIT_TENANT, () =>
        writers.transferBatch.execute(
          new TransferBatchCommand(
            SPLIT_TENANT,
            fixture.batch.id,
            {
              sourceTankId: fixture.tank.id,
              destinationTankId: secondTankId,
              quantity: 40,
              transferredAt: new Date(Date.now() - 2 * DAY_MS),
              transferReason: 'weighing fixture: batch split across tanks',
            },
            USER_ID,
            [Role.MODULE_MANAGER],
            [],
            {
              clientCommandId: randomUUID(),
              payloadHash: 'e'.repeat(64),
              operationType: 'transferBatch',
            },
          ),
        ),
      );
    });

    it('refuses a sample that does not name the tank it was taken from', async () => {
      await expect(
        weigh(SPLIT_TENANT, fixture.batch.id, 30, new Date(Date.now() - HOUR_MS), 40),
      ).rejects.toThrow(BadRequestException);

      // Nothing of the refused sample was written.
      const samples = await withTenantContext(SPLIT_TENANT, () =>
        dataSource.manager.count(GrowthMeasurement, {
          where: { tenantId: SPLIT_TENANT, batchId: fixture.batch.id },
        }),
      );
      expect(samples).toBe(0);
    });

    it("moves only the named tank's share", async () => {
      await weigh(
        SPLIT_TENANT,
        fixture.batch.id,
        30,
        new Date(Date.now() - HOUR_MS),
        40,
        secondTankId,
      );

      const weighed = await tankRow(SPLIT_TENANT, secondTankId);
      expect(Number(weighed.avgWeightG)).toBe(30);
      expect(Number(weighed.totalBiomassKg)).toBe(1.2);

      const untouched = await tankRow(SPLIT_TENANT, fixture.tank.id);
      expect(Number(untouched.avgWeightG)).toBe(10);
      expect(Number(untouched.totalBiomassKg)).toBe(0.6);
    });
  });
});
