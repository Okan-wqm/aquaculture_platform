/**
 * Feeding record tenant isolation and read-after-write tests.
 *
 * WHY: Feeding is a high-risk mobile write path for "DB has the row but the
 * frontend cannot see it" bugs. One command writes a feeding record, updates
 * batch feed totals, deducts the STORAGE LEDGER (single stock truth — stock
 * SSoT Phase 2: lot decrement + Feed.quantity roll-up + LowStockDetected from
 * the sink), and enqueues outbox events inside a QueryRunner transaction. This
 * contract proves those writes stay in the active tenant schema and are
 * immediately queryable by tenant-scoped reads.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, Repository } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { BatchLocation } from '../../batch/entities/batch-location.entity';
import { TankAllocation } from '../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankOperation } from '../../batch/entities/tank-operation.entity';
import { Department } from '../../department/entities/department.entity';
import { Feed, FeedStatus, FeedType, FloatingType } from '../../feed/entities/feed.entity';
import { CreateFeedingRecordCommand } from '../../feeding/commands/create-feeding-record.command';
import { DailyFeedingExecution } from '../../feeding/entities/daily-feeding-execution.entity';
import { FeedingProgramTank } from '../../feeding/entities/feeding-program-tank.entity';
import { FeedingProgram } from '../../feeding/entities/feeding-program.entity';
import {
  FeedingRecord,
  FeedingMethod,
  FishAppetite,
} from '../../feeding/entities/feeding-record.entity';
import { CreateFeedingRecordHandler } from '../../feeding/handlers/create-feeding-record.handler';
import { GetFeedingRecordsHandler } from '../../feeding/query-handlers/get-feeding-records.handler';
import { GetFeedingSummaryHandler } from '../../feeding/query-handlers/get-feeding-summary.handler';
import { GetFeedingRecordsQuery } from '../../feeding/queries/get-feeding-records.query';
import { GetFeedingSummaryQuery } from '../../feeding/queries/get-feeding-summary.query';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { FinanceSettings } from '../../finance/entities/finance-settings.entity';
import { Species } from '../../species/entities/species.entity';
import { Site } from '../../site/entities/site.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { StockMutationLockAuthority } from '../../storage/services/stock-mutation-lock.authority';
import { LotMixService } from '../../storage/services/lot-mix.service';
import {
  StorageLocation,
  StorageLocationType,
} from '../../storage/entities/storage-location.entity';
import { StorageInventory, StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StockMovement } from '../../storage/entities/stock-movement.entity';
import { StorageLotMix } from '../../storage/entities/storage-lot-mix.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { SubSystem } from '../../system/entities/sub-system.entity';
import { System } from '../../system/entities/system.entity';
import {
  FeedingDayPlan,
  FeedingDayPlanStatus,
} from '../../feeding-protocol/entities/feeding-day-plan.entity';
import { FeedingMeal } from '../../feeding-protocol/entities/feeding-meal.entity';
import { FeedingUnitType } from '../../feeding-protocol/entities/protocol-assignment.entity';
import { FcrResolvedSource } from '../../feeding-protocol/entities/feeding-protocol-v2.entity';
import {
  applyTenantMigrationAuthorities,
  createFarmOutboxTable,
  createSourceEquipmentTypesReferenceTable,
  createTenantSchemaFromSource,
} from './helpers/tenant-schema-harness';
import {
  createFarmDurableMutationTestComposition,
  type FarmDurableMutationTestComposition,
} from '../support/durable-mutation-test-authority';
import {
  createBatchCommandTestHarness,
  type BatchCommandTestHarness,
} from './helpers/batch-command-test-harness';
import { createFeedingRecordCommandTestHandler } from './helpers/feeding-operation-test-harness';
import { createStockedTenantFixtureV1 } from './helpers/stocked-tenant-fixture';
import { CreateFeedingHistoricalProvenanceAuthority1808900000000 } from '../../database/migrations/1808900000000-CreateFeedingHistoricalProvenanceAuthority';
import { CreateFeedingRecordWriteProvenanceAuthority1810000000000 } from '../../database/migrations/1810000000000-CreateFeedingRecordWriteProvenanceAuthority';

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const TENANT_B = '7c2f4e10-3d2a-4b4e-9f18-f8b16f0d5a10';
const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';
const FEED_ID = '10000000-0000-4000-8000-000000000003';
const TENANT_BUSINESS_TABLES = [
  'sites',
  'departments',
  'systems',
  'sub_systems',
  'equipment',
  'equipment_systems',
  'tanks',
  'species',
  'batches_v2',
  'batch_documents',
  'batch_locations',
  'tank_allocations',
  'tank_batches',
  'tank_operations',
  'suppliers',
  'feeds',
  'storage_locations',
  'storage_inventory',
  'stock_movements',
  'storage_lot_mixes',
  'feeding_records',
  'finance_settings',
  'feeding_programs',
  'feeding_program_tanks',
  'feeding_day_plans',
  'feeding_meals',
  'daily_feeding_executions',
] as const;

interface TenantFixture {
  site: Site;
  department: Department;
  species: Species;
  tank: Tank;
  batch: Batch;
  feed: Feed;
  storageLocation: StorageLocation;
  storageLot: StorageInventory;
}

jest.setTimeout(120_000);

describe('Feeding record tenant isolation on real Postgres', () => {
  let pg: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let batchRepository: Repository<Batch>;
  let feedRepository: Repository<Feed>;
  let mutationComposition: FarmDurableMutationTestComposition;
  let batchCommands: BatchCommandTestHarness;
  let createFeedingRecord: CreateFeedingRecordHandler;
  let getFeedingRecords: GetFeedingRecordsHandler;
  let getFeedingSummary: GetFeedingSummaryHandler;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    await createFarmOutboxTable(pg.dataSource);
    await createSourceEquipmentTypesReferenceTable(pg.dataSource);

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-feeding-record-${randomBytes(4).toString('hex')}`,
      entities: [
        Site,
        Department,
        System,
        SubSystem,
        Equipment,
        EquipmentSystem,
        EquipmentType,
        Tank,
        Species,
        Batch,
        BatchDocument,
        BatchLocation,
        TankAllocation,
        TankBatch,
        TankOperation,
        Feed,
        Supplier,
        StorageLocation,
        StorageInventory,
        StockMovement,
        StorageLotMix,
        FeedingRecord,
        FinanceSettings,
        FeedingProgram,
        FeedingProgramTank,
        FeedingDayPlan,
        FeedingMeal,
        DailyFeedingExecution,
        FarmOutbox,
      ],
      synchronize: true,
      logging: false,
      extra: {
        options: '-c search_path=farm,public',
      },
    });

    await dataSource.initialize();
    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();

    await createTenantSchemaFromSource(
      dataSource,
      getTenantSchemaName(TENANT_A),
      TENANT_BUSINESS_TABLES,
    );
    await createTenantSchemaFromSource(
      dataSource,
      getTenantSchemaName(TENANT_B),
      TENANT_BUSINESS_TABLES,
    );
    // Promote both empty tenant schemas through the production append-only
    // provenance authority before live aggregates are created. Day plans are
    // then created through FeedingAggregateMutationPort, which atomically
    // appends the policy proof required by the migration's projection guard.
    await installFeedingProvenanceAuthorities(TENANT_A);
    await installFeedingProvenanceAuthorities(TENANT_B);

    batchRepository = dataSource.getRepository(Batch);
    feedRepository = dataSource.getRepository(Feed);

    const outboxPublisher = new OutboxPublisher(FarmOutbox);
    mutationComposition = await createFarmDurableMutationTestComposition();
    batchCommands = createBatchCommandTestHarness({
      dataSource,
      batchMutations: mutationComposition.batchMutations,
      feedingMutations: mutationComposition.feedingMutations,
      outboxPublisher,
    });
    // REAL sink: storage-tracked feed → FEFO lot decrement + roll-up +
    // LowStockDetected all inside the feeding transaction.
    const stockMovementService = new StockMovementService(
      new LotMixService(),
      new SiteAuthorizationService(),
      outboxPublisher,
      new StockMutationLockAuthority(),
    );
    // P-05 tek yem yazma yolu: handler artık GERÇEK FeedingLedgerService'e
    // delege eder (kayıt + batch aggregate + FEFO düşüm + outbox tek noktada).
    // The command enters through the current operation port and binds the
    // immutable local-day plan/FCR snapshot before the ledger write.
    createFeedingRecord = createFeedingRecordCommandTestHandler({
      dataSource,
      feedingMutations: mutationComposition.feedingMutations,
      batchMutations: mutationComposition.batchMutations,
      stockMovementService,
      outboxPublisher,
    });
    getFeedingRecords = new GetFeedingRecordsHandler(dataSource);
    getFeedingSummary = new GetFeedingSummaryHandler(dataSource);
  });

  afterAll(async () => {
    await mutationComposition?.close();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await shutdownHarness(pg);
  });

  it('keeps feeding writes, inventory deduction, and outbox events isolated per tenant', async () => {
    const fixtureA = await createFeedingTenantFixture(TENANT_A);
    const fixtureB = await createFeedingTenantFixture(TENANT_B);

    await withTenantContext(TENANT_A, () =>
      createFeedingRecord.execute(
        new CreateFeedingRecordCommand(
          TENANT_A,
          {
            batchId: fixtureA.batch.id,
            tankId: fixtureA.tank.id,
            feedingDate: new Date('2026-04-29T00:00:00.000Z'),
            feedingTime: '08:00',
            feedingSequence: 1,
            totalMealsToday: 2,
            feedId: fixtureA.feed.id,
            feedBatchNumber: 'LOT-SHARED-01',
            plannedAmount: 8,
            actualAmount: 10,
            wasteAmount: 1,
            feedingMethod: FeedingMethod.MANUAL,
            fishBehavior: {
              appetite: FishAppetite.GOOD,
              feedingIntensity: 8,
            },
            fedBy: USER_ID,
            notes: 'tenant-a morning feeding',
          },
          USER_ID,
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ),
      ),
    );

    expect(
      await withTenantContext(TENANT_A, () =>
        dataSource!.manager.count(FeedingRecord, { where: { tenantId: TENANT_A } }),
      ),
    ).toBe(1);
    expect(
      await withTenantContext(TENANT_B, () =>
        dataSource!.manager.count(FeedingRecord, { where: { tenantId: TENANT_B } }),
      ),
    ).toBe(0);
    expect(await sourceTenantRowCount('feeding_records', TENANT_A)).toBe(0);

    const tenantABatch = await withTenantContext(TENANT_A, () =>
      batchRepository.findOneOrFail({ where: { id: fixtureA.batch.id, tenantId: TENANT_A } }),
    );
    const tenantALot = await withTenantContext(TENANT_A, () =>
      dataSource!.manager.findOneOrFail(StorageInventory, {
        where: { id: fixtureA.storageLot.id, tenantId: TENANT_A },
      }),
    );
    const tenantBLot = await withTenantContext(TENANT_B, () =>
      dataSource!.manager.findOneOrFail(StorageInventory, {
        where: { id: fixtureB.storageLot.id, tenantId: TENANT_B },
      }),
    );
    const tenantAFeed = await withTenantContext(TENANT_A, () =>
      feedRepository.findOneOrFail({ where: { id: fixtureA.feed.id, tenantId: TENANT_A } }),
    );
    const tenantBFeed = await withTenantContext(TENANT_B, () =>
      feedRepository.findOneOrFail({ where: { id: fixtureB.feed.id, tenantId: TENANT_B } }),
    );

    expect(Number(tenantABatch.totalFeedConsumed)).toBe(10);
    expect(Number(tenantABatch.totalFeedCost)).toBe(25);
    // Storage ledger is the single stock truth: lot decremented, roll-up +
    // status recomputed by the sink, neighbour tenant untouched.
    expect(Number(tenantALot.quantity)).toBe(40);
    expect(Number(tenantAFeed.quantity)).toBe(40);
    expect(tenantAFeed.status).toBe(FeedStatus.LOW_STOCK);
    expect(Number(tenantBLot.quantity)).toBe(50);
    expect(Number(tenantBFeed.quantity)).toBe(50);
    expect(tenantBFeed.status).toBe(FeedStatus.AVAILABLE);
    expect(
      await withTenantContext(TENANT_A, () =>
        dataSource!.manager.count(StockMovement, { where: { tenantId: TENANT_A } }),
      ),
    ).toBe(1);
    expect(
      await withTenantContext(TENANT_B, () =>
        dataSource!.manager.count(StockMovement, { where: { tenantId: TENANT_B } }),
      ),
    ).toBe(0);

    const tenantARecords = await withTenantContext(TENANT_A, () =>
      getFeedingRecords.execute(
        new GetFeedingRecordsQuery(
          TENANT_A,
          { batchId: fixtureA.batch.id, tankId: fixtureA.tank.id, feedId: fixtureA.feed.id },
          1,
          10,
          'feedingDate',
          'DESC',
        ),
      ),
    );
    const tenantBRecordsForTenantAIds = await withTenantContext(TENANT_B, () =>
      getFeedingRecords.execute(
        new GetFeedingRecordsQuery(
          TENANT_B,
          { batchId: fixtureA.batch.id, tankId: fixtureA.tank.id, feedId: fixtureA.feed.id },
          1,
          10,
          'feedingDate',
          'DESC',
        ),
      ),
    );
    const tenantASummary = await withTenantContext(TENANT_A, () =>
      getFeedingSummary.execute(
        new GetFeedingSummaryQuery(
          TENANT_A,
          'batch',
          fixtureA.batch.id,
          new Date('2026-04-29T00:00:00.000Z'),
          new Date('2026-04-30T00:00:00.000Z'),
        ),
      ),
    );

    expect(tenantARecords.data).toHaveLength(1);
    expect(Number(tenantARecords.data[0]?.actualAmount)).toBe(10);
    expect(tenantBRecordsForTenantAIds.data).toHaveLength(0);
    expect(tenantASummary.totalFeedingsCount).toBe(1);
    expect(tenantASummary.totalActualKg).toBe(10);
    expect(tenantASummary.totalFeedCost).toBe(25);
    expect(tenantASummary.feedTypeDistribution).toEqual([
      {
        feedId: fixtureA.feed.id,
        feedName: 'Shared Salmon Feed',
        totalKg: 10,
        cost: 25,
        percentage: 100,
      },
    ]);

    const tenantAOutboxRows = await outboxRows(TENANT_A);
    const tenantBOutboxRows = await outboxRows(TENANT_B);
    expect(tenantAOutboxRows.map((row) => row.eventType).sort()).toEqual([
      'BatchAllocatedToTank',
      'BatchCreated',
      'FeedingRecorded',
      'LowStockDetected',
      'StockMovementRecorded',
    ]);
    expect(tenantBOutboxRows.map((row) => row.eventType).sort()).toEqual([
      'BatchAllocatedToTank',
      'BatchCreated',
    ]);
    expect(tenantAOutboxRows.every((row) => row.payload?.tenantId === TENANT_A)).toBe(true);
  });

  async function createFeedingTenantFixture(tenantId: string): Promise<TenantFixture> {
    const { site, department, species, tank, batch } = await createStockedTenantFixtureV1(
      dataSource!,
      batchCommands,
      {
        tenantId,
        codePrefix: 'FEEDING',
        userId: USER_ID,
      },
    );
    const dayPlanId = await runInTenantTransaction(
      dataSource!,
      'farm',
      tenantId,
      (_queryRunner, session) =>
        mutationComposition.feedingMutations.createDayPlanIfAbsent(session, {
          assignmentId: '10000000-0000-4000-8000-000000000001',
          protocolId: '10000000-0000-4000-8000-000000000002',
          unitId: tank.id,
          siteId: site.id,
          unitType: FeedingUnitType.TANK,
          unitName: tank.name,
          unitCode: tank.code,
          planDate: '2026-04-29',
          snapshot: {
            avgWeightG: 10,
            fishCount: 100,
            biomassKg: 1,
            waterTempC: null,
            temperatureSource: 'none',
            usingDefaultTemperature: true,
            bandIndex: 0,
            feed: { id: FEED_ID, code: 'FEED-SHARED', name: 'Shared Salmon Feed' },
            baseRatePercent: 2,
            tempMultiplier: 1,
            effectiveRatePercent: 2,
            expectedFcr: 1.25,
            fcrResolvedSource: FcrResolvedSource.BAND,
          },
          resolution: {
            schemaVersion: 'protocol-resolution/v1',
            resolvedAt: '2026-04-29T00:00:00.000Z',
            bandIndex: 0,
            feed: { id: FEED_ID, code: 'FEED-SHARED', name: 'Shared Salmon Feed' },
            baseRatePercent: 2,
            tempMultiplier: 1,
            effectiveRatePercent: 2,
            expectedFcr: 1.25,
            fcrResolvedSource: FcrResolvedSource.BAND,
            bandBasisWeightG: 10,
            waterTempC: null,
            temperatureSource: 'none',
          },
          plannedTotalKg: 8,
          mealsPlanned: 2,
          status: FeedingDayPlanStatus.PLANNED,
          growthPolicyVersion: 1,
          growthApplicationMode: 'per_meal',
        }),
    );
    expect(dayPlanId).not.toBeNull();
    const feed = await withTenantContext(tenantId, () =>
      feedRepository.save(
        feedRepository.create({
          id: FEED_ID,
          tenantId,
          name: 'Shared Salmon Feed',
          code: 'FEED-SHARED',
          type: FeedType.GROWER,
          targetSpecies: 'SALMON',
          floatingType: FloatingType.FLOATING,
          status: FeedStatus.AVAILABLE,
          quantity: 50,
          minStock: 45,
          pricePerKg: 2.5,
          currency: 'USD',
          isActive: true,
          isDeleted: false,
          createdBy: USER_ID,
          updatedBy: USER_ID,
        }),
      ),
    );
    const storageLocation = await withTenantContext(tenantId, () =>
      dataSource!.manager.save(
        dataSource!.manager.create(StorageLocation, {
          tenantId,
          siteId: site.id,
          name: 'Feed Warehouse',
          code: 'FEED-WH',
          type: StorageLocationType.WAREHOUSE,
          capacityUnit: 'kg',
          usedCapacity: 0,
          isActive: true,
          isDeleted: false,
          createdBy: USER_ID,
          updatedBy: USER_ID,
        }),
      ),
    );
    const storageLot = await withTenantContext(tenantId, () =>
      dataSource!.manager.save(
        dataSource!.manager.create(StorageInventory, {
          tenantId,
          storageLocationId: storageLocation.id,
          itemType: StorageItemType.FEED,
          itemId: feed.id,
          quantity: 50,
          unit: 'kg',
          lotNumber: 'LOT-SHARED-01',
          receivedDate: new Date('2026-04-01T00:00:00.000Z'),
          createdBy: USER_ID,
          updatedBy: USER_ID,
        }),
      ),
    );

    return { site, department, species, tank, batch, feed, storageLocation, storageLot };
  }

  async function sourceTenantRowCount(table: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource!.query(
      `SELECT COUNT(*)::text AS count FROM "farm"."${table}" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function installFeedingProvenanceAuthorities(tenantId: string): Promise<void> {
    await applyTenantMigrationAuthorities(dataSource!, getTenantSchemaName(tenantId), [
      new CreateFeedingHistoricalProvenanceAuthority1808900000000(),
      new CreateFeedingRecordWriteProvenanceAuthority1810000000000(),
    ]);
  }

  async function outboxRows(
    tenantId: string,
  ): Promise<Array<{ eventType: string; payload: { tenantId?: string } }>> {
    return dataSource!.query(
      `SELECT "eventType", "payload" FROM "farm"."outbox_events" WHERE "tenantId" = $1 ORDER BY "eventType" ASC`,
      [tenantId],
    );
  }
});
