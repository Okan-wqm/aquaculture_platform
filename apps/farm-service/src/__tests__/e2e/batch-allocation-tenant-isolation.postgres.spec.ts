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
import { DataSource, Repository } from 'typeorm';

import { Batch, BatchStatus } from '../../batch/entities/batch.entity';
import { TransferBatchCommand } from '../../batch/commands/transfer-batch.command';
import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { TankAllocation } from '../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import { ListBatchesHandler } from '../../batch/query-handlers/list-batches.handler';
import { ListBatchesQuery } from '../../batch/queries/list-batches.query';
import { BatchService } from '../../batch/services/batch.service';
import { Department } from '../../department/entities/department.entity';
import { Species } from '../../species/entities/species.entity';
import { Site } from '../../site/entities/site.entity';
import {
  Tank,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../tank/entities/tank.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { SubSystem } from '../../system/entities/sub-system.entity';
import { System } from '../../system/entities/system.entity';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import {
  createFarmOutboxTable,
  createSourceEquipmentTypesReferenceTable,
} from './helpers/tenant-schema-harness';
import {
  createFarmDurableMutationTestComposition,
  type FarmDurableMutationTestComposition,
} from '../support/durable-mutation-test-authority';
import {
  createBatchCommandTestHarness,
  type BatchCommandTestHarness,
} from './helpers/batch-command-test-harness';
import {
  createStockedTenantFixtureV1,
  type StockedTenantFixtureV1,
} from './helpers/stocked-tenant-fixture';
import { OutboxPublisher } from '@platform/outbox';

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const TENANT_B = '7c2f4e10-3d2a-4b4e-9f18-f8b16f0d5a10';
const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';

interface BatchTransferTenantFixtureV1 extends Omit<StockedTenantFixtureV1, 'tank'> {
  readonly sourceTank: Tank;
  readonly destinationTank: Tank;
}

jest.setTimeout(120_000);

describe('Batch allocation tenant isolation on real Postgres', () => {
  let pg: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let batchRepository: Repository<Batch>;
  let tankRepository: Repository<Tank>;
  let batchService: BatchService;
  let mutationComposition: FarmDurableMutationTestComposition;
  let batchCommands: BatchCommandTestHarness;
  let listBatches: ListBatchesHandler;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    await createFarmOutboxTable(pg.dataSource);
    await createSourceEquipmentTypesReferenceTable(pg.dataSource);

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-batch-allocation-${randomBytes(4).toString('hex')}`,
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
        TankAllocation,
        TankBatch,
        TankOperation,
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

    await createTenantSchema(dataSource, getTenantSchemaName(TENANT_A));
    await createTenantSchema(dataSource, getTenantSchemaName(TENANT_B));

    batchRepository = dataSource.getRepository(Batch);
    tankRepository = dataSource.getRepository(Tank);

    mutationComposition = await createFarmDurableMutationTestComposition();
    batchCommands = createBatchCommandTestHarness({
      dataSource,
      batchMutations: mutationComposition.batchMutations,
      feedingMutations: mutationComposition.feedingMutations,
      outboxPublisher: new OutboxPublisher(FarmOutbox),
    });
    batchService = batchCommands.readModel;
    listBatches = new ListBatchesHandler(dataSource);
  });

  afterAll(async () => {
    await mutationComposition?.close();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await shutdownHarness(pg);
  });

  it('keeps batch create/allocation/transfer writes isolated and immediately visible per tenant', async () => {
    const fixtureA = await createBatchTransferFixture(TENANT_A, 'BATCH-A', 100);
    const fixtureB = await createBatchTransferFixture(TENANT_B, 'BATCH-B', 80);
    const batchA = fixtureA.batch;
    const batchB = fixtureB.batch;
    const allocationA = (
      await withTenantContext(TENANT_A, () => batchService.getBatchAllocations(batchA.id, TENANT_A))
    ).find((candidate) => candidate.tankId === fixtureA.sourceTank.id);
    if (!allocationA) {
      throw new Error(
        `Shared stocked-tenant authority did not persist allocation for ${batchA.id}`,
      );
    }

    expect(allocationA.tenantId).toBe(TENANT_A);
    expect(await rowCount('farm', 'batches_v2', TENANT_A)).toBe(0);
    expect(await rowCount(getTenantSchemaName(TENANT_A), 'batches_v2', TENANT_A)).toBe(1);
    expect(await rowCount(getTenantSchemaName(TENANT_B), 'batches_v2', TENANT_A)).toBe(0);
    expect(await rowCount(getTenantSchemaName(TENANT_A), 'tank_allocations', TENANT_A)).toBe(1);
    expect(await rowCount(getTenantSchemaName(TENANT_B), 'tank_allocations', TENANT_A)).toBe(0);

    const tenantAAfterAllocate = await withTenantContext(TENANT_A, () =>
      batchRepository.findOne({ where: { id: batchA.id, tenantId: TENANT_A } }),
    );
    const tenantASourceSnapshot = await withTenantContext(TENANT_A, () =>
      batchService.getTankBatchStatus(fixtureA.sourceTank.id, TENANT_A),
    );

    expect(tenantAAfterAllocate?.status).toBe(BatchStatus.ACTIVE);
    expect(tenantASourceSnapshot?.primaryBatchId).toBe(batchA.id);
    expect(tenantASourceSnapshot?.totalQuantity).toBe(100);
    expect(Number(tenantASourceSnapshot?.totalBiomassKg)).toBe(1);

    await expect(
      withTenantContext(TENANT_B, () =>
        batchRepository.findOne({ where: { id: batchA.id, tenantId: TENANT_B } }),
      ),
    ).resolves.toBeNull();

    const transfer = await withTenantContext(TENANT_A, () =>
      batchCommands.transferBatch.execute(
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
          { clientCommandId: 'batch-transfer-a', payloadHash: 'batch-transfer-a-v1' },
        ),
      ),
    );

    expect(transfer.id).toBe(batchA.id);

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
        new ListBatchesQuery(
          TENANT_A,
          { tankId: fixtureA.destinationTank.id, searchTerm: 'BATCH-A' },
          1,
          10,
        ),
      ),
    );

    // Allocation rows are an append-only stock movement ledger: initial
    // stocking + transfer-out + transfer-in. Current stock is their per-tank
    // signed sum and is independently projected in TankBatch.
    expect(tenantAAllocations).toHaveLength(3);
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
        new ListBatchesQuery(
          TENANT_B,
          { tankId: fixtureA.destinationTank.id, searchTerm: 'BATCH-A' },
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

  async function createBatchTransferFixture(
    tenantId: string,
    codePrefix: string,
    initialQuantity: number,
  ): Promise<BatchTransferTenantFixtureV1> {
    const { tank: sourceTank, ...stocked } = await createStockedTenantFixtureV1(
      dataSource!,
      batchCommands,
      {
        tenantId,
        codePrefix,
        userId: USER_ID,
        initialQuantity,
        initialAvgWeightG: 10,
      },
    );
    const destinationTank = await createTankForTenant(
      tenantId,
      stocked.department.id,
      `${codePrefix} Destination Tank`,
      `${codePrefix}-DEST`,
    );

    return Object.freeze({ ...stocked, sourceTank, destinationTank });
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

  async function rowCount(schema: string, table: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource!.query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."${table}" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  function allocationQuantityFor(allocations: TankAllocation[], tankId: string): number {
    return allocations
      .filter((allocation) => allocation.tankId === tankId)
      .reduce((quantity, allocation) => quantity + Number(allocation.quantity), 0);
  }
});

async function createTenantSchema(dataSource: DataSource, schema: string): Promise<void> {
  await dataSource.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.query(`CREATE TABLE "${schema}"."sites" (LIKE "farm"."sites" INCLUDING ALL)`);
  await dataSource.query(
    `CREATE TABLE "${schema}"."departments" (LIKE "farm"."departments" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."systems" (LIKE "farm"."systems" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."sub_systems" (LIKE "farm"."sub_systems" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."equipment" (LIKE "farm"."equipment" INCLUDING ALL)`,
  );
  await dataSource.query(
    `CREATE TABLE "${schema}"."equipment_systems" (LIKE "farm"."equipment_systems" INCLUDING ALL)`,
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
}
