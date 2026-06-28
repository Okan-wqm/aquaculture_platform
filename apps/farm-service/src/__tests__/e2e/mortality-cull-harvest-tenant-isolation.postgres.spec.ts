/**
 * Mortality, cull, and harvest tenant-schema isolation tests.
 *
 * WHY: These stock-operation paths are high-risk for "database row exists but
 * frontend/mobile cannot see it" bugs. They mutate batch totals, tank snapshots,
 * operation history, mortality/harvest records, and outbox events in one
 * transaction. Tenant-owned business data must live only in the active tenant
 * schema; the source `farm` schema is a template/bootstrap schema, not a tenant
 * data store.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, Repository } from 'typeorm';

import {
  RecordCullCommand,
  CullReason as CullCommandReason,
} from '../../batch/commands/record-cull.command';
import {
  RecordMortalityCommand,
  MortalityReason as MortalityCommandReason,
} from '../../batch/commands/record-mortality.command';
import { Batch, BatchInputType, BatchStatus } from '../../batch/entities/batch.entity';
import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { MortalityRecord } from '../../batch/entities/mortality-record.entity';
import { TankAllocation, AllocationType } from '../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import { RecordCullHandler } from '../../batch/handlers/record-cull.handler';
import { RecordMortalityHandler } from '../../batch/handlers/record-mortality.handler';
import { BatchService } from '../../batch/services/batch.service';
import { MortalityCullPolicyService } from '../../batch/services/mortality-cull-policy.service';
import {
  Department,
  DepartmentStatus,
  DepartmentType,
} from '../../department/entities/department.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { CreateHarvestRecordCommand } from '../../harvest/commands/create-harvest-record.command';
import { DeleteHarvestRecordCommand } from '../../harvest/commands/delete-harvest-record.command';
import { HarvestPlan } from '../../harvest/entities/harvest-plan.entity';
import {
  HarvestRecord,
  HarvestRecordStatus,
  QualityGrade,
} from '../../harvest/entities/harvest-record.entity';
import { CreateHarvestRecordHandler } from '../../harvest/handlers/create-harvest-record.handler';
import { DeleteHarvestRecordHandler } from '../../harvest/handlers/delete-harvest-record.handler';
import { ListHarvestsHandler } from '../../harvest/handlers/list-harvests.handler';
import { ListHarvestsQuery } from '../../harvest/queries/list-harvests.query';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import {
  Species,
  SpeciesCategory,
  SpeciesStatus,
  SpeciesWaterType,
} from '../../species/entities/species.entity';
import { Site, SiteStatus, SiteType } from '../../site/entities/site.entity';
import { SubSystem } from '../../system/entities/sub-system.entity';
import { System } from '../../system/entities/system.entity';
import {
  Tank,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../tank/entities/tank.entity';
import {
  createFarmOutboxTable,
  createSourceEquipmentTypesReferenceTable,
  createTenantSchemaFromSource,
} from './helpers/tenant-schema-harness';

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const TENANT_B = '7c2f4e10-3d2a-4b4e-9f18-f8b16f0d5a10';
const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';
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
  'tank_allocations',
  'tank_batches',
  'tank_operations',
  'mortality_records',
  'harvest_plans',
  'harvest_records',
] as const;

interface TenantFixture {
  site: Site;
  department: Department;
  species: Species;
  tank: Tank;
  batch: Batch;
}

jest.setTimeout(120_000);

describe('Mortality, cull, and harvest tenant isolation on real Postgres', () => {
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
  let mortalityRepository: Repository<MortalityRecord>;
  let equipmentRepository: Repository<Equipment>;
  let equipmentTypeRepository: Repository<EquipmentType>;
  let harvestRepository: Repository<HarvestRecord>;
  let batchService: BatchService;
  let recordMortality: RecordMortalityHandler;
  let recordCull: RecordCullHandler;
  let createHarvest: CreateHarvestRecordHandler;
  let deleteHarvest: DeleteHarvestRecordHandler;
  let listHarvests: ListHarvestsHandler;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    await createSourceEquipmentTypesReferenceTable(pg.dataSource);

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-stock-ops-${randomBytes(4).toString('hex')}`,
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
        MortalityRecord,
        HarvestPlan,
        HarvestRecord,
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

    siteRepository = dataSource.getRepository(Site);
    departmentRepository = dataSource.getRepository(Department);
    speciesRepository = dataSource.getRepository(Species);
    tankRepository = dataSource.getRepository(Tank);
    batchRepository = dataSource.getRepository(Batch);
    allocationRepository = dataSource.getRepository(TankAllocation);
    tankBatchRepository = dataSource.getRepository(TankBatch);
    operationRepository = dataSource.getRepository(TankOperation);
    mortalityRepository = dataSource.getRepository(MortalityRecord);
    equipmentRepository = dataSource.getRepository(Equipment);
    equipmentTypeRepository = dataSource.getRepository(EquipmentType);
    harvestRepository = dataSource.getRepository(HarvestRecord);

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
    const harvestEligibility = {
      checkEligibility: jest.fn().mockResolvedValue({
        eligible: true,
        blockingEvents: [],
      }),
    };
    const harvestPolicy = {
      evaluate: jest.fn().mockResolvedValue(undefined),
    };
    // FARM-MEDIUM-054 / FARM-HIGH-052: mortality/cull handlers now also take an
    // AuditLogService, the shared MortalityCullPolicyService, the farm-stock
    // projection, and the MobileCommandReceiptService. This tenant-ISOLATION e2e
    // syncs only the batch/tank/operation/mortality/harvest entities — the
    // farm_audit_logs and farm_mobile_command_receipts tables are out of its
    // schema set — so audit + receipt collaborators are stubbed (their own unit
    // specs cover them) while the policy guards run for real against the DB rows.
    const auditLogService = { logWithManager: jest.fn().mockResolvedValue(undefined) };
    const mortalityCullPolicy = new MortalityCullPolicyService();
    const farmStockProjection = { refreshContainers: jest.fn().mockResolvedValue(undefined) };
    const mobileCommandReceipts = {
      // A non-legacy 'started' receipt lets the stock-mutating handler proceed
      // without touching the receipts table; complete() is a no-op stub.
      begin: jest.fn().mockResolvedValue({ mode: 'started', receiptId: randomBytes(8).toString('hex') }),
      complete: jest.fn().mockResolvedValue(undefined),
    };
    recordMortality = new RecordMortalityHandler(
      dataSource,
      batchRepository,
      mortalityRepository,
      operationRepository,
      tankBatchRepository,
      equipmentRepository,
      tankRepository,
      equipmentTypeRepository,
      outboxPublisher,
      backdatePolicy as never,
      auditLogService as never,
      // SEC-HIGH-051: the real fail-closed SSoT; commands below pass
      // MODULE_MANAGER so site authz bypasses for this tenant-isolation e2e.
      new SiteAuthorizationService(),
      mortalityCullPolicy,
      farmStockProjection as never,
      mobileCommandReceipts as never,
    );
    recordCull = new RecordCullHandler(
      dataSource,
      batchRepository,
      operationRepository,
      tankBatchRepository,
      equipmentRepository,
      outboxPublisher,
      auditLogService as never,
      new SiteAuthorizationService(),
      mortalityCullPolicy,
      farmStockProjection as never,
      mobileCommandReceipts as never,
    );
    // Final-harvest auto-close (CloseBatchCommand) is dispatched via the
    // CommandBus and exercised by the unit spec; this DB-isolation e2e stubs
    // it as a no-op so the harvest path under test is unaffected.
    const commandBus = { execute: jest.fn().mockResolvedValue(undefined) };
    createHarvest = new CreateHarvestRecordHandler(
      dataSource,
      outboxPublisher,
      commandBus as never,
      harvestEligibility as never,
      backdatePolicy as never,
      harvestPolicy as never,
      harvestRepository,
      batchRepository,
      operationRepository,
      tankBatchRepository,
      tankRepository,
      new SiteAuthorizationService(),
      // CreateHarvestRecordHandler also defaults farmStockProjection +
      // mobileCommandReceipts to throwing test-only stubs; this isolation e2e
      // must supply working no-op stubs (same rationale as the mortality/cull
      // handlers above) or the harvest path throws before the tenant-isolation
      // assertions run.
      farmStockProjection as never,
      mobileCommandReceipts as never,
    );
    deleteHarvest = new DeleteHarvestRecordHandler(
      harvestRepository,
      batchRepository,
      tankBatchRepository,
      tankRepository,
      dataSource,
      outboxPublisher,
      // DeleteHarvestRecordHandler also defaults farmStockProjection to a
      // throwing test-only stub; supply the working no-op so the delete path
      // reaches the tenant-isolation assertions.
      farmStockProjection as never,
    );
    listHarvests = new ListHarvestsHandler(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await shutdownHarness(pg);
  });

  it('keeps stock operations in each tenant schema and immediately visible to tenant reads', async () => {
    const fixtureA = await createTenantFixture(TENANT_A, 'OPS-A');
    const fixtureB = await createTenantFixture(TENANT_B, 'OPS-B');

    await withTenantContext(TENANT_B, () =>
      recordMortality.execute(
        new RecordMortalityCommand(
          TENANT_B,
          fixtureB.batch.id,
          {
            tankId: fixtureB.tank.id,
            quantity: 3,
            avgWeightG: 10,
            reason: MortalityCommandReason.STRESS,
            observedAt: new Date('2026-04-29T08:00:00.000Z'),
            notes: 'tenant-b control mortality',
          },
          USER_ID,
          [Role.MODULE_MANAGER],
          [],
        ),
      ),
    );

    await withTenantContext(TENANT_A, () =>
      recordMortality.execute(
        new RecordMortalityCommand(
          TENANT_A,
          fixtureA.batch.id,
          {
            tankId: fixtureA.tank.id,
            quantity: 10,
            avgWeightG: 10,
            reason: MortalityCommandReason.WATER_QUALITY,
            observedAt: new Date('2026-04-29T09:00:00.000Z'),
            notes: 'tenant-a mortality',
          },
          USER_ID,
          [Role.MODULE_MANAGER],
          [],
        ),
      ),
    );

    await withTenantContext(TENANT_A, () =>
      recordCull.execute(
        new RecordCullCommand(
          TENANT_A,
          fixtureA.batch.id,
          {
            tankId: fixtureA.tank.id,
            quantity: 5,
            avgWeightG: 10,
            reason: CullCommandReason.DEFORMED,
            detail: 'grading deformity',
            culledAt: new Date('2026-04-29T10:00:00.000Z'),
            notes: 'tenant-a cull from legacy tanks table',
          },
          USER_ID,
          [Role.MODULE_MANAGER],
          [],
        ),
      ),
    );

    const harvest = await withTenantContext(TENANT_A, () =>
      createHarvest.execute(
        new CreateHarvestRecordCommand(
          TENANT_A,
          {
            batchId: fixtureA.batch.id,
            tankId: fixtureA.tank.id,
            quantityHarvested: 20,
            averageWeight: 10,
            totalBiomass: 0.2,
            qualityGrade: QualityGrade.GRADE_A,
            harvestDate: new Date('2026-04-29T11:00:00.000Z'),
            buyerName: 'Tenant A Buyer',
            pricePerKg: 5,
            notes: 'tenant-a harvest',
          },
          USER_ID,
          [Role.MODULE_MANAGER],
          [],
        ),
      ),
    );

    expect(await tenantRowCount('mortality_records', TENANT_A)).toBe(1);
    expect(await tenantRowCount('mortality_records', TENANT_B)).toBe(1);
    expect(await sourceTenantRowCount('mortality_records', TENANT_A)).toBe(0);
    expect(await tenantRowCount('tank_operations', TENANT_A)).toBe(3);
    expect(await tenantRowCount('tank_operations', TENANT_B)).toBe(1);
    expect(await sourceTenantRowCount('tank_operations', TENANT_A)).toBe(0);
    expect(await tenantRowCount('harvest_records', TENANT_A)).toBe(1);
    expect(await tenantRowCount('harvest_records', TENANT_B)).toBe(0);
    expect(await sourceTenantRowCount('harvest_records', TENANT_A)).toBe(0);

    const tenantABatch = await withTenantContext(TENANT_A, () =>
      batchRepository.findOneOrFail({ where: { id: fixtureA.batch.id, tenantId: TENANT_A } }),
    );
    const tenantATankBatch = await withTenantContext(TENANT_A, () =>
      tankBatchRepository.findOneOrFail({
        where: { tenantId: TENANT_A, tankId: fixtureA.tank.id },
      }),
    );
    const tenantATank = await withTenantContext(TENANT_A, () =>
      tankRepository.findOneOrFail({ where: { id: fixtureA.tank.id, tenantId: TENANT_A } }),
    );
    const tenantBReadForTenantABatch = await withTenantContext(TENANT_B, () =>
      harvestRepository.find({ where: { tenantId: TENANT_B, batchId: fixtureA.batch.id } }),
    );
    const tenantAHarvestList = await withTenantContext(TENANT_A, () =>
      listHarvests.execute(
        new ListHarvestsQuery(
          TENANT_A,
          { batchId: fixtureA.batch.id, tankId: fixtureA.tank.id },
          { page: 1, limit: 10, sortBy: 'harvestDate', sortOrder: 'DESC' },
        ),
      ),
    );

    expect(tenantABatch.currentQuantity).toBe(65);
    expect(tenantABatch.totalMortality).toBe(10);
    expect(tenantABatch.cullCount).toBe(5);
    expect(tenantABatch.harvestedQuantity).toBe(20);
    expect(tenantATankBatch.totalQuantity).toBe(65);
    expect(Number(tenantATankBatch.totalBiomassKg)).toBe(0.65);
    expect(tenantATank.currentCount).toBe(65);
    expect(Number(tenantATank.currentBiomass)).toBe(0.65);
    expect(tenantBReadForTenantABatch).toHaveLength(0);
    expect(tenantAHarvestList.data.map((record) => record.id)).toEqual([harvest.id]);

    await withTenantContext(TENANT_A, () =>
      deleteHarvest.execute(new DeleteHarvestRecordCommand(TENANT_A, harvest.id, USER_ID)),
    );

    const tenantAAfterDeleteBatch = await withTenantContext(TENANT_A, () =>
      batchRepository.findOneOrFail({ where: { id: fixtureA.batch.id, tenantId: TENANT_A } }),
    );
    const tenantAAfterDeleteTankBatch = await withTenantContext(TENANT_A, () =>
      tankBatchRepository.findOneOrFail({
        where: { tenantId: TENANT_A, tankId: fixtureA.tank.id },
      }),
    );
    const tenantAAfterDeleteHarvest = await withTenantContext(TENANT_A, () =>
      harvestRepository.findOneOrFail({ where: { id: harvest.id, tenantId: TENANT_A } }),
    );

    expect(tenantAAfterDeleteBatch.currentQuantity).toBe(85);
    expect(tenantAAfterDeleteBatch.harvestedQuantity).toBe(0);
    expect(tenantAAfterDeleteTankBatch.totalQuantity).toBe(85);
    expect(Number(tenantAAfterDeleteTankBatch.totalBiomassKg)).toBe(0.85);
    expect(tenantAAfterDeleteHarvest.status).toBe(HarvestRecordStatus.CANCELLED);
    expect(await sourceTenantRowCount('batches_v2', TENANT_A)).toBe(0);
    expect(await sourceTenantRowCount('tank_batches', TENANT_A)).toBe(0);

    const tenantAOutboxRows = await outboxRows(TENANT_A);
    const tenantBOutboxRows = await outboxRows(TENANT_B);
    // HarvestRecordCancelled is emitted by the delete-harvest step (now wired
    // with a working farmStockProjection stub) — it is correctly tenant-scoped
    // to TENANT_A's outbox, which is exactly what this isolation e2e asserts.
    expect(tenantAOutboxRows.map((row) => row.eventType).sort()).toEqual([
      'BatchHarvested',
      'CullRecorded',
      'HarvestRecordCancelled',
      'MortalityRecorded',
    ]);
    expect(tenantBOutboxRows.map((row) => row.eventType)).toEqual(['MortalityRecorded']);
    expect(tenantAOutboxRows.every((row) => row.payload?.tenantId === TENANT_A)).toBe(true);
  });

  async function createTenantFixture(tenantId: string, codePrefix: string): Promise<TenantFixture> {
    const site = await withTenantContext(tenantId, () =>
      siteRepository.save(
        siteRepository.create({
          tenantId,
          name: `${codePrefix} Site`,
          code: `${codePrefix}-SITE`,
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
          name: `${codePrefix} Department`,
          code: `${codePrefix}-DEPT`,
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
          code: `${codePrefix}-SALMON`,
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
          name: `${codePrefix} Tank`,
          code: `${codePrefix}-TANK`,
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
        batchNumber: `${codePrefix}-BATCH`,
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

    return { site, department, species, tank, batch };
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
