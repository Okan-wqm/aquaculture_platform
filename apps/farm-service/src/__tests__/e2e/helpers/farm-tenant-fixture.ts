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
 * `BatchService`, not by inserting rows: `allocateBatchToTank` is what writes
 * `batchDetails[]` in the shape the growth applier later reads. Hand-inserting
 * a TankBatch would produce a row that no production path could have produced,
 * and the suites built on it would prove nothing about production.
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
import { DataSource } from 'typeorm';

import { Batch, BatchInputType } from '../../../batch/entities/batch.entity';
import { AllocationType } from '../../../batch/entities/tank-allocation.entity';
import { BatchService } from '../../../batch/services/batch.service';
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
 * Creates site → department → species → tank → batch → allocation for one
 * tenant, inside that tenant's schema.
 */
export async function createFarmTenantFixture(
  dataSource: DataSource,
  batchService: BatchService,
  params: FarmTenantFixtureParams,
): Promise<FarmTenantFixture> {
  const { tenantId, codePrefix, userId } = params;
  const initialQuantity = params.initialQuantity ?? 100;
  const initialAvgWeightG = params.initialAvgWeightG ?? 10;
  const manager = dataSource.manager;

  const site = await withTenantContext(tenantId, () =>
    manager.save(manager.create(Site, {
      tenantId,
      name: `${codePrefix} Site`,
      code: `${codePrefix}-SITE`,
      type: SiteType.LAND_BASED,
      country: 'NO',
      timezone: 'UTC',
      status: SiteStatus.ACTIVE,
      isActive: true,
    })),
  );

  const department = await withTenantContext(tenantId, () =>
    manager.save(manager.create(Department, {
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
    })),
  );

  const species = await withTenantContext(tenantId, () =>
    manager.save(manager.create(Species, {
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
    })),
  );

  const tank = await withTenantContext(tenantId, () =>
    manager.save(manager.create(Tank, {
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
    })),
  );

  const batch = await withTenantContext(tenantId, () =>
    batchService.createBatch({
      tenantId,
      batchNumber: `${codePrefix}-BATCH`,
      speciesId: species.id,
      inputType: BatchInputType.FRY,
      initialQuantity,
      initialAvgWeightG,
      stockedAt: new Date('2026-04-29T00:00:00.000Z'),
      currency: 'USD',
      createdBy: userId,
    }),
  );

  await withTenantContext(tenantId, () =>
    batchService.allocateBatchToTank({
      tenantId,
      batchId: batch.id,
      tankId: tank.id,
      quantity: initialQuantity,
      avgWeightG: initialAvgWeightG,
      allocationType: AllocationType.INITIAL_STOCKING,
      allocatedBy: userId,
    }),
  );

  return { site, department, species, tank, batch };
}
