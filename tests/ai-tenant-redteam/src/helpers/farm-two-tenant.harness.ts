import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';
import { join } from 'path';

import { withTenantContext } from '@aquaculture/backend-common/context';
import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
} from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import {
  createFarmTenantFixture,
  createFixtureBatchWriters,
  type FarmTenantFixture,
} from '../../../../apps/farm-service/src/__tests__/e2e/helpers/farm-tenant-fixture';
import {
  createFarmOutboxTable,
  createSourceEquipmentTypesReferenceTable,
  createTenantSchemaDerived,
} from '../../../../apps/farm-service/src/__tests__/e2e/helpers/tenant-schema-harness';
import type { BatchCostCalculatorService } from '../../../../apps/farm-service/src/batch/services/batch-cost-calculator.service';
import { FarmAiResponder } from '../../../../apps/farm-service/src/common/tenant-boundary/farm-ai-responder';
import { FarmTenantScopes } from '../../../../apps/farm-service/src/common/tenant-boundary/farm-tenant-scopes';
import { CreateFinanceTables1804600000000 } from '../../../../apps/farm-service/src/database/migrations/1804600000000-CreateFinanceTables';
import { Equipment } from '../../../../apps/farm-service/src/equipment/entities/equipment.entity';
import { FinanceCategory } from '../../../../apps/farm-service/src/finance/entities/finance-category.entity';
import { FinanceCategorySeedService } from '../../../../apps/farm-service/src/finance/services/finance-category-seed.service';
import { System } from '../../../../apps/farm-service/src/system/entities/system.entity';

import { buildFarmAiResponders } from './farm-ai-responders';
import { asDbMigrate, createAppRole, installTenantRls } from './rls-app-role';

/**
 * Every farm entity, DERIVED from the source tree (the FARM-HIGH-316 rule the
 * e2e harness follows): each AI handler's tables exist in both tenant schemas,
 * so every subject runs its REAL handler — not only the owner check in front
 * of it. A subject whose handler reached an unregistered table would answer
 * INTERNAL_ERROR, which the attack table refuses.
 */
const FARM_ENTITIES = join(__dirname, '../../../../apps/farm-service/src/**/*.entity.ts');

/** Every id kind an AI request can name, for one tenant — all real rows of that tenant. */
export interface OwnedIds {
  readonly tankId: string;
  readonly batchId: string;
  readonly siteId: string;
  readonly departmentId: string;
  readonly systemId: string;
  readonly equipmentId: string;
  readonly equipmentTypeId: string;
}

export interface FarmTenant extends FarmTenantFixture {
  readonly ids: OwnedIds;
}

