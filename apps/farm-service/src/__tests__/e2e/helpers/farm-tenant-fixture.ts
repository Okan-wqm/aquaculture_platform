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
import { ConfigService } from '@nestjs/config';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AllocateToTankCommand } from '../../../batch/commands/allocate-to-tank.command';
import { CreateBatchCommand } from '../../../batch/commands/create-batch.command';
import { Batch, BatchInputType } from '../../../batch/entities/batch.entity';
import { BatchDocument } from '../../../batch/entities/batch-document.entity';
import { TankAllocation, AllocationType } from '../../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { TankOperation } from '../../../batch/entities/tank-operation.entity';
import { AllocateToTankHandler } from '../../../batch/handlers/allocate-to-tank.handler';
import { CreateBatchHandler } from '../../../batch/handlers/create-batch.handler';
import { RecordMortalityHandler } from '../../../batch/handlers/record-mortality.handler';
import { TransferBatchHandler } from '../../../batch/handlers/transfer-batch.handler';
import { GetBatchHandler } from '../../../batch/query-handlers/get-batch.handler';
import { MortalityCullPolicyService } from '../../../batch/services/mortality-cull-policy.service';
import { RemovalQuantityPolicyService } from '../../../batch/services/removal-quantity-policy.service';
import { BackdatePolicyService } from '../../../common/services/backdate-policy.service';
import { FeedingDayPlan } from '../../../feeding-protocol/entities/feeding-day-plan.entity';
import { FeedingMeal } from '../../../feeding-protocol/entities/feeding-meal.entity';
import { FeedingProtocolV2 } from '../../../feeding-protocol/entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../../../feeding-protocol/entities/protocol-assignment.entity';
import { BiomassGrowthApplierService } from '../../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import { ProtocolRateService } from '../../../feeding-protocol/services/protocol-rate.service';
import { ProtocolResolutionService } from '../../../feeding-protocol/services/protocol-resolution.service';
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
import { FeedingProgram } from '../../../feeding/entities/feeding-program.entity';
import { FeedingProgramTank } from '../../../feeding/entities/feeding-program-tank.entity';
import { FeedingRecord } from '../../../feeding/entities/feeding-record.entity';
import { GrowthMeasurement } from '../../../growth/entities/growth-measurement.entity';
import { RecordGrowthSampleHandler } from '../../../growth/handlers/record-growth-sample.handler';
import { FCRCalculationService } from '../../../growth/services/fcr-calculation.service';
import { GrowthSampleApplierService } from '../../../growth/services/growth-sample-applier.service';
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

/** A tank stocked with one batch. */
export interface StockedTank {
  tank: Tank;
  batch: Batch;
}

export interface FarmTenantFixture extends StockedTank {
  site: Site;
  department: Department;
  species: Species;
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
  // The transfer handler records TRANSFER_OUT / TRANSFER_IN rows.
  TankOperation,
  CodeSequence,
  AuditLog,
  FarmOutbox,
  // The rest of Equipment/Site/Batch's relation closure. TypeORM resolves a
  // relation only when its TARGET is registered, so metadata construction needs
  // the whole graph even though the fixture writes none of these. Registering
  // is not cloning: `createTenantSchemaDerived` decides what each tenant schema
  // gets, from the entities' own schema declarations.
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
  // TransferBatchHandler recalculates the affected units' day plans
  // (transfer-batch.handler.ts:524), so the feeding-protocol closure is part of
  // the writers' requirement too — this is the exact entity FARM-HIGH-316's
  // original incident tripped over.
  FeedingProtocolV2,
  ProtocolAssignment,
  FeedingDayPlan,
  FeedingMeal,
] as const;

/**
 * The production audit writer over the fixture DataSource, for suites whose
 * handlers write farm_audit_logs in their transaction. The raw repository it
 * needs is wired here, beside the batch writers', so specs never name one.
 */
export function createFixtureAuditLogService(dataSource: DataSource): AuditLogService {
  return new AuditLogService(dataSource.getRepository(AuditLog));
}

/**
 * The entities the FCR authority reads on top of FIXTURE_ENTITIES: its target
 * chain falls back to the legacy feeding program of the batch's tank.
 */
export const FCR_AUTHORITY_ENTITIES = [FeedingProgram, FeedingProgramTank] as const;

