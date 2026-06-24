/**
 * Feeding record tenant isolation and read-after-write tests.
 *
 * WHY: Feeding is a high-risk mobile write path for "DB has the row but the
 * frontend cannot see it" bugs. One command writes a feeding record, updates
 * batch feed totals, deducts feed inventory, and enqueues outbox events inside
 * a QueryRunner transaction. This contract proves those writes stay in the
 * active tenant schema and are immediately queryable by tenant-scoped reads.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Batch, BatchInputType, BatchStatus } from '../../batch/entities/batch.entity';
import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { TankAllocation, AllocationType } from '../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankOperation } from '../../batch/entities/tank-operation.entity';
import { BatchService } from '../../batch/services/batch.service';
import { BatchDomainService } from '../../batch/services/batch-domain.service';
import { BatchLifecyclePolicyService } from '../../batch/services/batch-lifecycle-policy.service';
import { MortalityCullPolicyService } from '../../batch/services/mortality-cull-policy.service';
import {
  Department,
  DepartmentStatus,
  DepartmentType,
} from '../../department/entities/department.entity';
import { Feed, FeedStatus, FeedType, FloatingType } from '../../feed/entities/feed.entity';
import { CreateFeedingRecordCommand } from '../../feeding/commands/create-feeding-record.command';
import { FeedInventory, InventoryStatus } from '../../feeding/entities/feed-inventory.entity';
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
import {
  Species,
  SpeciesCategory,
  SpeciesStatus,
  SpeciesWaterType,
} from '../../species/entities/species.entity';
import { Site, SiteStatus, SiteType } from '../../site/entities/site.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import {
  Tank,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../tank/entities/tank.entity';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { LotMixService } from '../../storage/services/lot-mix.service';

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const TENANT_B = '7c2f4e10-3d2a-4b4e-9f18-f8b16f0d5a10';
const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';

interface TenantFixture {
  site: Site;
  department: Department;
  species: Species;
  tank: Tank;
  batch: Batch;
  feed: Feed;
  inventory: FeedInventory;
}

class FeedInventoryOnlyStockMovementService extends StockMovementService {
  constructor() {
    super(new LotMixService(), new SiteAuthorizationService());
  }

  override async feedHasStoragePresence(
    _manager: EntityManager,
    _tenantId: string,
    _feedId: string,
  ): Promise<boolean> {
    return false;
  }
}

jest.setTimeout(120_000);

describe('Feeding record tenant isolation on real Postgres', () => {
  let pg: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let siteRepository: Repository<Site>;
  let departmentRepository: Repository<Department>;
  let speciesRepository: Repository<Species>;
  let tankRepository: Repository<Tank>;
  let batchRepository: Repository<Batch>;
  let allocationRepository: Repository<TankAllocation>;
  let tankBatchRepository: Repository<TankBatch>;
  let operationRepository: Repository<TankOperation>;
  let feedRepository: Repository<Feed>;
  let inventoryRepository: Repository<FeedInventory>;
  let feedingRecordRepository: Repository<FeedingRecord>;
  let batchService: BatchService;
  let createFeedingRecord: CreateFeedingRecordHandler;
  let getFeedingRecords: GetFeedingRecordsHandler;
  let getFeedingSummary: GetFeedingSummaryHandler;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-feeding-record-${randomBytes(4).toString('hex')}`,
      entities: [
        Site,
        Department,
        Tank,
        Species,
        Batch,
        BatchDocument,
        TankAllocation,
        TankBatch,
        TankOperation,
        Feed,
        Supplier,
        FeedInventory,
        FeedingRecord,
        FarmOutbox,
      ],
      synchronize: true,
      logging: false,
      extra: {
        options: '-c search_path=farm,public',
      },
    });

    await dataSource.initialize();
    await createFarmOutboxTable(dataSource);

    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();

    await createTenantSchema(dataSource, getTenantSchemaName(TENANT_A));
    await createTenantSchema(dataSource, getTenantSchemaName(TENANT_B));

    siteRepository = dataSource.getRepository(Site);
    departmentRepository = dataSource.getRepository(Department);
    speciesRepository = dataSource.getRepository(Species);
    tankRepository = dataSource.getRepository(Tank);
    batchRepository = dataSource.getRepository(Batch);
    allocationRepository = dataSource.getRepository(TankAllocation);
    tankBatchRepository = dataSource.getRepository(TankBatch);
    operationRepository = dataSource.getRepository(TankOperation);
    feedRepository = dataSource.getRepository(Feed);
    inventoryRepository = dataSource.getRepository(FeedInventory);
    feedingRecordRepository = dataSource.getRepository(FeedingRecord);

    batchService = new BatchService(
      batchRepository,
      allocationRepository,
      tankBatchRepository,
      operationRepository,
      tankRepository,
      dataSource,
      new MortalityCullPolicyService(),
    );

    const outboxPublisher = new OutboxPublisher(FarmOutbox);
    const backdatePolicy = { validate: jest.fn() };
    const batchDomainService = new BatchDomainService(new BatchLifecyclePolicyService());
    const stockMovementService = new FeedInventoryOnlyStockMovementService();
    createFeedingRecord = new CreateFeedingRecordHandler(
      feedingRecordRepository,
      batchRepository,
      feedRepository,
      inventoryRepository,
      dataSource,
      outboxPublisher,
      backdatePolicy as never,
      batchDomainService,
      stockMovementService,
    );
    getFeedingRecords = new GetFeedingRecordsHandler(feedingRecordRepository);
    getFeedingSummary = new GetFeedingSummaryHandler(
      feedingRecordRepository,
      batchRepository,
      tankRepository,
      feedRepository,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await shutdownHarness(pg);
  });

  it('keeps feeding writes, inventory deduction, and outbox events isolated per tenant', async () => {
    const fixtureA = await createTenantFixture(TENANT_A);
    const fixtureB = await createTenantFixture(TENANT_B);

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
        ),
      ),
    );

    expect(await tenantRowCount('feeding_records', TENANT_A)).toBe(1);
    expect(await tenantRowCount('feeding_records', TENANT_B)).toBe(0);
    expect(await sourceTenantRowCount('feeding_records', TENANT_A)).toBe(0);

    const tenantABatch = await withTenantContext(TENANT_A, () =>
      batchRepository.findOneOrFail({ where: { id: fixtureA.batch.id, tenantId: TENANT_A } }),
    );
    const tenantAInventory = await withTenantContext(TENANT_A, () =>
      inventoryRepository.findOneOrFail({
        where: { id: fixtureA.inventory.id, tenantId: TENANT_A },
      }),
    );
    const tenantBInventory = await withTenantContext(TENANT_B, () =>
      inventoryRepository.findOneOrFail({
        where: { id: fixtureB.inventory.id, tenantId: TENANT_B },
      }),
    );

    expect(Number(tenantABatch.totalFeedConsumed)).toBe(10);
    expect(Number(tenantABatch.totalFeedCost)).toBe(25);
    expect(Number(tenantAInventory.quantityKg)).toBe(40);
    expect(Number(tenantAInventory.totalValue)).toBe(100);
    expect(tenantAInventory.status).toBe(InventoryStatus.LOW_STOCK);
    expect(Number(tenantBInventory.quantityKg)).toBe(50);
    expect(tenantBInventory.status).toBe(InventoryStatus.AVAILABLE);

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
        percentage: 100,
      },
    ]);

    const tenantAOutboxRows = await outboxRows(TENANT_A);
    const tenantBOutboxRows = await outboxRows(TENANT_B);
    expect(tenantAOutboxRows.map((row) => row.eventType).sort()).toEqual([
      'FeedInventoryLow',
      'FeedingRecorded',
    ]);
    expect(tenantBOutboxRows).toHaveLength(0);
    expect(tenantAOutboxRows.every((row) => row.payload?.tenantId === TENANT_A)).toBe(true);
  });

  async function createTenantFixture(tenantId: string): Promise<TenantFixture> {
    const site = await withTenantContext(tenantId, () =>
      siteRepository.save(
        siteRepository.create({
          tenantId,
          name: 'Feeding Site',
          code: 'FEEDING-SITE',
          type: SiteType.LAND_BASED,
          country: 'NO',
          timezone: 'UTC',
          status: SiteStatus.ACTIVE,
          isActive: true,
        }),
      ),
    );
    const department = await withTenantContext(tenantId, () =>
      departmentRepository.save(
        departmentRepository.create({
          tenantId,
          siteId: site.id,
          name: 'Feeding Department',
          code: 'FEEDING-DEPT',
          type: DepartmentType.PRODUCTION,
          status: DepartmentStatus.ACTIVE,
          isActive: true,
          isDeleted: false,
          createdBy: USER_ID,
          updatedBy: USER_ID,
        }),
      ),
    );
    const species = await withTenantContext(tenantId, () =>
      speciesRepository.save(
        speciesRepository.create({
          tenantId,
          scientificName: 'Salmo salar',
          commonName: 'Atlantic Salmon',
          code: 'SALMON',
          category: SpeciesCategory.FISH,
          waterType: SpeciesWaterType.SALTWATER,
          status: SpeciesStatus.ACTIVE,
          isActive: true,
          isCleanerFish: false,
          isDeleted: false,
          tags: [],
          createdBy: USER_ID,
          updatedBy: USER_ID,
        }),
      ),
    );
    const tank = await withTenantContext(tenantId, () =>
      tankRepository.save(
        tankRepository.create({
          tenantId,
          name: 'Feeding Tank',
          code: 'FEEDING-TANK',
          departmentId: department.id,
          tankType: TankType.CIRCULAR,
          material: TankMaterial.FIBERGLASS,
          waterType: WaterType.SALTWATER,
          diameter: 5,
          depth: 2,
          waterDepth: 2,
          maxBiomass: 1500,
          currentBiomass: 1,
          currentCount: 100,
          maxDensity: 30,
          status: TankStatus.ACTIVE,
          isActive: true,
          createdBy: USER_ID,
          updatedBy: USER_ID,
        }),
      ),
    );
    const batch = await withTenantContext(tenantId, () =>
      batchService.createBatch({
        tenantId,
        batchNumber: 'BATCH-SHARED-FEEDING',
        speciesId: species.id,
        inputType: BatchInputType.FRY,
        initialQuantity: 100,
        initialAvgWeightG: 10,
        stockedAt: new Date('2026-04-29T00:00:00.000Z'),
        currency: 'USD',
        createdBy: USER_ID,
      }),
    );
    await withTenantContext(tenantId, () =>
      batchService.allocateBatchToTank({
        tenantId,
        batchId: batch.id,
        tankId: tank.id,
        quantity: 100,
        avgWeightG: 10,
        allocationType: AllocationType.INITIAL_STOCKING,
        allocatedBy: USER_ID,
      }),
    );
    const feed = await withTenantContext(tenantId, () =>
      feedRepository.save(
        feedRepository.create({
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
    const inventory = await withTenantContext(tenantId, () =>
      inventoryRepository.save(
        inventoryRepository.create({
          tenantId,
          feedId: feed.id,
          siteId: site.id,
          departmentId: department.id,
          quantityKg: 50,
          minStockKg: 45,
          status: InventoryStatus.AVAILABLE,
          lotNumber: 'LOT-SHARED-01',
          receivedDate: new Date('2026-04-01T00:00:00.000Z'),
          unitPricePerKg: 2.5,
          totalValue: 125,
          currency: 'USD',
          createdBy: USER_ID,
          updatedBy: USER_ID,
        }),
      ),
    );

    return { site, department, species, tank, batch, feed, inventory };
  }

  async function tenantRowCount(table: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource!.query(
      `SELECT COUNT(*)::text AS count FROM "${getTenantSchemaName(tenantId)}"."${table}" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function sourceTenantRowCount(table: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource!.query(
      `SELECT COUNT(*)::text AS count FROM "farm"."${table}" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
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

async function createTenantSchema(dataSource: DataSource, schema: string): Promise<void> {
  await dataSource.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.query(`CREATE TABLE "${schema}"."sites" (LIKE "farm"."sites" INCLUDING ALL)`);
  await dataSource.query(
    `CREATE TABLE "${schema}"."departments" (LIKE "farm"."departments" INCLUDING ALL)`,
  );
  await dataSource.query(`CREATE TABLE "${schema}"."tanks" (LIKE "farm"."tanks" INCLUDING ALL)`);
  await dataSource.query(
    `CREATE TABLE "${schema}"."species" (LIKE "farm"."species" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."batches_v2" (LIKE "farm"."batches_v2" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."batch_documents" (LIKE "farm"."batch_documents" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."tank_allocations" (LIKE "farm"."tank_allocations" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."tank_batches" (LIKE "farm"."tank_batches" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."tank_operations" (LIKE "farm"."tank_operations" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."suppliers" (LIKE "farm"."suppliers" INCLUDING ALL)`,
  );
  await dataSource.query(`CREATE TABLE "${schema}"."feeds" (LIKE "farm"."feeds" INCLUDING ALL)`);
  await dataSource.query(
    `CREATE TABLE "${schema}"."feed_inventory" (LIKE "farm"."feed_inventory" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."feeding_records" (LIKE "farm"."feeding_records" INCLUDING ALL)`,
  );
}

async function createFarmOutboxTable(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS "farm"."outbox_events" (
      "id" BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      "eventType" VARCHAR(100) NOT NULL,
      "tenantId" UUID NULL,
      "aggregateId" UUID NULL,
      "payload" JSONB NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "publishedAt" TIMESTAMPTZ NULL,
      "retryCount" INTEGER NOT NULL DEFAULT 0,
      "lastError" TEXT NULL,
      "nextAttemptAt" TIMESTAMPTZ NULL,
      "idempotencyKey" VARCHAR(255) NULL,
      "isDeadLettered" BOOLEAN NOT NULL DEFAULT false,
      "leasedAt" TIMESTAMPTZ NULL,
      "leasedBy" VARCHAR(128) NULL
    )
  `);
}
