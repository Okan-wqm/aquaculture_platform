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
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, Repository } from 'typeorm';

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
import {
  FeedingRecord,
  FeedingMethod,
  FishAppetite,
} from '../../feeding/entities/feeding-record.entity';
import { CreateFeedingRecordHandler } from '../../feeding/handlers/create-feeding-record.handler';
import { FeedingLedgerService } from '../../feeding/services/feeding-ledger.service';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';
import { FeedAllocationService } from '../../storage/services/feed-allocation.service';
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
import { StorageLocation, StorageLocationType } from '../../storage/entities/storage-location.entity';
import { StorageInventory, StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StockMovement } from '../../storage/entities/stock-movement.entity';
import { StorageLotMix } from '../../storage/entities/storage-lot-mix.entity';

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
  storageLocation: StorageLocation;
  storageLot: StorageInventory;
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
        StorageLocation,
        StorageInventory,
        StockMovement,
        StorageLotMix,
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
    // REAL sink: storage-tracked feed → FEFO lot decrement + roll-up +
    // LowStockDetected all inside the feeding transaction.
    const stockMovementService = new StockMovementService(
      new LotMixService(),
      new SiteAuthorizationService(),
      outboxPublisher,
    );
    // P-05 tek yem yazma yolu: handler artık GERÇEK FeedingLedgerService'e
    // delege eder (kayıt + batch aggregate + FEFO düşüm + outbox tek noktada).
    // D-7 motor yardımcıları mock — bu fixture'ın payload'ları tankId
    // taşımadığı için plan bağlama dalı hiç koşmaz.
    const feedingLedger = new FeedingLedgerService(
      stockMovementService,
      new FinanceSettingsService(dataSource),
      outboxPublisher,
      // W2 / FARM-CRITICAL-245: çok-lotlu FEFO tahsis motoru. GERÇEK örnek —
      // bu spec'in amacı yazımların doğru tenant şemasına düştüğünü kanıtlamak,
      // ve tahsis motoru artık o yazım yolunun parçası.
      new FeedAllocationService(),
    );
    createFeedingRecord = new CreateFeedingRecordHandler(
      feedingRecordRepository,
      batchRepository,
      feedRepository,
      dataSource,
      backdatePolicy as never,
      batchDomainService,
      feedingLedger,
      { lockUnitForGrowth: jest.fn().mockResolvedValue(null) } as never,
      { recalcForUnit: jest.fn().mockResolvedValue(null) } as never,
    );
    getFeedingRecords = new GetFeedingRecordsHandler(dataSource);
    getFeedingSummary = new GetFeedingSummaryHandler(dataSource);
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
    expect(await tenantRowCount('stock_movements', TENANT_A)).toBe(1);
    expect(await tenantRowCount('stock_movements', TENANT_B)).toBe(0);

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
      'FeedingRecorded',
      'LowStockDetected',
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
    const storageLocation = await withTenantContext(tenantId, () =>
      dataSource!.manager.save(
        dataSource!.manager.create(StorageLocation, {
          tenantId,
          siteId: site.id,
          name: 'Feed Warehouse',
          code: 'FEED-WH',
          type: StorageLocationType.WAREHOUSE,
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
    `CREATE TABLE "${schema}"."storage_locations" (LIKE "farm"."storage_locations" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."storage_inventory" (LIKE "farm"."storage_inventory" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."stock_movements" (LIKE "farm"."stock_movements" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."storage_lot_mixes" (LIKE "farm"."storage_lot_mixes" INCLUDING ALL)`,
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