/**
 * The production FCR authority over the fixture DataSource, with every
 * repository it reads. It lives beside the other writers for the same reason:
 * the raw repository wiring exists once per service's test tree, and specs
 * never name a repository. The DataSource must register FIXTURE_ENTITIES and
 * FCR_AUTHORITY_ENTITIES.
 */
export function createFixtureFcrCalculationService(dataSource: DataSource): FCRCalculationService {
  return new FCRCalculationService(
    dataSource.getRepository(FeedingRecord),
    dataSource.getRepository(GrowthMeasurement),
    dataSource.getRepository(Batch),
    dataSource.getRepository(Species),
    dataSource.getRepository(BatchLocation),
    dataSource.getRepository(FeedingProgram),
    dataSource.getRepository(FeedingProgramTank),
    dataSource.getRepository(TankOperation),
    new ProtocolRateService(),
  );
}

/**
 * The production handlers that weigh a stocked batch and remove fish from it.
 *
 * WHY they are built here: a weighing is more than `weight.actual.avgWeight`.
 * RecordGrowthSampleHandler also writes the provenance the FCR authority reads
 * with it (`lastMeasuredAt`, `sampleSize`), the `totalBiomass` it derives from
 * the typed `populationSize`, and a GrowthMeasurement row, and
 * RecordMortalityHandler writes the ledger row (count and the biomass
 * RemovalQuantityPolicy rounds) that the FCR authority cuts by day and counts
 * the head count at a weighing from. A suite that patched the JSON or the
 * ledger by hand would miss exactly the fields a window or provenance defect
 * lives in.
 *
 * Every collaborator is the real one, as in createFixtureBatchWriters. The
 * DataSource must register FIXTURE_ENTITIES and FCR_AUTHORITY_ENTITIES, and the
 * suite must create the farm-stock read model (which carries the mobile
 * command receipts table the mortality path writes).
 */
export interface FixtureBatchRecorders {
  recordGrowthSample: RecordGrowthSampleHandler;
  recordMortality: RecordMortalityHandler;
}

export function createFixtureBatchRecorders(dataSource: DataSource): FixtureBatchRecorders {
  const outboxPublisher = new OutboxPublisher(FarmOutbox);
  // No backdate env override: the production defaults (growth 30 days,
  // mortality 14 days) apply.
  const backdatePolicy = new BackdatePolicyService(new ConfigService());
  const dayPlanRecalc = new DayPlanRecalcService(
    outboxPublisher,
    new ProtocolResolutionService(new ProtocolRateService()),
  );
  const farmStockProjection = new FarmStockProjectionService();
  // A weighing moves the tank it weighed and reprices that tank's live day
  // plan (FARM-CRITICAL-454), so the recorder carries the real unit writer,
  // recalc and read-model projection.
  const growthApplier = new BiomassGrowthApplierService();

  const recordGrowthSample = new RecordGrowthSampleHandler(
    dataSource,
    dataSource.getRepository(GrowthMeasurement),
    dataSource.getRepository(Batch),
    createFixtureFcrCalculationService(dataSource),
    backdatePolicy,
    outboxPublisher,
    growthApplier,
    new GrowthSampleApplierService(growthApplier, dayPlanRecalc, farmStockProjection),
  );

  const recordMortality = new RecordMortalityHandler(
    dataSource,
    dataSource.getRepository(Batch),
    dataSource.getRepository(MortalityRecord),
    dataSource.getRepository(TankOperation),
    dataSource.getRepository(TankBatch),
    dataSource.getRepository(Equipment),
    dataSource.getRepository(Tank),
    dataSource.getRepository(EquipmentType),
    outboxPublisher,
    dayPlanRecalc,
    new RemovalQuantityPolicyService(),
    backdatePolicy,
    new AuditLogService(dataSource.getRepository(AuditLog)),
    new SiteAuthorizationService(),
    new TankBatchService(),
    new MortalityCullPolicyService(),
    farmStockProjection,
    new MobileCommandReceiptService(),
  );

  return { recordGrowthSample, recordMortality };
}

