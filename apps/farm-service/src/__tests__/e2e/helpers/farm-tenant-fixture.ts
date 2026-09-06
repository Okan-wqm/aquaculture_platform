/**
 * Shared stocked-tank fixture for real-Postgres e2e suites.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED
 *
 * Any suite that exercises a path touching per-tank biomass needs the same
 * chain of rows before it can assert anything: a site, a department under it, a
 * species, a tank, a batch, and the allocation that puts the batch in the tank.
 * That chain is not incidental — `TankBatch` carries real foreign keys to
 * `tanks` and `batches_v2`, and `BiomassGrowthApplierService` refuses to act on
 * a unit whose `batchDetails[]` names batches it cannot load. So the fixture is
 * a precondition of the code under test, not of any one test.
 *
 * Copying it per suite would mean the stocking semantics (initial count, weight,
 * allocation type) drift apart silently, and every suite would encode its own
 * idea of what a stocked tank looks like. Here there is one.
 *
 * Note that the batch and its allocation are created through the PRODUCTION
 * COMMAND HANDLERS — `CreateBatchHandler` and `AllocateToTankHandler` — not by
 * inserting rows: `applyBatchDelta` (reached through the allocate handler) is
 * what writes `batchDetails[]` in the shape the growth applier later reads.
 * Hand-inserting a TankBatch would produce a row that no production path could
 * have produced, and the suites built on it would prove nothing about production.
 *
 * This used to drive `BatchService.allocateBatchToTank` and call THAT the
 * production path. It stopped being one: nothing in production calls
 * `BatchService` any more — the GraphQL mutations and the REST controller both
 * route through the command bus (`farm-rest-cqrs-ssot`). So the fixture was
 * building rows through a write shadow while its own docblock promised the
 * opposite, and the shadow had drifted from the handler it stood in for (which
 * has since gained a SERIALIZABLE transaction, pessimistic locks, mobile
 * command receipts, object-level site authorization and the single-writer
 * routing). FARM-HIGH-109 / FARM-LOW-211.
 *
 * ALWAYS `manager.create(Entity, {...})` BEFORE `manager.save(...)`.
 *
 * TypeORM invokes an entity lifecycle listener as `entity[method]()`, so a
 * listener declared as a class METHOD only fires when the saved object really is
 * an instance of that class. `manager.save(Tank, {...plain object})` compiles,
 * type-checks and inserts — and silently skips the hook, because a plain object
 * has no such method. `Tank.calculateVolume()` is exactly that shape
 * (`@BeforeInsert` + `@BeforeUpdate`, deriving `volume` from diameter/depth), so
 * the plain-object form produced `null value in column "volume"` — a NOT NULL
 * violation for a column no caller sets by hand, because nothing is supposed to.
 * Constructing through `create()` first is the zero-effort default that keeps
 * every current and future hook alive.
 */
