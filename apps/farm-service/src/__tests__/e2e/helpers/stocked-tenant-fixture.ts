import { withTenantContext } from '@aquaculture/backend-common';
import { Role } from '@aquaculture/backend-common/decorators';
import type { DataSource } from 'typeorm';

import { AllocateToTankCommand } from '../../../batch/commands/allocate-to-tank.command';
import { CreateBatchCommand } from '../../../batch/commands/create-batch.command';
import { Batch, BatchInputType } from '../../../batch/entities/batch.entity';
import { AllocationType } from '../../../batch/entities/tank-allocation.entity';
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

import type { BatchCommandTestHarness } from './batch-command-test-harness';

export interface StockedTenantFixtureV1 {
  readonly site: Site;
  readonly department: Department;
  readonly species: Species;
  readonly tank: Tank;
  readonly batch: Batch;
}

export interface StockedTenantFixtureInputV1 {
  readonly tenantId: string;
  readonly codePrefix: string;
  readonly userId: string;
  readonly initialQuantity?: number;
  readonly initialAvgWeightG?: number;
}

type StockingCommands = Pick<BatchCommandTestHarness, 'createBatch' | 'allocateToTank'>;

/**
 * Sole real-Postgres fixture authority for a production-reachable stocked
 * tenant chain: Site → Department → Species → Tank → Batch → Allocation.
 * Stock mutation goes through the same current CQRS handlers as runtime code;
 * the helper never hand-inserts TankBatch projections.
 */
export async function createStockedTenantFixtureV1(
  dataSource: DataSource,
  commands: StockingCommands,
  input: StockedTenantFixtureInputV1,
): Promise<StockedTenantFixtureV1> {
  const { tenantId, codePrefix, userId } = input;
  const initialQuantity = input.initialQuantity ?? 100;
  const initialAvgWeightG = input.initialAvgWeightG ?? 10;
  if (!Number.isSafeInteger(initialQuantity) || initialQuantity <= 0) {
    throw new Error('Stocked tenant fixture requires a positive integer quantity');
  }
  if (!Number.isFinite(initialAvgWeightG) || initialAvgWeightG <= 0) {
    throw new Error('Stocked tenant fixture requires a positive average weight');
  }

  const siteRepository = dataSource.getRepository(Site);
  const departmentRepository = dataSource.getRepository(Department);
  const speciesRepository = dataSource.getRepository(Species);
  const tankRepository = dataSource.getRepository(Tank);

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
        createdBy: userId,
        updatedBy: userId,
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
        createdBy: userId,
        updatedBy: userId,
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
    commands.createBatch.execute(
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
    commands.allocateToTank.execute(
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
        [Role.MODULE_MANAGER],
      ),
    ),
  );

  return Object.freeze({ site, department, species, tank, batch });
}