/** The production command handlers a fixture needs to stock a tank. */
export interface FixtureBatchWriters {
  createBatch: CreateBatchHandler;
  allocateToTank: AllocateToTankHandler;
  transferBatch: TransferBatchHandler;
  /** The production read path, so a suite asserting visibility uses it too. */
  getBatch: GetBatchHandler;
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
  const farmStockProjection = new FarmStockProjectionService();

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
    // Initial stocking writes tank composition through the SAME single writer
    // the allocate and transfer writers below use (FARM-HIGH-139), so the
    // fixture's rows are shaped by production's SSoT rather than by a
    // hand-mutation this handler no longer performs.
    tankBatchService,
    farmStockProjection,
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
    farmStockProjection,
    new MobileCommandReceiptService(),
  );

  const transferBatch = new TransferBatchHandler(
    dataSource,
    dataSource.getRepository(Batch),
    dataSource.getRepository(TankAllocation),
    dataSource.getRepository(TankOperation),
    dataSource.getRepository(TankBatch),
    dataSource.getRepository(Equipment),
    dataSource.getRepository(Tank),
    dataSource.getRepository(EquipmentType),
    outboxPublisher,
    new DayPlanRecalcService(
      outboxPublisher,
      new ProtocolResolutionService(new ProtocolRateService()),
    ),
    new RemovalQuantityPolicyService(),
    tankCapacityService,
    new SiteAuthorizationService(),
    tankBatchService,
    farmStockProjection,
    new MobileCommandReceiptService(),
  );

  return { createBatch, allocateToTank, transferBatch, getBatch: new GetBatchHandler(dataSource) };
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

  const { tank, batch } = await stockFixtureTank(
    dataSource,
    writers,
    { department, species },
    params,
  );

  return { site, department, species, tank, batch };
}

/**
 * Creates tank → batch → allocation in an existing tenant fixture's department
 * and species, through the same production writers.
 *
 * WHY it is separate: a tenant holds one species per scientific name (unique
 * per tenant), so a suite that needs two batches in one tenant (one sweep over
 * both) cannot create a second tenant fixture; it stocks a second tank here.
 * `params.codePrefix` names the new tank and batch and must differ from the
 * fixture's.
 */
export async function stockFixtureTank(
  dataSource: DataSource,
  writers: FixtureBatchWriters,
  base: Pick<FarmTenantFixture, 'department' | 'species'>,
  params: FarmTenantFixtureParams,
): Promise<StockedTank> {
  const { tenantId, codePrefix, userId } = params;
  const initialQuantity = params.initialQuantity ?? 100;
  const initialAvgWeightG = params.initialAvgWeightG ?? 10;
  const { department, species } = base;

  const tank = await createFixtureTank(dataSource, department, {
    tenantId,
    code: `${codePrefix}-TANK`,
    userId,
    count: initialQuantity,
    biomassKg: (initialQuantity * initialAvgWeightG) / 1000,
  });

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

  return { tank, batch };
}

/** What createFixtureTank builds: a tank's code and the totals it starts with. */
export interface FixtureTankParams {
  tenantId: string;
  /** Unique per tenant; the tank's name is derived from it. */
  code: string;
  userId: string;
  /** Fish the tank's stored totals start with; 0 for an empty tank. */
  count: number;
  /** Biomass the tank's stored totals start with, kg; 0 for an empty tank. */
  biomassKg: number;
}

/**
 * Creates one tank in a fixture department. stockFixtureTank stocks it
 * through the production allocation; a suite that moves fish between tanks
 * creates an empty one (count and biomass 0) as the destination.
 */
export async function createFixtureTank(
  dataSource: DataSource,
  department: Department,
  params: FixtureTankParams,
): Promise<Tank> {
  const { tenantId, code, userId } = params;
  const manager = dataSource.manager;
  return withTenantContext(tenantId, () =>
    manager.save(
      manager.create(Tank, {
        tenantId,
        name: `${code} Tank`,
        code,
        departmentId: department.id,
        tankType: TankType.CIRCULAR,
        material: TankMaterial.FIBERGLASS,
        waterType: WaterType.SALTWATER,
        diameter: 5,
        depth: 2,
        waterDepth: 2,
        maxBiomass: 1500,
        currentBiomass: params.biomassKg,
        currentCount: params.count,
        maxDensity: 30,
        status: TankStatus.ACTIVE,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      }),
    ),
  );
}