/** Two tenants, provisioned the way production clones tenant schemas. */
export interface FarmTwoTenantHarness {
  /** The application connection the responders use: NOSUPERUSER, NOBYPASSRLS, owner of nothing. */
  readonly dataSource: DataSource;
  /** The provisioning connection (superuser) — for assertions on raw rows only. */
  readonly adminDataSource: DataSource;
  readonly tenantA: FarmTenant;
  readonly tenantB: FarmTenant;
  readonly tenantSchemas: readonly string[];
  /** The REAL responder skeleton the responders share. */
  readonly skeleton: FarmAiResponder;
  /** The REAL farm-service responders an AI turn reaches (every AI subject). */
  readonly responders: readonly object[];
  /**
   * The cost collaborator behind get_batch_performance. Exposed so a spec can
   * prove a foreign batch id is refused before any collaborator is consulted.
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

/** A system, an equipment type and an equipment row in one tenant — the owner ids the fixture lacks. */
async function stockOwnedRows(
  admin: DataSource,
  tenantId: string,
  fixture: FarmTenantFixture,
  codePrefix: string,
): Promise<OwnedIds> {
  const schema = getTenantSchemaName(tenantId);
  const equipmentTypeId = randomUUID();
  await admin.query(
    `INSERT INTO "${schema}"."equipment_types" ("id", "name", "code", "category", "specificationSchema")
     VALUES ($1, $2, $3, 'feeding', '{"fields":[]}'::jsonb)`,
    [equipmentTypeId, `${codePrefix} Feeder`, `${codePrefix}-FEEDER`],
  );
  const manager = admin.manager;
  const system = await withTenantContext(tenantId, () =>
    manager.save(
      manager.create(System, {
        tenantId,
        siteId: fixture.site.id,
        departmentId: fixture.department.id,
        name: `${codePrefix} System`,
        code: `${codePrefix}-SYS`,
      }),
    ),
  );
  const equipment = await withTenantContext(tenantId, () =>
    manager.save(
      manager.create(Equipment, {
        tenantId,
        equipmentTypeId,
        departmentId: fixture.department.id,
        name: `${codePrefix} Feeder 1`,
        code: `${codePrefix}-FDR-1`,
      }),
    ),
  );
  return {
    tankId: fixture.tank.id,
    batchId: fixture.batch.id,
    siteId: fixture.site.id,
    departmentId: fixture.department.id,
    systemId: system.id,
    equipmentId: equipment.id,
    equipmentTypeId,
  };
}

/**
 * Boots PostgreSQL, derives two tenant schemas, stocks each through the
 * PRODUCTION command handlers (site → department → species → tank → batch →
 * allocation, plus a system and a feeder), installs the production tenant RLS
 * policy on every tenant table, and builds EVERY farm AI responder over the
 * REAL query handlers on a connection that cannot bypass RLS.
 *
 * WHY real handlers behind the responders: K10 layer 4 is a property of the
 * skeleton and the handlers (they read only through the TenantScope the
 * skeleton opened, so an id that is not the request tenant's does not
 * exist). A stubbed handler would prove nothing.
 */
export async function bootFarmTwoTenantHarness(
  params: FarmTwoTenantParams,
): Promise<FarmTwoTenantHarness> {
  const pg: HarnessContext = await bootPostgresContainer({ startTimeoutMs: 90_000 });
  await pg.dataSource.query('CREATE SCHEMA farm');
  await createSourceEquipmentTypesReferenceTable(pg.dataSource);

  const base = {
    type: 'postgres' as const,
    ...pg.connectionOptions,
    entities: [FARM_ENTITIES],
    logging: false,
    extra: { options: '-c search_path=farm,public' },
  };
  const admin = new DataSource({
    ...base,
    name: `ai-tenant-redteam-admin-${randomBytes(4).toString('hex')}`,
    synchronize: true,
  });
  await admin.initialize();
  // The outbox entity opts out of synchronize; the farm-stock read model does
  // not need the e2e helper's migrations here, because its entities are among
  // FARM_ENTITIES and synchronize builds them.
  await createFarmOutboxTable(admin);
  // The finance catalogue's partial unique index (the seed's ON CONFLICT
  // target) is migration DDL the entity does not declare: run the REAL
  // migration on the source schema before the tenant schemas are cloned.
  await asDbMigrate(admin, async (runner) => {
    await runner.query(`SELECT set_config('search_path', 'farm, public', false)`);
    await new CreateFinanceTables1804600000000().up(runner);
  });

  const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
  new TenantConnectionBootstrap(admin).onModuleInit();
  const tenantSchemas = [params.tenantAId, params.tenantBId].map(getTenantSchemaName);
  for (const schema of tenantSchemas) await createTenantSchemaDerived(admin, schema);

  const writers = createFixtureBatchWriters(admin);
  const fixtureA = await createFarmTenantFixture(admin, writers, {
    tenantId: params.tenantAId,
    codePrefix: 'AIA',
    userId: params.userId,
  });
  const fixtureB = await createFarmTenantFixture(admin, writers, {
    tenantId: params.tenantBId,
    codePrefix: params.tenantBSecretPrefix,
    userId: params.userId,
  });
  const tenantA: FarmTenant = {
    ...fixtureA,
    ids: await stockOwnedRows(admin, params.tenantAId, fixtureA, 'AIA'),
  };
  const tenantB: FarmTenant = {
    ...fixtureB,
    ids: await stockOwnedRows(admin, params.tenantBId, fixtureB, params.tenantBSecretPrefix),
  };

  // Tenant onboarding seeds the finance category catalogue; the read-only
  // finance subjects refuse to aggregate without it.
  const financeSeeder = new FinanceCategorySeedService(admin.getRepository(FinanceCategory));
  for (const tenantId of [params.tenantAId, params.tenantBId]) {
    await financeSeeder.ensureDefaults(admin, tenantId);
  }

  // Production posture: the tenant policy on every tenant table, and an
  // application role that is neither superuser, nor BYPASSRLS, nor owner.
  await installTenantRls(admin, tenantSchemas);
  const role = await createAppRole(admin, ['farm', ...tenantSchemas]);
  const dataSource = new DataSource({
    ...base,
    ...role,
    name: `ai-tenant-redteam-app-${randomBytes(4).toString('hex')}`,
    synchronize: false,
  });
  await dataSource.initialize();
  new TenantConnectionBootstrap(dataSource).onModuleInit();

  // The responder skeleton: opens the tenant scope, resolves owned ids,
  // echoes the tenant read back from the connection (K10 layer 4).
  const skeleton = new FarmAiResponder(new FarmTenantScopes(dataSource));
  const { responders, costCalculator } = buildFarmAiResponders(skeleton);

  return {
    dataSource,
    adminDataSource: admin,
    tenantA,
    tenantB,
    tenantSchemas,
    skeleton,
    responders,
    costCalculator,
    async close(): Promise<void> {
      if (dataSource.isInitialized) await dataSource.destroy();
      if (admin.isInitialized) await admin.destroy();
      await shutdownHarness(pg);
    },
  };
}
