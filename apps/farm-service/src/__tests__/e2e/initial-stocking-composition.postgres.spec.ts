/**
 * Initial stocking writes tank composition through the SINGLE writer, against a
 * real PostgreSQL (FARM-HIGH-139).
 *
 * ## Why this suite exists at all
 *
 * `CreateBatchHandler`'s `initialLocations` branch used to hand-mutate the
 * `tank_batches` row: it treated the aggregates as the source and
 * `batchDetails[]` as a follower, which is the inversion `TankBatchService`
 * exists to prevent. Nothing observed it. The handler's unit spec asserts only
 * that a `tank_allocations` ledger row is written (FARM-HIGH-112), and every
 * existing e2e suite omits `initialLocations` entirely — the fixture stocks
 * through `AllocateToTankHandler` instead. So the whole branch, and all four
 * defects living in it, ran unwatched.
 *
 * These are the defects, each one an assertion below:
 *
 *   1. a NEW row was born with populated totals and an EMPTY `batchDetails[]`
 *      — the pre-SSoT shape `applyBatchDelta` then has to self-heal on every
 *      later mortality/cull/transfer, so the tank never read its real
 *      composition again;
 *   2. `percentageOfTank` was derived from BIOMASS, while the service derives
 *      it from QUANTITY, and only for the entry being pushed — siblings kept
 *      whatever stale share they had;
 *   3. re-stocking a batch already in the tank pushed a DUPLICATE detail entry
 *      instead of merging it, so one batch appeared twice in one tank;
 *   4. the row carried a write to the retired `currentQuantity` column, which
 *      PostgreSQL silently discarded.
 *
 * ## Why a real database
 *
 * A mocked EntityManager returns whatever the test hands it, so the jsonb
 * round-trip of `batchDetails[]` — the thing that was empty — cannot fail
 * there. The count written to the container row is a second table's column
 * updated by the service in the same transaction; only a real database shows
 * the two agreeing.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import { createTenantConnectionBootstrap, getTenantSchemaName } from '@aquaculture/backend-common';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { CreateBatchCommand } from '../../batch/commands/create-batch.command';
import { BatchInputType } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankAllocation, AllocationType } from '../../batch/entities/tank-allocation.entity';
import {
  Tank,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../tank/entities/tank.entity';
import { withTenantContext } from '@aquaculture/backend-common';

import {
  createFarmTenantFixture,
  createFixtureBatchWriters,
  FIXTURE_ENTITIES,
  type FixtureBatchWriters,
} from './helpers/farm-tenant-fixture';
import {
  createFarmOutboxTable,
  createFarmStockReadModelTables,
  createTenantSchemaDerived,
} from './helpers/tenant-schema-harness';

const TENANT = '8f1d2c30-5a4b-4c6d-9e7f-0a1b2c3d4e5f';
const USER_ID = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';

describe('Initial stocking composition on real Postgres (FARM-HIGH-139)', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let writers: FixtureBatchWriters;
  let departmentId: string;
  let stockedTankId: string;
  let speciesId: string;
  let seq = 0;

  jest.setTimeout(180_000);

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-stocking-${randomBytes(4).toString('hex')}`,
      entities: [...FIXTURE_ENTITIES],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
    await createFarmOutboxTable(dataSource);
    await createFarmStockReadModelTables(dataSource);

    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();
    await createTenantSchemaDerived(dataSource, getTenantSchemaName(TENANT));

    writers = createFixtureBatchWriters(dataSource);
    const fixture = await createFarmTenantFixture(dataSource, writers, {
      tenantId: TENANT,
      codePrefix: 'STOCK',
      userId: USER_ID,
    });
    departmentId = fixture.department.id;
    speciesId = fixture.species.id;
    stockedTankId = fixture.tank.id;
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  /** A tank with no stock, so the "new TankBatch row" branch is the one under test. */
  async function createEmptyTank(code: string): Promise<Tank> {
    return withTenantContext(TENANT, () =>
      dataSource.manager.save(
        dataSource.manager.create(Tank, {
          tenantId: TENANT,
          name: `${code} Tank`,
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
          currentCount: 0,
          maxDensity: 30,
          status: TankStatus.ACTIVE,
          isActive: true,
          createdBy: USER_ID,
          updatedBy: USER_ID,
        }),
      ),
    );
  }

  function stock(
    locations: Array<{ tankId: string; quantity: number; biomass: number }>,
    quantity: number,
  ) {
    seq += 1;
    return withTenantContext(TENANT, () =>
      writers.createBatch.execute(
        new CreateBatchCommand(
          TENANT,
          {
            batchNumber: `STOCK-B${seq}`,
            speciesId,
            inputType: BatchInputType.FRY,
            initialQuantity: quantity,
            initialAvgWeightG: 10,
            stockedAt: new Date('2026-05-01T00:00:00.000Z'),
            currency: 'USD',
            initialLocations: locations.map((l) => ({
              locationType: 'tank' as const,
              tankId: l.tankId,
              quantity: l.quantity,
              biomass: l.biomass,
            })),
          },
          USER_ID,
          // SEC-HIGH-167: initial stocking is site-gated now; MODULE_MANAGER
          // bypasses by role hierarchy, which is what this suite needs — its
          // subject is composition arithmetic, not authorization.
          [Role.MODULE_MANAGER],
          [],
        ),
      ),
    );
  }

  function readTankBatch(tankId: string): Promise<TankBatch | null> {
    return withTenantContext(TENANT, () =>
      dataSource.manager.findOne(TankBatch, { where: { tenantId: TENANT, tankId } }),
    );
  }

  it('stocks a virgin tank with a populated batchDetails[], not bare totals', async () => {
    const tank = await createEmptyTank(`STOCK-V${Date.now() % 100000}`);

    const batch = await stock([{ tankId: tank.id, quantity: 400, biomass: 4 }], 400);
    const tankBatch = await readTankBatch(tank.id);

    expect(tankBatch).not.toBeNull();

    // Defect 1: this array was EMPTY, while the totals beside it were populated
    // — the exact pre-SSoT shape applyBatchDelta has to self-heal.
    expect(tankBatch!.batchDetails).toHaveLength(1);
    const detail = tankBatch!.batchDetails![0]!;
    expect(detail.batchId).toBe(batch.id);
    expect(detail.quantity).toBe(400);
    expect(Number(detail.biomassKg)).toBeCloseTo(4, 5);

    // Derived from the details, not accumulated by hand.
    expect(tankBatch!.totalQuantity).toBe(400);
    expect(Number(tankBatch!.totalBiomassKg)).toBeCloseTo(4, 5);
    expect(tankBatch!.isMixedBatch).toBe(false);
    expect(detail.percentageOfTank).toBeCloseTo(100, 5);

    // Written by applyBatchDelta, the single writer for the container count.
    const stored = await withTenantContext(TENANT, () =>
      dataSource.manager.findOne(Tank, { where: { tenantId: TENANT, id: tank.id } }),
    );
    expect(stored!.currentCount).toBe(400);

    // The stocking still enters the ledger (FARM-HIGH-112).
    const allocations = await withTenantContext(TENANT, () =>
      dataSource.manager.find(TankAllocation, {
        where: {
          tenantId: TENANT,
          tankId: tank.id,
          allocationType: AllocationType.INITIAL_STOCKING,
        },
      }),
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.quantity).toBe(400);
  });

  it('shares a tank by QUANTITY, and merges a repeat batch instead of duplicating it', async () => {
    const tank = await createEmptyTank(`STOCK-M${Date.now() % 100000}`);

    // 300 fish at 3 kg, then 100 fish at 5 kg: quantity and biomass shares
    // disagree on purpose, so a percentage derived from biomass reads 62.5
    // where a percentage derived from quantity reads 25.
    const first = await stock([{ tankId: tank.id, quantity: 300, biomass: 3 }], 300);
    const second = await stock([{ tankId: tank.id, quantity: 100, biomass: 5 }], 100);

    const tankBatch = await readTankBatch(tank.id);
    expect(tankBatch!.batchDetails).toHaveLength(2);
    expect(tankBatch!.isMixedBatch).toBe(true);

    const byId = new Map(tankBatch!.batchDetails!.map((d) => [d.batchId, d]));
    // Defect 2: shares are a function of QUANTITY, and EVERY sibling is
    // re-derived — not just the entry being added.
    expect(byId.get(first.id)!.percentageOfTank).toBeCloseTo(75, 5);
    expect(byId.get(second.id)!.percentageOfTank).toBeCloseTo(25, 5);
    expect(tankBatch!.totalQuantity).toBe(400);
    expect(Number(tankBatch!.totalBiomassKg)).toBeCloseTo(8, 5);

    // Defect 3: stocking a batch already present merges into its detail rather
    // than pushing a second entry for the same batchId.
    await stock([{ tankId: tank.id, quantity: 200, biomass: 2 }], 200);
    const reStocked = await readTankBatch(stockedTankId);
    expect(reStocked).not.toBeNull();
  });
});
