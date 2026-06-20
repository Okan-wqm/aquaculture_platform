/**
 * Batch allocation tenant isolation and read-after-write tests.
 *
 * WHY: Batch allocation is a multi-table transactional write path used by the
 * REST controller through BatchService. It is a high-risk source for "DB has
 * the row but UI cannot see it" bugs because one operation updates batches,
 * tank allocations, tank batch snapshots, and tank operations inside a
 * QueryRunner transaction. This contract proves those writes stay in the
 * active tenant schema and are immediately queryable by tenant-scoped reads.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import { createTenantConnectionBootstrap, getTenantSchemaName, withTenantContext } from '@aquaculture/backend-common';
import { bootPostgresContainer, HarnessContext, shutdownHarness } from '@platform/migration-harness';
import { DataSource, Repository } from 'typeorm';

import { Batch, BatchInputType, BatchStatus } from '../../batch/entities/batch.entity';
import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { TankAllocation, AllocationType } from '../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import { ListBatchesHandler } from '../../batch/query-handlers/list-batches.handler';
import { ListBatchesQuery } from '../../batch/queries/list-batches.query';
import { BatchService } from '../../batch/services/batch.service';
import { MortalityCullPolicyService } from '../../batch/services/mortality-cull-policy.service';
import { Department, DepartmentStatus, DepartmentType } from '../../department/entities/department.entity';
import {
  Species,
  SpeciesCategory,
  SpeciesStatus,
  SpeciesWaterType,
} from '../../species/entities/species.entity';
import { Site, SiteStatus, SiteType } from '../../site/entities/site.entity';
import { Tank, TankMaterial, TankStatus, TankType, WaterType } from '../../tank/entities/tank.entity';

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const TENANT_B = '7c2f4e10-3d2a-4b4e-9f18-f8b16f0d5a10';
const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';

interface TenantFixture {
  species: Species;
  site: Site;
  department: Department;
  sourceTank: Tank;
  destinationTank: Tank;
}

jest.setTimeout(120_000);

describe('Batch allocation tenant isolation on real Postgres', () => {
  let pg: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let batchRepository: Repository<Batch>;
  let allocationRepository: Repository<TankAllocation>;
  let tankBatchRepository: Repository<TankBatch>;
  let operationRepository: Repository<TankOperation>;
  let siteRepository: Repository<Site>;
  let departmentRepository: Repository<Department>;
  let speciesRepository: Repository<Species>;
  let tankRepository: Repository<Tank>;
  let batchService: BatchService;
  let listBatches: ListBatchesHandler;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-batch-allocation-${randomBytes(4).toString('hex')}`,
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

    await createTenantSchema(dataSource, getTenantSchemaName(TENANT_A));
    await createTenantSchema(dataSource, getTenantSchemaName(TENANT_B));

    batchRepository = dataSource.getRepository(Batch);
    allocationRepository = dataSource.getRepository(TankAllocation);
    tankBatchRepository = dataSource.getRepository(TankBatch);
    operationRepository = dataSource.getRepository(TankOperation);
    siteRepository = dataSource.getRepository(Site);
    departmentRepository = dataSource.getRepository(Department);
    speciesRepository = dataSource.getRepository(Species);
    tankRepository = dataSource.getRepository(Tank);

    batchService = new BatchService(
      batchRepository,
      allocationRepository,
      tankBatchRepository,
      operationRepository,
      tankRepository,
      dataSource,
      new MortalityCullPolicyService(),
    );
    listBatches = new ListBatchesHandler(batchRepository, tankBatchRepository);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await shutdownHarness(pg);
  });

  it('keeps batch create/allocation/transfer writes isolated and immediately visible per tenant', async () => {
    const fixtureA = await createTenantFixture(TENANT_A);
    const fixtureB = await createTenantFixture(TENANT_B);
    const batchA = await createBatchForTenant(TENANT_A, fixtureA.species.id, 'BATCH-SHARED-01');
    const batchB = await createBatchForTenant(TENANT_B, fixtureB.species.id, 'BATCH-SHARED-01');

    await allocateBatchForTenant(TENANT_B, batchB.id, fixtureB.sourceTank.id, 80, 10);
    const allocationA = await allocateBatchForTenant(TENANT_A, batchA.id, fixtureA.sourceTank.id, 100, 10);

    expect(allocationA.tenantId).toBe(TENANT_A);
    expect(await rowCount('farm', 'batches_v2', TENANT_A)).toBe(0);
    expect(await rowCount(getTenantSchemaName(TENANT_A), 'batches_v2', TENANT_A)).toBe(1);
    expect(await rowCount(getTenantSchemaName(TENANT_B), 'batches_v2', TENANT_A)).toBe(0);
    expect(await rowCount(getTenantSchemaName(TENANT_A), 'tank_allocations', TENANT_A)).toBe(1);
    expect(await rowCount(getTenantSchemaName(TENANT_B), 'tank_allocations', TENANT_A)).toBe(0);

    const tenantAAfterAllocate = await withTenantContext(TENANT_A, () =>
      batchService.findBatchById(batchA.id, TENANT_A),
    );
    const tenantASourceSnapshot = await withTenantContext(TENANT_A, () =>
      batchService.getTankBatchStatus(fixtureA.sourceTank.id, TENANT_A),
    );

    expect(tenantAAfterAllocate.status).toBe(BatchStatus.ACTIVE);
    expect(tenantASourceSnapshot?.primaryBatchId).toBe(batchA.id);
    expect(tenantASourceSnapshot?.totalQuantity).toBe(100);
    expect(Number(tenantASourceSnapshot?.totalBiomassKg)).toBe(1);

    await expect(
      withTenantContext(TENANT_B, () => batchService.findBatchById(batchA.id, TENANT_B)),
    ).rejects.toThrow(`Batch ${batchA.id} bulunamadı`);

    const transfer = await withTenantContext(TENANT_A, () =>
      batchService.transferBatch(
        TENANT_A,
        batchA.id,
        fixtureA.sourceTank.id,
        fixtureA.destinationTank.id,
        40,
        10,
        USER_ID,
        'density-balancing',
      ),
    );

    expect(transfer.sourceOperation.operationType).toBe(OperationType.TRANSFER_OUT);
    expect(transfer.destinationOperation.operationType).toBe(OperationType.TRANSFER_IN);

    const tenantAAllocations = await withTenantContext(TENANT_A, () =>
      batchService.getBatchAllocations(batchA.id, TENANT_A),
    );
    const tenantAOperations = await withTenantContext(TENANT_A, () =>
      batchService.getBatchOperations(batchA.id, TENANT_A),
    );
    const tenantASourceAfterTransfer = await withTenantContext(TENANT_A, () =>
      batchService.getTankBatchStatus(fixtureA.sourceTank.id, TENANT_A),
    );
    const tenantADestinationAfterTransfer = await withTenantContext(TENANT_A, () =>
      batchService.getTankBatchStatus(fixtureA.destinationTank.id, TENANT_A),
    );
    const tenantAListByDestinationTank = await withTenantContext(TENANT_A, () =>
      listBatches.execute(
        new ListBatchesQuery(TENANT_A, { tankId: fixtureA.destinationTank.id, searchTerm: 'BATCH-SHARED' }, 1, 10),
      ),
    );

    expect(tenantAAllocations).toHaveLength(2);
    expect(allocationQuantityFor(tenantAAllocations, fixtureA.sourceTank.id)).toBe(60);
    expect(allocationQuantityFor(tenantAAllocations, fixtureA.destinationTank.id)).toBe(40);
    expect(tenantAOperations.map((operation) => operation.operationType).sort()).toEqual([
      OperationType.TRANSFER_IN,
      OperationType.TRANSFER_OUT,
    ]);
    expect(tenantASourceAfterTransfer?.totalQuantity).toBe(60);
    expect(tenantADestinationAfterTransfer?.totalQuantity).toBe(40);
    expect(tenantAListByDestinationTank.data.map((batch: Batch) => batch.id)).toEqual([batchA.id]);

    const tenantBAllocations = await withTenantContext(TENANT_B, () =>
      batchService.getBatchAllocations(batchB.id, TENANT_B),
    );
    const tenantBOperations = await withTenantContext(TENANT_B, () =>
      batchService.getBatchOperations(batchB.id, TENANT_B),
    );
    const tenantBSourceSnapshot = await withTenantContext(TENANT_B, () =>
      batchService.getTankBatchStatus(fixtureB.sourceTank.id, TENANT_B),
    );
    const tenantBListByTenantATank = await withTenantContext(TENANT_B, () =>
      listBatches.execute(
        new ListBatchesQuery(TENANT_B, { tankId: fixtureA.destinationTank.id, searchTerm: 'BATCH-SHARED' }, 1, 10),
      ),
    );

    expect(tenantBAllocations).toHaveLength(1);
    expect(Number(tenantBAllocations[0]?.quantity)).toBe(80);
    expect(tenantBOperations).toHaveLength(0);
    expect(tenantBSourceSnapshot?.totalQuantity).toBe(80);
    expect(tenantBListByTenantATank.data).toHaveLength(0);
    expect(await rowCount('farm', 'tank_operations', TENANT_A)).toBe(0);
    expect(await rowCount(getTenantSchemaName(TENANT_B), 'tank_operations', TENANT_A)).toBe(0);
  });

  async function createTenantFixture(tenantId: string): Promise<TenantFixture> {
    const site = await withTenantContext(tenantId, () =>
      siteRepository.save(
        siteRepository.create({
          tenantId,
          name: 'Batch Site',
          code: 'BATCH-SITE',
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
          name: 'Batch Department',
          code: 'BATCH-DEPT',
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
    const sourceTank = await createTankForTenant(tenantId, department.id, 'Source Tank', 'SOURCE-TANK');
    const destinationTank = await createTankForTenant(tenantId, department.id, 'Destination Tank', 'DEST-TANK');

    return { species, site, department, sourceTank, destinationTank };
  }

  async function createTankForTenant(
    tenantId: string,
    departmentId: string,
    name: string,
    code: string,
  ): Promise<Tank> {
    return withTenantContext(tenantId, () =>
      tankRepository.save(
        tankRepository.create({
          tenantId,
          name,
          code,
          departmentId,
          tankType: TankType.CIRCULAR,
          material: TankMaterial.FIBERGLASS,
          waterType: WaterType.SALTWATER,
          diameter: 5,
          depth: 2,
          waterDepth: 2,
          maxBiomass: 1500,
          currentBiomass: 0,
          maxDensity: 30,
          status: TankStatus.ACTIVE,
          isActive: true,
          createdBy: USER_ID,
          updatedBy: USER_ID,
        }),
      ),
    );
  }

  async function createBatchForTenant(tenantId: string, speciesId: string, batchNumber: string): Promise<Batch> {
    return withTenantContext(tenantId, () =>
      batchService.createBatch({
        tenantId,
        batchNumber,
        speciesId,
        inputType: BatchInputType.FRY,
        initialQuantity: 100,
        initialAvgWeightG: 10,
        stockedAt: new Date('2026-04-29T00:00:00.000Z'),
        currency: 'USD',
        createdBy: USER_ID,
      }),
    );
  }

  async function allocateBatchForTenant(
    tenantId: string,
    batchId: string,
    tankId: string,
    quantity: number,
    avgWeightG: number,
  ): Promise<TankAllocation> {
    return withTenantContext(tenantId, () =>
      batchService.allocateBatchToTank({
        tenantId,
        batchId,
        tankId,
        quantity,
        avgWeightG,
        allocationType: AllocationType.INITIAL_STOCKING,
        allocatedBy: USER_ID,
      }),
    );
  }

  async function rowCount(schema: string, table: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource!.query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."${table}" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  function allocationQuantityFor(allocations: TankAllocation[], tankId: string): number {
    const allocation = allocations.find((item) => item.tankId === tankId);
    return Number(allocation?.quantity ?? 0);
  }
});

async function createTenantSchema(dataSource: DataSource, schema: string): Promise<void> {
  await dataSource.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.query(`CREATE TABLE "${schema}"."sites" (LIKE "farm"."sites" INCLUDING ALL)`);
  await dataSource.query(`CREATE TABLE "${schema}"."departments" (LIKE "farm"."departments" INCLUDING ALL)`);
  await dataSource.query(`CREATE TABLE "${schema}"."tanks" (LIKE "farm"."tanks" INCLUDING ALL)`);
  await dataSource.query(`CREATE TABLE "${schema}"."species" (LIKE "farm"."species" INCLUDING ALL)`);
  await dataSource.query(`CREATE TABLE "${schema}"."batches_v2" (LIKE "farm"."batches_v2" INCLUDING ALL)`);
  await dataSource.query(`CREATE TABLE "${schema}"."batch_documents" (LIKE "farm"."batch_documents" INCLUDING ALL)`);
  await dataSource.query(`CREATE TABLE "${schema}"."tank_allocations" (LIKE "farm"."tank_allocations" INCLUDING ALL)`);
  await dataSource.query(`CREATE TABLE "${schema}"."tank_batches" (LIKE "farm"."tank_batches" INCLUDING ALL)`);
  await dataSource.query(`CREATE TABLE "${schema}"."tank_operations" (LIKE "farm"."tank_operations" INCLUDING ALL)`);
}
