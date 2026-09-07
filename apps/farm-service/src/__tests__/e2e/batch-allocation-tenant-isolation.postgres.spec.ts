/**
 * Batch allocation tenant isolation and read-after-write tests.
 *
 * WHY: Batch allocation is a multi-table transactional write path used by the
 * REST controller. Writes go through the command bus (farm-rest-cqrs-ssot). It is a high-risk source for "DB has
 * the row but UI cannot see it" bugs because one operation updates batches,
 * tank allocations, tank batch snapshots, and tank operations inside a
 * QueryRunner transaction. This contract proves those writes stay in the
 * active tenant schema and are immediately queryable by tenant-scoped reads.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import {
  createFarmOutboxTable,
  createFarmStockReadModelTables,
  createTenantSchemaDerived,
} from './helpers/tenant-schema-harness';
import { DataSource, Repository } from 'typeorm';

import { Batch, BatchInputType, BatchStatus } from '../../batch/entities/batch.entity';
import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { TankAllocation, AllocationType } from '../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import {
  createFixtureBatchWriters,
  FIXTURE_ENTITIES,
  type FixtureBatchWriters,
} from './helpers/farm-tenant-fixture';
import { AllocateToTankCommand } from '../../batch/commands/allocate-to-tank.command';
import { CreateBatchCommand } from '../../batch/commands/create-batch.command';
import { TransferBatchCommand } from '../../batch/commands/transfer-batch.command';
import { GetBatchQuery } from '../../batch/queries/get-batch.query';
import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import { ListBatchesHandler } from '../../batch/query-handlers/list-batches.handler';
import { ListBatchesQuery } from '../../batch/queries/list-batches.query';
import {
  Department,
  DepartmentStatus,
  DepartmentType,
} from '../../department/entities/department.entity';
import {
  Species,
  SpeciesCategory,
  SpeciesStatus,
  SpeciesWaterType,
} from '../../species/entities/species.entity';
import { Site, SiteStatus, SiteType } from '../../site/entities/site.entity';
import {
  Tank,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../tank/entities/tank.entity';

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
  let writers: FixtureBatchWriters;
  let listBatches: ListBatchesHandler;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-batch-allocation-${randomBytes(4).toString('hex')}`,
      // The production writers declare their own entity closure; this suite
      // adds nothing on top (FARM-HIGH-109).
      entities: [...FIXTURE_ENTITIES],
      synchronize: true,
      logging: false,
      extra: {
        options: '-c search_path=farm,public',
      },
    });

    await dataSource.initialize();

    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();

    await createFarmOutboxTable(dataSource);
    await createFarmStockReadModelTables(dataSource);
    await createTenantSchemaDerived(dataSource, getTenantSchemaName(TENANT_A));
    await createTenantSchemaDerived(dataSource, getTenantSchemaName(TENANT_B));

    batchRepository = dataSource.getRepository(Batch);
    allocationRepository = dataSource.getRepository(TankAllocation);
    tankBatchRepository = dataSource.getRepository(TankBatch);
    operationRepository = dataSource.getRepository(TankOperation);
    siteRepository = dataSource.getRepository(Site);
    departmentRepository = dataSource.getRepository(Department);
    speciesRepository = dataSource.getRepository(Species);
    tankRepository = dataSource.getRepository(Tank);

    // Writes go through the production command handlers, reads through the
    // production query handler (FARM-HIGH-109). This suite used to build its
    // own BatchService — a write shadow with no production caller — and call
    // that "the REST path".
    writers = createFixtureBatchWriters(dataSource);
    listBatches = new ListBatchesHandler(dataSource);
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
    const allocationA = await allocateBatchForTenant(
      TENANT_A,
      batchA.id,
      fixtureA.sourceTank.id,
      100,
      10,
    );

    expect(allocationA.tenantId).toBe(TENANT_A);
    expect(await rowCount('farm', 'batches_v2', TENANT_A)).toBe(0);
    expect(await rowCount(getTenantSchemaName(TENANT_A), 'batches_v2', TENANT_A)).toBe(1);
    expect(await rowCount(getTenantSchemaName(TENANT_B), 'batches_v2', TENANT_A)).toBe(0);
    expect(await rowCount(getTenantSchemaName(TENANT_A), 'tank_allocations', TENANT_A)).toBe(1);
    expect(await rowCount(getTenantSchemaName(TENANT_B), 'tank_allocations', TENANT_A)).toBe(0);

    const tenantAAfterAllocate = await withTenantContext(TENANT_A, () =>
      writers.getBatch.execute(new GetBatchQuery(TENANT_A, batchA.id)),
    );
    const tenantASourceSnapshot = await tankBatchFor(TENANT_A, fixtureA.sourceTank.id);

    expect(tenantAAfterAllocate.status).toBe(BatchStatus.ACTIVE);
    expect(tenantASourceSnapshot?.primaryBatchId).toBe(batchA.id);
    expect(tenantASourceSnapshot?.totalQuantity).toBe(100);
    expect(Number(tenantASourceSnapshot?.totalBiomassKg)).toBe(1);

    // The query handler raises the same NotFoundException the service did, so
    // the cross-tenant invisibility assertion is unchanged.
    await expect(
      withTenantContext(TENANT_B, () =>
        writers.getBatch.execute(new GetBatchQuery(TENANT_B, batchA.id)),
      ),
    ).rejects.toThrow(`Batch ${batchA.id} bulunamadı`);

    await withTenantContext(TENANT_A, () =>
      writers.transferBatch.execute(
        new TransferBatchCommand(
          TENANT_A,
          batchA.id,
          {
            sourceTankId: fixtureA.sourceTank.id,
            destinationTankId: fixtureA.destinationTank.id,
            quantity: 40,
            avgWeightG: 10,
            transferReason: 'density-balancing',
          },
          USER_ID,
          [Role.MODULE_MANAGER],
          [],
          // The production transfer path REJECTS a call without an idempotency
          // envelope (`transfer-batch.handler.ts:135`) — the GraphQL input and
          // the REST controller both make it mandatory. The write shadow this
          // suite used to call had no such requirement, so the suite never
          // exercised the receipt write at all.
          {
            clientCommandId: '9f1d5a2e-7c64-4a1b-9f0e-2b6c8d3a5e77',
            payloadHash: 'a'.repeat(64),
            operationType: 'transferBatch',
          },
        ),
      ),
    );

    const tenantAAllocations = await allocationsFor(TENANT_A, batchA.id);
    const tenantAOperations = await operationsFor(TENANT_A, batchA.id);
    const tenantASourceAfterTransfer = await tankBatchFor(TENANT_A, fixtureA.sourceTank.id);
    const tenantADestinationAfterTransfer = await tankBatchFor(
      TENANT_A,
      fixtureA.destinationTank.id,
    );

    // `TransferBatchHandler` returns the Batch, where the service returned the
    // two operation rows. Asserting the PERSISTED rows is the stronger check
    // anyway — it proves what landed in the tenant schema, not what a return
    // value claimed.
    expect(tenantAOperations.map((op) => op.operationType).sort()).toEqual(
      [OperationType.TRANSFER_IN, OperationType.TRANSFER_OUT].sort(),
    );
    const tenantAListByDestinationTank = await withTenantContext(TENANT_A, () =>
      listBatches.execute(
        new ListBatchesQuery(
          TENANT_A,
          { tankId: fixtureA.destinationTank.id, searchTerm: 'BATCH-SHARED' },
          1,
          10,
        ),
      ),
    );

    // Ledger rows: initial_stocking(+100), transfer_out(-40), transfer_in(+40).
    expect(tenantAAllocations).toHaveLength(3);
    expect(tenantAAllocations.map((a) => a.allocationType).sort()).toEqual(
      [
        AllocationType.INITIAL_STOCKING,
        AllocationType.TRANSFER_IN,
        AllocationType.TRANSFER_OUT,
      ].sort(),
    );
    expect(allocationQuantityFor(tenantAAllocations, fixtureA.sourceTank.id)).toBe(60);
    expect(allocationQuantityFor(tenantAAllocations, fixtureA.destinationTank.id)).toBe(40);
    expect(tenantAOperations.map((operation) => operation.operationType).sort()).toEqual([
      OperationType.TRANSFER_IN,
      OperationType.TRANSFER_OUT,
    ]);
    expect(tenantASourceAfterTransfer?.totalQuantity).toBe(60);
    expect(tenantADestinationAfterTransfer?.totalQuantity).toBe(40);
    expect(tenantAListByDestinationTank.data.map((batch: Batch) => batch.id)).toEqual([batchA.id]);

    const tenantBAllocations = await allocationsFor(TENANT_B, batchB.id);
    const tenantBOperations = await operationsFor(TENANT_B, batchB.id);
    const tenantBSourceSnapshot = await tankBatchFor(TENANT_B, fixtureB.sourceTank.id);
    const tenantBListByTenantATank = await withTenantContext(TENANT_B, () =>
      listBatches.execute(
        new ListBatchesQuery(
          TENANT_B,
          { tankId: fixtureA.destinationTank.id, searchTerm: 'BATCH-SHARED' },
          1,
          10,
        ),
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
    const sourceTank = await createTankForTenant(
      tenantId,
      department.id,
      'Source Tank',
      'SOURCE-TANK',
    );
    const destinationTank = await createTankForTenant(
      tenantId,
      department.id,
      'Destination Tank',
      'DEST-TANK',
    );

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

  async function createBatchForTenant(
    tenantId: string,
    speciesId: string,
    batchNumber: string,
  ): Promise<Batch> {
    return withTenantContext(tenantId, () =>
      writers.createBatch.execute(
        new CreateBatchCommand(
          tenantId,
          {
            batchNumber,
            speciesId,
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
  }

  async function allocateBatchForTenant(
    tenantId: string,
    batchId: string,
    tankId: string,
    quantity: number,
    avgWeightG: number,
  ): Promise<Batch> {
    return withTenantContext(tenantId, () =>
      writers.allocateToTank.execute(
        new AllocateToTankCommand(
          tenantId,
          batchId,
          {
            tankId,
            quantity,
            avgWeightG,
            allocationType: AllocationType.INITIAL_STOCKING,
          },
          USER_ID,
          // MODULE_MANAGER bypasses the object-level site gate (SEC-HIGH-051);
          // this suite asserts tenant isolation, not site assignment.
          [Role.MODULE_MANAGER],
        ),
      ),
    );
  }

  /** Allocation rows for a batch, read inside the tenant's own context. */
  async function allocationsFor(tenantId: string, batchId: string): Promise<TankAllocation[]> {
    return withTenantContext(tenantId, () =>
      allocationRepository!.find({ where: { tenantId, batchId } }),
    );
  }

  /** Tank-operation rows for a batch, read inside the tenant's own context. */
  async function operationsFor(tenantId: string, batchId: string): Promise<TankOperation[]> {
    return withTenantContext(tenantId, () =>
      operationRepository!.find({ where: { tenantId, batchId } }),
    );
  }

  /** The tank's composition row, read inside the tenant's own context. */
  async function tankBatchFor(tenantId: string, tankId: string): Promise<TankBatch | null> {
    return withTenantContext(tenantId, () =>
      tankBatchRepository!.findOne({ where: { tenantId, tankId } }),
    );
  }

  async function rowCount(schema: string, table: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource!.query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."${table}" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * `tank_allocations` is an append-only LEDGER: a transfer adds a
   * `transfer_out` row with a negative quantity on the source and a
   * `transfer_in` row on the destination, rather than editing the stocking row
   * in place. So a tank's holding is the SUM of its rows, not any one of them.
   *
   * The retired `BatchService.transferBatch` mutated the stocking row in place
   * instead (FARM-LOW-211) — which is why this suite used to see two rows and
   * could read a tank's quantity off a single `find()`.
   */
  function allocationQuantityFor(allocations: TankAllocation[], tankId: string): number {
    return allocations
      .filter((item) => item.tankId === tankId)
      .reduce((total, item) => total + Number(item.quantity), 0);
  }
});
