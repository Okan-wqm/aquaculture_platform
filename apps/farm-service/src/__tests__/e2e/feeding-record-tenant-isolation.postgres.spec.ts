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

import { createFarmStockReadModelTables } from './helpers/tenant-schema-harness';
import { DataSource, Repository } from 'typeorm';

import { Role } from '@aquaculture/backend-common/decorators';

import { AllocateToTankCommand } from '../../batch/commands/allocate-to-tank.command';
import { CreateBatchCommand } from '../../batch/commands/create-batch.command';
import { Batch, BatchInputType, BatchStatus } from '../../batch/entities/batch.entity';
import {
  createFixtureBatchWriters,
  FIXTURE_ENTITIES,
  type FixtureBatchWriters,
} from './helpers/farm-tenant-fixture';
import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { TankAllocation, AllocationType } from '../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankOperation } from '../../batch/entities/tank-operation.entity';
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
import { StockMutationLockAuthority } from '../../storage/services/stock-mutation-lock.authority';
import { FeedingDayPlan } from '../../feeding-protocol/entities/feeding-day-plan.entity';
import { FeedingMeal } from '../../feeding-protocol/entities/feeding-meal.entity';
import { FeedingProtocolV2 } from '../../feeding-protocol/entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../../feeding-protocol/entities/protocol-assignment.entity';
import { BiomassGrowthApplierService } from '../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { ProtocolResolutionService } from '../../feeding-protocol/services/protocol-resolution.service';
import { ProtocolRateService } from '../../feeding-protocol/services/protocol-rate.service';
import { GetFeedingRecordsHandler } from '../../feeding/query-handlers/get-feeding-records.handler';
import { GetFeedingSummaryHandler } from '../../feeding/query-handlers/get-feeding-summary.handler';
import { GetFeedingRecordsQuery } from '../../feeding/queries/get-feeding-records.query';
import { GetFeedingSummaryQuery } from '../../feeding/queries/get-feeding-summary.query';
import { FinanceSettings } from '../../finance/entities/finance-settings.entity';
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
import {
  StorageLocation,
  StorageLocationType,
} from '../../storage/entities/storage-location.entity';
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
  let batchWriters: FixtureBatchWriters;
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
        // The fixture's production writers declare their own closure — Equipment
        // and its relation graph, the feeding-protocol entities the transfer
        // path recalculates, the code sequences createBatch allocates from
        // (FARM-HIGH-109). This suite adds only what IT needs on top.
        ...FIXTURE_ENTITIES,
        StorageLocation,
        StorageInventory,
        StockMovement,
        StorageLotMix,
        // FeedingLedgerService owns feed cost for every caller (C-16) and reads
        // the tenant's default currency through FinanceSettingsService. Its
        // in-transaction variant does NOT swallow a missing row the way the
        // read-path variant does, so leaving the entity unregistered surfaced as
        // `EntityMetadataNotFoundError` from inside recordFeed rather than as a
        // currency fallback. Production registers it; the harness must too.
        FinanceSettings,
      ],
      synchronize: true,
      logging: false,
      extra: {
        options: '-c search_path=farm,public',
      },
    });

    await dataSource.initialize();
    await createFarmOutboxTable(dataSource);
    await createFarmStockReadModelTables(dataSource);

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

    // Stocking goes through the production command handlers (FARM-HIGH-109).
    batchWriters = createFixtureBatchWriters(dataSource);

    const outboxPublisher = new OutboxPublisher(FarmOutbox);
    const backdatePolicy = { validate: jest.fn() };
    const batchDomainService = new BatchDomainService(new BatchLifecyclePolicyService());
    // REAL sink: storage-tracked feed → FEFO lot decrement + roll-up +
    // LowStockDetected all inside the feeding transaction.
    const mutationLocks = new StockMutationLockAuthority();
    const stockMovementService = new StockMovementService(
      new LotMixService(),
      new SiteAuthorizationService(),
      outboxPublisher,
      mutationLocks,
      // W2 / FARM-CRITICAL-245: çok-lotlu FEFO tahsis motoru, yemlemenin depoya
      // tek girişi olan `resolveFeedDeductionLocation`ın ARKASINDA. GERÇEK örnek —
      // bu spec yazımların doğru tenant şemasına düştüğünü kanıtlıyor ve tahsis
      // motoru artık o yazım yolunun parçası.
      new FeedAllocationService(mutationLocks),
    );
    // P-05 tek yem yazma yolu: handler artık GERÇEK FeedingLedgerService'e
    // delege eder (kayıt + batch aggregate + FEFO düşüm + outbox tek noktada).
    // Motor yardımcıları da GERÇEK — aşağıdaki gerekçeye bakın. (Eski not
    // "payload'lar tankId taşımıyor" diyordu; taşıyorlar, yani plan bağlama
    // dalı bu fixture'da KOŞAR ve sahte yardımcılarla koşuyordu.)
    const feedingLedger = new FeedingLedgerService(
      stockMovementService,
      new FinanceSettingsService(dataSource),
      outboxPublisher,
    );
    createFeedingRecord = new CreateFeedingRecordHandler(
      feedingRecordRepository,
      batchRepository,
      feedRepository,
      dataSource,
      backdatePolicy as never,
      batchDomainService,
      feedingLedger,
      // REAL engine collaborators, not hand-rolled partials.
      //
      // These were a blanket-cast `{ lockUnitForGrowth: jest.fn() }` — a
      // two-property stand-in for a growing service. When `lockBatchForWrite` was added to
      // the applier and the handler started calling it, this spec died with
      // `TypeError: this.growthApplier.lockBatchForWrite is not a function`,
      // and it died only in CI: the Postgres lane cannot run where Docker is
      // unavailable, so the drift was invisible until a runner picked it up.
      // A partial double of a service that keeps growing has no way to stay
      // correct; the real objects do, and both construct with no I/O of their
      // own (the applier takes an optional metrics sink, the recalc service
      // takes collaborators this fixture already has).
      new BiomassGrowthApplierService(),
      new DayPlanRecalcService(
        outboxPublisher,
        new ProtocolResolutionService(new ProtocolRateService()),
      ),
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
        // Per-feed cost is part of the summary contract
        // (feeding-summary-response-contract.spec.ts pins it), and with one
        // feed type at 100% it must equal the totalFeedCost asserted above.
        // The omission stood because this line was unreachable: the test died
        // earlier, at the day-plan bind, before this assertion ever ran.
        cost: 25,
      },
    ]);

    const tenantAOutboxRows = await outboxRows(TENANT_A);
    const tenantBOutboxRows = await outboxRows(TENANT_B);
    // `BatchCreated` / `BatchAllocatedToTank` come from STOCKING the fixture
    // tank. They are new here only because stocking used to go through
    // `BatchService`, which emitted no domain events at all — this suite had
    // encoded that silence as the expectation (FARM-HIGH-109). The
    // tenant-scoping assertion below now covers them too.
    expect(tenantAOutboxRows.map((row) => row.eventType).sort()).toEqual([
      'BatchAllocatedToTank',
      'BatchCreated',
      'FeedingRecorded',
      'LowStockDetected',
    ]);
    expect(tenantBOutboxRows.map((row) => row.eventType).sort()).toEqual([
      'BatchAllocatedToTank',
      'BatchCreated',
    ]);
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
      batchWriters.createBatch.execute(
        new CreateBatchCommand(
          tenantId,
          {
            batchNumber: 'BATCH-SHARED-FEEDING',
            speciesId: species.id,
            inputType: BatchInputType.FRY,
            initialQuantity: 100,
            initialAvgWeightG: 10,
            stockedAt: new Date('2026-04-29T00:00:00.000Z'),
            currency: 'USD',
          },
          USER_ID,
        ),
      ),
    );
    await withTenantContext(tenantId, () =>
      batchWriters.allocateToTank.execute(
        new AllocateToTankCommand(
          tenantId,
          batch.id,
          {
            tankId: tank.id,
            quantity: 100,
            avgWeightG: 10,
            allocationType: AllocationType.INITIAL_STOCKING,
          },
          USER_ID,
          // MODULE_MANAGER bypasses the object-level site gate (SEC-HIGH-051).
          [Role.MODULE_MANAGER],
        ),
      ),
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
          // `usedCapacity` AÇIKÇA verilir. Kolonun `default: 0` değeri VAR ama
          // bir `DecimalTransformer`'ı da var: TypeORM transformer'ı insert'ten
          // ÖNCE uygular, `undefined` NULL'a döner ve satıra açık NULL yazılır
          // — DB default'u hiç devreye girmez, NOT NULL kısıtı patlar.
          // Üretimdeki `CreateStorageLocationHandler` de alanı elle 0 veriyor
          // (create-storage-location.handler.ts:54); atlamak fixture'ı
          // üretimden farklı kılardı.
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

  /**
   * Tenant ayrıştırıcı kolonun GERÇEK adı, tablo başına.
   *
   * Bu helper'lar eskiden her tablo için `"tenantId"` varsayıyordu. Doğru
   * değil: `feeding_records` camelCase (`@Column('uuid') tenantId`), ama
   * `stock_movements` açık eşlemeyle snake_case yazar
   * (`@Column({ name: 'tenant_id' })`) — yani `stock_movements` sayımı
   * çalıştığı anda `42703 column "tenantId" does not exist` verirdi. Kusur
   * görünmedi çünkü Docker gerektiren bu süiti koşan hedef CI'da hiçbir
   * yerden çağrılmıyordu (FARM-MEDIUM-301) — FARM-CRITICAL-242 ile birebir
   * aynı sınıf: entity'de açık `name:` taşıyan bir kolona property adıyla
   * ham SQL yazmak.
   *
   * Bilinmeyen tablo fail-closed: sessizce yanlış bir predikat üretmektense
   * patlar.
   */
  const TENANT_COLUMN: Readonly<Record<string, string>> = {
    feeding_records: 'tenantId',
    stock_movements: 'tenant_id',
  };

  function tenantColumnOf(table: string): string {
    const column = TENANT_COLUMN[table];
    if (!column) {
      throw new Error(
        `${table} için tenant kolonu bilinmiyor — entity'nin @Column adını okuyup TENANT_COLUMN'a ekleyin`,
      );
    }
    return column;
  }

  async function tenantRowCount(table: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource!.query(
      `SELECT COUNT(*)::text AS count FROM "${getTenantSchemaName(tenantId)}"."${table}" ` +
        `WHERE "${tenantColumnOf(table)}" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function sourceTenantRowCount(table: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource!.query(
      `SELECT COUNT(*)::text AS count FROM "farm"."${table}" WHERE "${tenantColumnOf(table)}" = $1`,
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

/**
 * Clone every PER-TENANT table into `schema`, derived from what `synchronize`
 * actually created in `farm` rather than from a hand-kept list.
 *
 * The list version had to be edited in lockstep with the `entities` array
 * above, and a miss surfaced only at runtime, from inside a handler, as
 * `EntityMetadataNotFoundError` — twice already (FinanceSettings, then
 * FeedingDayPlan when the feeding-protocol merge made the handler bind a day
 * plan). Deriving it deletes one of the two lists: registering an entity is now
 * the single edit, and the tenant schema follows.
 *
 * Tables whose entity declares an explicit `schema:` are cross-tenant by
 * ADR-011 (the outbox here) and stay in `farm`.
 */
async function createTenantSchema(dataSource: DataSource, schema: string): Promise<void> {
  await dataSource.query(`CREATE SCHEMA "${schema}"`);
  const crossTenant = new Set(
    dataSource.entityMetadatas
      .filter((metadata) => metadata.schema !== undefined)
      .map((metadata) => metadata.tableName),
  );
  const sourceTables: Array<{ table_name: string }> = await dataSource.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'farm' AND table_type = 'BASE TABLE'`,
  );
  for (const { table_name: table } of sourceTables) {
    if (crossTenant.has(table)) continue;
    await dataSource.query(
      `CREATE TABLE "${schema}"."${table}" (LIKE "farm"."${table}" INCLUDING ALL)`,
    );
  }
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
