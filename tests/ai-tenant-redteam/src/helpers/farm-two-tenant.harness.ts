import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { collaborator } from '@aquaculture/testing';
import type { ConfigService } from '@nestjs/config';
import type { QueryBus } from '@platform/cqrs';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import {
  FIXTURE_ENTITIES,
  createFarmTenantFixture,
  createFixtureBatchWriters,
  type FarmTenantFixture,
} from '../../../../apps/farm-service/src/__tests__/e2e/helpers/farm-tenant-fixture';
import {
  createFarmOutboxTable,
  createFarmStockReadModelTables,
  createSourceEquipmentTypesReferenceTable,
  createTenantSchemaDerived,
} from '../../../../apps/farm-service/src/__tests__/e2e/helpers/tenant-schema-harness';
import { FarmAiResponder } from '../../../../apps/farm-service/src/common/tenant-boundary/farm-ai-responder';
import { FarmTenantScopes } from '../../../../apps/farm-service/src/common/tenant-boundary/farm-tenant-scopes';
import { GetBatchPerformanceQuery } from '../../../../apps/farm-service/src/batch/queries/get-batch-performance.query';
import { GetBatchPerformanceHandler } from '../../../../apps/farm-service/src/batch/query-handlers/get-batch-performance.handler';
import { BatchAiQueryResponder } from '../../../../apps/farm-service/src/batch/responders/batch-ai-query.responder';
import { GetBatchOverviewResponder } from '../../../../apps/farm-service/src/batch/responders/get-batch-overview.responder';
import { BatchCostCalculatorService } from '../../../../apps/farm-service/src/batch/services/batch-cost-calculator.service';
import { GetTankCapacityHandler } from '../../../../apps/farm-service/src/tank/handlers/get-tank-capacity.handler';
import { GetTankCapacityQuery } from '../../../../apps/farm-service/src/tank/queries/get-tank-capacity.query';
import { GetTankRegistryResponder } from '../../../../apps/farm-service/src/tank/responders/get-tank-registry.responder';
import { TankAiQueryResponder } from '../../../../apps/farm-service/src/tank/responders/tank-ai-query.responder';

/** Two tenants, provisioned the way production clones tenant schemas. */
export interface FarmTwoTenantHarness {
  readonly dataSource: DataSource;
  readonly tenantA: FarmTenantFixture;
  readonly tenantB: FarmTenantFixture;
  /** The REAL farm-service responders an AI turn reaches (one instance each). */
  readonly responders: readonly object[];
  /**
   * The cost collaborator behind get_batch_performance. Exposed so a spec can
   * prove a foreign batch id is refused at the tenant-pinned lookup, before any
   * collaborator is consulted.
   */
  readonly costCalculator: BatchCostCalculatorService;
  close(): Promise<void>;
}

export interface FarmTwoTenantParams {
  readonly tenantAId: string;
  readonly tenantBId: string;
  readonly userId: string;
  /** Code prefix of tenant B's rows — the "secret" no tenant-A reply may contain. */
  readonly tenantBSecretPrefix: string;
}

/**
 * Boots PostgreSQL, derives two tenant schemas, stocks each through the
 * PRODUCTION command handlers (site → department → species → tank → batch →
 * allocation) and builds the farm AI responders over the REAL query handlers.
 *
 * WHY real handlers behind the responders: K10 layer 4 is a property of the
 * handlers (they read only inside `runInTenantRead`, so an id that is not the
 * request tenant's does not exist). A stubbed handler would prove nothing.
 */
export async function bootFarmTwoTenantHarness(
  params: FarmTwoTenantParams,
): Promise<FarmTwoTenantHarness> {
  const pg: HarnessContext = await bootPostgresContainer({ startTimeoutMs: 90_000 });
  await pg.dataSource.query('CREATE SCHEMA farm');
  await createSourceEquipmentTypesReferenceTable(pg.dataSource);

  const dataSource = new DataSource({
    type: 'postgres',
    ...pg.connectionOptions,
    name: `ai-tenant-redteam-${randomBytes(4).toString('hex')}`,
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
  await createTenantSchemaDerived(dataSource, getTenantSchemaName(params.tenantAId));
  await createTenantSchemaDerived(dataSource, getTenantSchemaName(params.tenantBId));

  const writers = createFixtureBatchWriters(dataSource);
  const tenantA = await createFarmTenantFixture(dataSource, writers, {
    tenantId: params.tenantAId,
    codePrefix: 'AIA',
    userId: params.userId,
  });
  const tenantB = await createFarmTenantFixture(dataSource, writers, {
    tenantId: params.tenantBId,
    codePrefix: params.tenantBSecretPrefix,
    userId: params.userId,
  });

  // The query bus's job in production: route each query to its REAL handler.
  const tankCapacity = new GetTankCapacityHandler();
  const costCalculator = new BatchCostCalculatorService(
    collaborator<ConfigService>({ get: jest.fn(() => undefined) }, 'ConfigService'),
  );
  const batchPerformance = new GetBatchPerformanceHandler(costCalculator);
  // The responder skeleton: opens the tenant scope, resolves owned ids, echoes
  // the tenant read back from the connection (K10 layer 4).
  const skeleton = new FarmAiResponder(new FarmTenantScopes(dataSource));
  // A plain jest.Mock: QueryBus.execute is generic in its result, decided per query at runtime.
  const execute: jest.Mock = jest.fn(async (query: object): Promise<unknown> => {
    if (query instanceof GetTankCapacityQuery) return tankCapacity.execute(query);
    if (query instanceof GetBatchPerformanceQuery) return batchPerformance.execute(query);
    throw new Error(`the red-team harness routes no ${query.constructor.name}`);
  });
  const queryBus = collaborator<QueryBus>({ execute }, 'QueryBus');

  return {
    dataSource,
    tenantA,
    tenantB,
    responders: [
      new TankAiQueryResponder(skeleton, queryBus),
      new BatchAiQueryResponder(skeleton, queryBus),
      new GetTankRegistryResponder(skeleton),
      new GetBatchOverviewResponder(skeleton),
    ],
    costCalculator,
    async close(): Promise<void> {
      if (dataSource.isInitialized) await dataSource.destroy();
      await shutdownHarness(pg);
    },
  };
}
