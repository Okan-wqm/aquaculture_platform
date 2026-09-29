/**
 * K10 red-team, data-layer half (PR-T1, MT-HIGH-062) — on real Postgres.
 *
 * WHY: the ai-service side refuses a reply that names another tenant, but the
 * FIRST line is here: a farm AI responder called in tenant A's context must
 * not be able to read tenant B's rows even when handed B's real tank and batch
 * UUIDs (a model that "knows" them from a leak, a guess, or a prompt
 * injection). Two tenant schemas are provisioned the way production clones
 * them, B is stocked through the production command handlers, and A's
 * responders are asked for B's ids.
 *
 * EXPECTS: NOT_FOUND for tenant A (the id does not exist in A's schema), no
 * byte of B's data in any reply, every reply naming tenant A — and the same
 * ids DO resolve for tenant B, so the NOT_FOUND is isolation, not absence.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import { createTenantConnectionBootstrap, getTenantSchemaName } from '@aquaculture/backend-common';
import { collaborator } from '@aquaculture/testing';
import type { QueryBus } from '@platform/cqrs';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { GetBatchPerformanceQuery } from '../../batch/queries/get-batch-performance.query';
import { GetBatchPerformanceHandler } from '../../batch/query-handlers/get-batch-performance.handler';
import { BatchAiQueryResponder } from '../../batch/responders/batch-ai-query.responder';
import { GetBatchOverviewResponder } from '../../batch/responders/get-batch-overview.responder';
import type { BatchCostCalculatorService } from '../../batch/services/batch-cost-calculator.service';
import type { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { GetTankCapacityHandler } from '../../tank/handlers/get-tank-capacity.handler';
import { GetTankCapacityQuery } from '../../tank/queries/get-tank-capacity.query';
import { GetTankRegistryResponder } from '../../tank/responders/get-tank-registry.responder';
import { TankAiQueryResponder } from '../../tank/responders/tank-ai-query.responder';
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

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const TENANT_B = '7c2f4e10-3d2a-4b4e-9f18-f8b16f0d5a10';
const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';

/** A collaborator that must never be reached on the foreign-id path. */
function unreachable<T extends object>(label: string): T {
  return collaborator<T>({}, label);
}

describe('farm AI responders — tenant boundary on real Postgres (K10)', () => {
  let pg: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let tankAi: TankAiQueryResponder;
  let batchAi: BatchAiQueryResponder;
  let tankRegistry: GetTankRegistryResponder;
  let batchOverview: GetBatchOverviewResponder;
  let fixtureA: FarmTenantFixture;
  let fixtureB: FarmTenantFixture;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    await createSourceEquipmentTypesReferenceTable(pg.dataSource);

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-ai-tenant-boundary-${randomBytes(4).toString('hex')}`,
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
    await createTenantSchemaDerived(dataSource, getTenantSchemaName(TENANT_A));
    await createTenantSchemaDerived(dataSource, getTenantSchemaName(TENANT_B));

    const writers = createFixtureBatchWriters(dataSource);
    fixtureA = await createFarmTenantFixture(dataSource, writers, {
      tenantId: TENANT_A,
      codePrefix: 'AIA',
      userId: USER_ID,
    });
    fixtureB = await createFarmTenantFixture(dataSource, writers, {
      tenantId: TENANT_B,
      codePrefix: 'AIB-SECRET',
      userId: USER_ID,
    });

    // The REAL query handlers behind the responders. Cost/FCR collaborators of
    // the batch-performance handler are unreachable doubles: a foreign batch id
    // must be rejected at the tenant-pinned lookup, before either is consulted.
    const tankCapacity = new GetTankCapacityHandler(dataSource);
    const batchPerformance = new GetBatchPerformanceHandler(
      dataSource,
      unreachable<BatchCostCalculatorService>('BatchCostCalculatorService'),
      unreachable<FCRCalculationService>('FCRCalculationService'),
    );
    // Routes each query to its REAL handler (the Nest QueryBus's job in production).
    const execute = jest.fn().mockImplementation(async (query: object) => {
      if (query instanceof GetTankCapacityQuery) return tankCapacity.execute(query);
      if (query instanceof GetBatchPerformanceQuery) return batchPerformance.execute(query);
      throw new Error(`unexpected query ${query.constructor.name}`);
    });
    const queryBus = collaborator<QueryBus>({ execute }, 'QueryBus');
    tankAi = new TankAiQueryResponder(queryBus);
    batchAi = new BatchAiQueryResponder(queryBus);
    tankRegistry = new GetTankRegistryResponder(dataSource);
    batchOverview = new GetBatchOverviewResponder(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await shutdownHarness(pg);
  });

  /** Nothing of tenant B — its ids or its codes — may appear in a tenant-A reply. */
  const expectNoTenantBData = (reply: unknown): void => {
    const text = JSON.stringify(reply);
    expect(text).not.toContain('AIB-SECRET');
    expect(text).not.toContain(TENANT_B);
  };

  it("answers NOT_FOUND for tenant B's real tank id asked in tenant A's context", async () => {
    // SCENARIO: tank capacity for B's tank, with A's tenant on the request.
    // EXPECTS: NOT_FOUND naming tenant A; no B data.
    const reply = await tankAi.getCapacity({ tenantId: TENANT_A, tankId: fixtureB.tank.id });

    expect(reply).toEqual({ ok: false, tenantId: TENANT_A, error: 'NOT_FOUND' });
    expectNoTenantBData(reply);
  });

  it("answers NOT_FOUND for tenant B's real batch id asked in tenant A's context", async () => {
    const reply = await batchAi.getPerformance({ tenantId: TENANT_A, batchId: fixtureB.batch.id });

    expect(reply).toEqual({ ok: false, tenantId: TENANT_A, error: 'NOT_FOUND' });
    expectNoTenantBData(reply);
  });

  it("lists only tenant A's tanks and batches for tenant A", async () => {
    // SCENARIO: the registry/overview reads an AI turn uses to resolve names to ids.
    // EXPECTS: A's rows only, bound to A.
    const tanks = await tankRegistry.handleGetTankRegistry({ tenantId: TENANT_A });
    const batches = await batchOverview.handleGetBatchOverview({ tenantId: TENANT_A });

    expect(tanks).toMatchObject({ ok: true, tenantId: TENANT_A });
    expect(batches).toMatchObject({ ok: true, tenantId: TENANT_A });
    if (!tanks.ok || !batches.ok) throw new Error('expected ok envelopes');
    expect(tanks.data.map((tank) => tank.id)).toEqual([fixtureA.tank.id]);
    expect(batches.data.map((batch) => batch.id)).toEqual([fixtureA.batch.id]);
    expectNoTenantBData(tanks);
    expectNoTenantBData(batches);
  });

  it('control: the same B ids DO resolve in tenant B — the NOT_FOUND above is isolation, not absence', async () => {
    const reply = await tankAi.getCapacity({ tenantId: TENANT_B, tankId: fixtureB.tank.id });

    expect(reply).toMatchObject({
      ok: true,
      tenantId: TENANT_B,
      data: { tankId: fixtureB.tank.id, tankCode: 'AIB-SECRET-TANK' },
    });
  });
});