import { withTenantContext } from '@aquaculture/backend-common';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Role } from '@aquaculture/backend-common/decorators';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AllocateToTankCommand } from '../../../batch/commands/allocate-to-tank.command';
import { CreateBatchCommand } from '../../../batch/commands/create-batch.command';
import { Batch, BatchInputType } from '../../../batch/entities/batch.entity';
import { BatchDocument } from '../../../batch/entities/batch-document.entity';
import { TankAllocation, AllocationType } from '../../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { AllocateToTankHandler } from '../../../batch/handlers/allocate-to-tank.handler';
import { CreateBatchHandler } from '../../../batch/handlers/create-batch.handler';
import { TankBatchService } from '../../../batch/services/tank-batch.service';
import { AuditLog } from '../../../database/entities/audit-log.entity';
import { CodeSequence } from '../../../database/entities/code-sequence.entity';
import { AuditLogService } from '../../../database/services/audit-log.service';
import { CodeGeneratorService } from '../../../database/services/code-generator.service';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { EquipmentType } from '../../../equipment/entities/equipment-type.entity';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import { FinanceSettingsService } from '../../../finance/services/finance-settings.service';
import { BatchLocation } from '../../../batch/entities/batch-location.entity';
import { MortalityRecord } from '../../../batch/entities/mortality-record.entity';
import { EquipmentSystem } from '../../../equipment/entities/equipment-system.entity';
import { Farm } from '../../../farm/entities/farm.entity';
import { Pond } from '../../../farm/entities/pond.entity';
import { Feed } from '../../../feed/entities/feed.entity';
import { FeedTypeSpecies } from '../../../feed/entities/feed-type-species.entity';
import { FeedingProtocol } from '../../../feed/entities/feeding-protocol.entity';
import { FeedingRecord } from '../../../feeding/entities/feeding-record.entity';
import { GrowthMeasurement } from '../../../growth/entities/growth-measurement.entity';
import { SiteContact } from '../../../site/entities/site-contact.entity';
import { Supplier } from '../../../supplier/entities/supplier.entity';
import { SupplierSite } from '../../../supplier/entities/supplier-site.entity';
import { FarmOutbox } from '../../../outbox/farm-outbox.entity';
import { SubSystem } from '../../../system/entities/sub-system.entity';
import { System } from '../../../system/entities/system.entity';
import { TankCapacityService } from '../../../tank/services/tank-capacity.service';
import {
  Department,
  DepartmentStatus,
  DepartmentType,
} from '../../../department/entities/department.entity';
import {
  Species,
  SpeciesCategory,
  SpeciesStatus,
  SpeciesWaterType,
} from '../../../species/entities/species.entity';
import { Site, SiteStatus, SiteType } from '../../../site/entities/site.entity';
import {
  Tank,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../../tank/entities/tank.entity';

export interface FarmTenantFixture {
  site: Site;
  department: Department;
  species: Species;
  tank: Tank;
  batch: Batch;
}

export interface FarmTenantFixtureParams {
  tenantId: string;
  /** Prefix for every generated name/code so parallel tenants stay distinct. */
  codePrefix: string;
  userId: string;
  /** Fish stocked into the tank. Default 100. */
  initialQuantity?: number;
  /** Average weight at stocking, grams. Default 10 (→ 1 kg per 100 fish). */
  initialAvgWeightG?: number;
}

/**
 * The entities the fixture's production writers require on a suite's DataSource.
 *
 * A suite spreads this instead of hand-listing, because the list is a property
 * of the WRITERS, not of the suite: routing the fixture through the real
 * command handlers (FARM-HIGH-109) made it need `Equipment`, `CodeSequence` and
 * `AuditLog` — which every suite had omitted, since the write shadow it
 * replaced never touched them. Hand-listing meant each suite discovered that
 * one `EntityMetadataNotFoundError` at a time.
 */
export const FIXTURE_ENTITIES = [
  Site,
  Department,
  Species,
  Tank,
  // Equipment's relation graph: it points at EquipmentType and SubSystem, and
  // SubSystem at System. TypeORM resolves a relation target only if the target
  // is registered too, so the CLOSURE belongs here — not the one entity a
  // suite happened to trip over first.
  Equipment,
  EquipmentType,
  SubSystem,
  System,
  EquipmentSystem,
  Batch,
  BatchDocument,
  BatchLocation,
  TankAllocation,
  TankBatch,
  CodeSequence,
  AuditLog,
  FarmOutbox,
  // The rest of Equipment/Site/Batch's relation closure. TypeORM resolves a
  // relation only when its TARGET is registered, so metadata construction needs
  // the whole graph even though the fixture writes none of these. Registering
  // is not cloning: FIXTURE_TENANT_TABLES stays limited to what is written.
  Farm,
  Pond,
  SiteContact,
  Supplier,
  SupplierSite,
  Feed,
  FeedTypeSpecies,
  FeedingProtocol,
  FeedingRecord,
  GrowthMeasurement,
  MortalityRecord,
] as const;

/**
 * The PER-TENANT tables the fixture writes, to clone into the tenant schema.
 *
 * `farm_audit_logs` is deliberately absent: it declares `schema: 'farm'` and is
 * cross-tenant infrastructure (ADR-011), so it stays in the source schema. Same
 * for `farm_outbox`.
 */
export const FIXTURE_TENANT_TABLES = [
  'sites',
  'departments',
  'tanks',
  'species',
  'equipment',
  'equipment_types',
  'sub_systems',
  'systems',
  'batches_v2',
  'batch_documents',
  'tank_allocations',
  'tank_batches',
  'code_sequences',
  'farm_stock_container_snapshots',
  'farm_stock_batch_snapshots',
] as const;

/** The production command handlers a fixture needs to stock a tank. */
export interface FixtureBatchWriters {
  createBatch: CreateBatchHandler;
  allocateToTank: AllocateToTankHandler;
}

/**
 * Builds the production command handlers the fixture drives.
 *
 * Lives here rather than in each suite so the raw `Repository<T>` wiring exists
 * ONCE per service's test tree. A production handler constructor declares plain
 * repositories and there is no tenant-scoped equivalent of that shape, so some
 * test-support file has to produce them; concentrating it here is what lets the
 * banned-construct gate keep the rule on every spec.
 *
 * Every collaborator here is the REAL one. Two of them are worth naming:
 *
 * - `OutboxPublisher` is bound to the real `FarmOutbox` entity, so stocking a
 *   fixture tank enqueues the same outbox rows production would. The throwing
 *   `default*ForDirectHandlerConstruction` stubs cannot stand in: the allocate
 *   handler genuinely enqueues, and genuinely calls `refreshContainers`.
 * - `MobileCommandReceiptService` is real but inert here — `begin()` returns
 *   `{ mode: 'legacy' }` when the command carries no mobile envelope, which is
 *   the case for every fixture write.
 */
export function createFixtureBatchWriters(dataSource: DataSource): FixtureBatchWriters {
  const outboxPublisher = new OutboxPublisher(FarmOutbox);
  const tankCapacityService = new TankCapacityService();
  const tankBatchService = new TankBatchService();

  const createBatch = new CreateBatchHandler(
    dataSource,
    dataSource.getRepository(Batch),
    dataSource.getRepository(BatchDocument),
    dataSource.getRepository(Species),
    dataSource.getRepository(TankBatch),
    dataSource.getRepository(Equipment),
    new CodeGeneratorService(dataSource.getRepository(CodeSequence), dataSource),
    outboxPublisher,
    tankCapacityService,
    new FinanceSettingsService(dataSource),
  );

  const allocateToTank = new AllocateToTankHandler(
    dataSource.getRepository(Batch),
    dataSource.getRepository(TankAllocation),
    dataSource.getRepository(TankBatch),
    dataSource.getRepository(Equipment),
    dataSource,
    outboxPublisher,
    tankCapacityService,
    new AuditLogService(dataSource.getRepository(AuditLog)),
    new SiteAuthorizationService(),
    tankBatchService,
    new FarmStockProjectionService(),
    new MobileCommandReceiptService(),
  );

  return { createBatch, allocateToTank };
}

/**
 * Creates site → department → species → tank → batch → allocation for one
 * tenant, inside that tenant's schema.
 */
export async function createFarmTenantFixture(
  dataSource: DataSource,
  writers: FixtureBatchWriters,
  params: FarmTenantFixtureParams,
): Promise<FarmTenantFixture> {
  const { tenantId, codePrefix, userId } = params;
  const initialQuantity = params.initialQuantity ?? 100;
  const initialAvgWeightG = params.initialAvgWeightG ?? 10;
  const manager = dataSource.manager;

  const site = await withTenantContext(tenantId, () =>
    manager.save(
      manager.create(Site, {
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
    manager.save(
      manager.create(Department, {
        tenantId,
        siteId: site.id,
        name: `${codePrefix} Department`,
        code: `${codePrefix}-DEPT`,
        type: DepartmentType.PRODUCTION,
        status: DepartmentStatus.ACTIVE,
        isActive: true,
        isDeleted: false,
        createdBy: userId,
        updatedBy: userId,
      }),
    ),
  );

  const species = await withTenantContext(tenantId, () =>
    manager.save(
      manager.create(Species, {
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
        createdBy: userId,
        updatedBy: userId,
      }),
    ),
  );

  const tank = await withTenantContext(tenantId, () =>
    manager.save(
      manager.create(Tank, {
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
        currentBiomass: (initialQuantity * initialAvgWeightG) / 1000,
        currentCount: initialQuantity,
        maxDensity: 30,
        status: TankStatus.ACTIVE,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      }),
    ),
  );

  const batch = await withTenantContext(tenantId, () =>
    writers.createBatch.execute(
      new CreateBatchCommand(
        tenantId,
        {
          batchNumber: `${codePrefix}-BATCH`,
          speciesId: species.id,
          inputType: BatchInputType.FRY,
          initialQuantity,
          initialAvgWeightG,
          stockedAt: new Date('2026-04-29T00:00:00.000Z'),
          currency: 'USD',
        },
        userId,
      ),
    ),
  );

  await withTenantContext(tenantId, () =>
    writers.allocateToTank.execute(
      new AllocateToTankCommand(
        tenantId,
        batch.id,
        {
          tankId: tank.id,
          quantity: initialQuantity,
          avgWeightG: initialAvgWeightG,
          allocationType: AllocationType.INITIAL_STOCKING,
        },
        userId,
        // MODULE_MANAGER: the fixture is not exercising the site-assignment
        // gate, and a manager bypasses it (SEC-HIGH-051). Passing [] roles
        // would make every fixture fail the object-level site check instead.
        [Role.MODULE_MANAGER],
      ),
    ),
  );

  return { site, department, species, tank, batch };
}
