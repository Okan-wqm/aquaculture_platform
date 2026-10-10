/**
 * Harvest-plan completion is one transaction (FARM-HIGH-394) — against a real
 * Postgres.
 *
 * WHY: #1670 completed a plan by dispatching one CreateHarvestRecordCommand per
 * tank, each in its own transaction, and saved the plan COMPLETED last without
 * locking it. A failure on the second tank left the first tank harvested and
 * the plan IN_PROGRESS, so the retry harvested the first tank again; two
 * concurrent submits both saw IN_PROGRESS and both moved the stock. Mocks
 * cannot prove a rollback or a row lock, so this suite runs the production
 * CompleteHarvestPlanHandler + HarvestRecordWriter + TankBatchService against
 * a migrated tenant schema and reads the rows back with SQL.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { collaborator } from '@aquaculture/testing';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import type { CommandBus } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TankBatchService } from '../../batch/services/tank-batch.service';
import type { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import type { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import type { FinanceSettingsService } from '../../finance/services/finance-settings.service';
import type { BatchHarvestEligibilityService } from '../../fish-health/services/batch-harvest-eligibility.service';
import { CompleteHarvestPlanCommand } from '../../harvest/commands/complete-harvest-plan.command';
import {
  HarvestPlan,
  HarvestPlanStatus,
  HarvestType,
} from '../../harvest/entities/harvest-plan.entity';
import { HarvestRecord, QualityClass } from '../../harvest/entities/harvest-record.entity';
import { CompleteHarvestPlanHandler } from '../../harvest/handlers/complete-harvest-plan.handler';
import type { HarvestPolicyService } from '../../harvest/services/harvest-policy.service';
import { HarvestRecordWriter } from '../../harvest/services/harvest-record-writer.service';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import {
  Tank,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../tank/entities/tank.entity';
import {
  FIXTURE_ENTITIES,
  createFarmTenantFixture,
  createFixtureBatchWriters,
  type FarmTenantFixture,
} from './helpers/farm-tenant-fixture';
import {
  createFarmOutboxTable,
  createFarmStockReadModelTables,
  createSourceEquipmentTypesReferenceTable,
  createTenantSchemaDerived,
} from './helpers/tenant-schema-harness';

// One tenant per scenario: the fixture seeds tenant-unique reference rows
// (species, site codes), so each scenario stocks its own tenant schema.
const TENANTS = ['0c9d4f6a-3b2e-4f1a-8c7d-5e6f7a8b9c0d', '1d0e5a7b-4c3f-4a2b-9d8e-6f7a8b9c0d1e'];
const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';
const MANAGER = { sub: USER_ID, roles: [Role.MODULE_MANAGER], assignedSiteIds: [] };

interface Scenario {
  tenantId: string;
  fixture: FarmTenantFixture;
  secondTank: Tank;
  plan: HarvestPlan;
}

describe('CompleteHarvestPlanHandler — atomic completion on Postgres (FARM-HIGH-394)', () => {
  let pg: HarnessContext | undefined;
  let dataSource: DataSource;
  let handler: CompleteHarvestPlanHandler;
  /** Throws on the n-th projection refresh (the n-th tank written), when set. */
  let failRefreshOnCall: number | null = null;
  let refreshCalls = 0;
  let scenarioSeq = 0;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    await createSourceEquipmentTypesReferenceTable(pg.dataSource);

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-complete-harvest-plan-${randomBytes(4).toString('hex')}`,
      entities: [...FIXTURE_ENTITIES, HarvestPlan, HarvestRecord],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
    await createFarmOutboxTable(dataSource);
    await createFarmStockReadModelTables(dataSource);
    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();
    for (const tenantId of TENANTS) {
      await createTenantSchemaDerived(dataSource, getTenantSchemaName(tenantId));
    }

    // The stock write path is production code end to end: the writer, the
    // TankBatchService SSoT and the outbox publisher. Collaborators outside
    // the stock tables are stubbed; the projection stub is the fault
    // injection point (it runs inside the writer, after the tank's rows are
    // written, so a throw there aborts with real writes already made).
    const writer = new HarvestRecordWriter(
      new OutboxPublisher(FarmOutbox),
      collaborator<DayPlanRecalcService>(
        { recalcForUnit: jest.fn().mockResolvedValue(null) },
        'DayPlanRecalcService',
      ),
      collaborator<CommandBus>({ execute: jest.fn().mockResolvedValue(undefined) }, 'CommandBus'),
      collaborator<BatchHarvestEligibilityService>(
        { checkEligibility: jest.fn().mockResolvedValue({ eligible: true, blockingEvents: [] }) },
        'BatchHarvestEligibilityService',
      ),
      collaborator<HarvestPolicyService>(
        { evaluate: jest.fn().mockResolvedValue(undefined) },
        'HarvestPolicyService',
      ),
      new TankBatchService(),
      new SiteAuthorizationService(),
      collaborator<FarmStockProjectionService>(
        {
          refreshContainers: jest.fn(() => {
            refreshCalls += 1;
            if (failRefreshOnCall === refreshCalls) {
              return Promise.reject(new Error('injected failure on the second tank'));
            }
            return Promise.resolve();
          }),
        },
        'FarmStockProjectionService',
      ),
    );
    handler = new CompleteHarvestPlanHandler(
      dataSource,
      collaborator<FinanceSettingsService>(
        { getDefaultCurrency: jest.fn().mockResolvedValue('NOK') },
        'FinanceSettingsService',
      ),
      writer,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await shutdownHarness(pg);
  });

  beforeEach(() => {
    failRefreshOnCall = null;
    refreshCalls = 0;
  });

  /** A batch of 100 fish split 60 / 40 over two tanks, with an IN_PROGRESS plan. */
  async function scenario(): Promise<Scenario> {
    const tenantId = TENANTS[scenarioSeq];
    if (tenantId === undefined) {
      throw new Error('scenario(): no tenant schema left for another scenario');
    }
    scenarioSeq += 1;
    const prefix = `CHP${scenarioSeq}`;
    const fixture = await createFarmTenantFixture(
      dataSource,
      createFixtureBatchWriters(dataSource),
      {
        tenantId: tenantId,
        codePrefix: prefix,
        userId: USER_ID,
        initialQuantity: 100,
        initialAvgWeightG: 10,
      },
    );
    const manager = dataSource.manager;
    const secondTank = await withTenantContext(tenantId, () =>
      manager.save(
        manager.create(Tank, {
          tenantId: tenantId,
          name: `${prefix} Tank 2`,
          code: `${prefix}-TANK-2`,
          departmentId: fixture.department.id,
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
    // Move 40 fish to the second tank through the composition SSoT writer.
    const tankBatchService = new TankBatchService();
    await runInTenantTransaction(dataSource, 'farm', tenantId, async (queryRunner) => {
      const delta = { batchId: fixture.batch.id, batchNumber: fixture.batch.batchNumber };
      await tankBatchService.applyBatchDelta(queryRunner.manager, tenantId, fixture.tank.id, {
        ...delta,
        quantityDelta: -40,
        biomassDelta: -0.4,
      });
      await tankBatchService.applyBatchDelta(queryRunner.manager, tenantId, secondTank.id, {
        ...delta,
        quantityDelta: 40,
        biomassDelta: 0.4,
      });
    });

    const plan = await withTenantContext(tenantId, () =>
      manager.save(
        manager.create(HarvestPlan, {
          tenantId: tenantId,
          planCode: `HP-${prefix}`,
          name: `${prefix} plan`,
          batchId: fixture.batch.id,
          status: HarvestPlanStatus.IN_PROGRESS,
          harvestType: HarvestType.PARTIAL,
          plannedDate: new Date('2026-10-01'),
          criteria: { targetWeight: { min: 5, max: 15, target: 10 } },
          estimates: {
            estimatedQuantity: 50,
            estimatedBiomass: 0.5,
            estimatedAvgWeight: 10,
            estimatedYield: 90,
            confidenceLevel: 'medium',
          },
          createdBy: USER_ID,
        }),
      ),
    );
    return { tenantId: tenantId, fixture, secondTank, plan };
  }

  function completion(s: Scenario, actualQuantity: number): CompleteHarvestPlanCommand {
    return new CompleteHarvestPlanCommand(
      s.tenantId,
      s.plan.id,
      {
        actualQuantity,
        actualBiomass: actualQuantity / 100,
        actualAvgWeight: 10,
        qualityClass: QualityClass.ORDINAER,
      },
      MANAGER,
    );
  }

  async function scalar(sql: string, params: unknown[]): Promise<number> {
    const rows: Array<{ value: string | number | null }> = await dataSource.query(sql, params);
    return Number(rows[0]?.value ?? 0);
  }

  async function stockOf(s: Scenario): Promise<{ tank1: number; tank2: number; batch: number }> {
    const schema = getTenantSchemaName(s.tenantId);
    const tankQty = (tankId: string): Promise<number> =>
      scalar(
        `SELECT "totalQuantity" AS value FROM "${schema}"."tank_batches" WHERE "tankId" = $1`,
        [tankId],
      );
    return {
      tank1: await tankQty(s.fixture.tank.id),
      tank2: await tankQty(s.secondTank.id),
      batch: await scalar(
        `SELECT "currentQuantity" AS value FROM "${schema}"."batches_v2" WHERE "id" = $1`,
        [s.fixture.batch.id],
      ),
    };
  }

  async function harvestRecordCount(s: Scenario): Promise<number> {
    return scalar(
      `SELECT COUNT(*) AS value FROM "${getTenantSchemaName(s.tenantId)}"."harvest_records" WHERE "harvestPlanId" = $1`,
      [s.plan.id],
    );
  }

  async function planStatus(s: Scenario): Promise<string> {
    const rows: Array<{ status: string }> = await dataSource.query(
      `SELECT "status" FROM "${getTenantSchemaName(s.tenantId)}"."harvest_plans" WHERE "id" = $1`,
      [s.plan.id],
    );
    return rows[0]?.status ?? 'missing';
  }

  it('a failure on the second tank rolls back the first tank and leaves the plan IN_PROGRESS', async () => {
    const s = await scenario();
    expect(await stockOf(s)).toEqual({ tank1: 60, tank2: 40, batch: 100 });
    failRefreshOnCall = 2;

    await expect(
      withTenantContext(s.tenantId, () => handler.execute(completion(s, 50))),
    ).rejects.toThrow('injected failure on the second tank');

    expect(refreshCalls).toBe(2);
    expect(await stockOf(s)).toEqual({ tank1: 60, tank2: 40, batch: 100 });
    expect(await harvestRecordCount(s)).toBe(0);
    expect(await planStatus(s)).toBe(HarvestPlanStatus.IN_PROGRESS);

    // The retry after the fault harvests each tank exactly once.
    failRefreshOnCall = null;
    await withTenantContext(s.tenantId, () => handler.execute(completion(s, 50)));
    expect(await stockOf(s)).toEqual({ tank1: 30, tank2: 20, batch: 50 });
    expect(await harvestRecordCount(s)).toBe(2);
    expect(await planStatus(s)).toBe(HarvestPlanStatus.COMPLETED);
  });

  it('a concurrent double submit completes the plan once and moves the stock once', async () => {
    const s = await scenario();

    const results = await Promise.all([
      withTenantContext(s.tenantId, () => handler.execute(completion(s, 50))),
      withTenantContext(s.tenantId, () => handler.execute(completion(s, 50))),
    ]);

    expect(results.map((plan) => plan.status)).toEqual([
      HarvestPlanStatus.COMPLETED,
      HarvestPlanStatus.COMPLETED,
    ]);
    expect(await stockOf(s)).toEqual({ tank1: 30, tank2: 20, batch: 50 });
    expect(await harvestRecordCount(s)).toBe(2);

    // A later completion with different counted results is a conflict.
    await expect(
      withTenantContext(s.tenantId, () => handler.execute(completion(s, 40))),
    ).rejects.toThrow(ConflictException);
    expect(await stockOf(s)).toEqual({ tank1: 30, tank2: 20, batch: 50 });
  });
});
