/**
 * Test 4: Schema Provisioning
 *
 * Verifies that when a new tenant is created via the GraphQL API:
 * - A PostgreSQL schema is provisioned with the correct naming convention
 * - The schema contains the expected tables for all assigned modules
 * - The tenant record in auth.tenants has the correct status
 */

import {
  MIGRATION_LEDGER_TABLE,
  tenantMigrationLedgerTable,
} from '@aquaculture/backend-common/database';

import { MODULE_SCHEMAS } from '../../../libs/backend-common/src/database/schema-manager.service';
import { assertDefined } from '../../helpers/assertions';
import {
  findTenantById,
  tenantSchemaExists,
  getTenantSchemaTables,
  getTenantSchemaName,
  closePool,
  TestDatabase,
} from '../../helpers/db.helper';
import { loginAsSuperAdmin, createTestTenant, teardownTenant } from '../../helpers/tenant.fixture';

/**
 * Minimum expected tables in a tenant schema.
 * These are the core tables provisioned by the schema manager
 * for tenant-level role management and data isolation.
 */
const CORE_TENANT_TABLES = ['tenant_roles', 'tenant_role_permissions', 'user_role_assignments'];

const DEFAULT_MODULE_TABLES = new Set(
  MODULE_SCHEMAS.flatMap((moduleSchema) => moduleSchema.tables),
);

const SOURCE_ONLY_INFRASTRUCTURE_TABLES = new Set(
  MODULE_SCHEMAS.flatMap((moduleSchema) => moduleSchema.infrastructureTables ?? []),
);

const PROTECTED_SOURCE_TABLES: Array<{ schema: string; table: string }> = [
  { schema: 'farm', table: 'sites' },
  { schema: 'farm', table: 'tanks' },
  { schema: 'farm', table: 'water_quality_measurements' },
  { schema: 'farm', table: 'stock_movements' },
  { schema: 'hr', table: 'employees' },
  { schema: 'hr', table: 'attendance_records' },
  { schema: 'sensor', table: 'sensors' },
  { schema: 'sensor', table: 'sensor_readings' },
];

describe('Schema Provisioning', () => {
  let superAdminToken: string;
  const db = new TestDatabase();
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    superAdminToken = await loginAsSuperAdmin();
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      await teardownTenant(tenantId);
    }
    await db.close();
    await closePool();
  });

  it('should create a PostgreSQL schema for a new tenant', async () => {
    const tenant = await createTestTenant(superAdminToken);
    createdTenantIds.push(tenant.id);

    // Verify the schema exists
    const schemaExists = await tenantSchemaExists(tenant.id);
    expect(schemaExists).toBe(true);

    // Verify the schema name follows the convention
    const expectedSchemaName = getTenantSchemaName(tenant.id);
    expect(expectedSchemaName).toMatch(/^tenant_[a-f0-9]{16}$/);
  });

  it('should provision correct tables in the tenant schema', async () => {
    const tenant = await createTestTenant(superAdminToken);
    createdTenantIds.push(tenant.id);

    // Get tables in the tenant schema
    const tables = await getTenantSchemaTables(tenant.id);
    expect(tables.length).toBeGreaterThan(0);

    // Verify core tenant tables exist
    for (const expectedTable of CORE_TENANT_TABLES) {
      expect(tables).toContain(expectedTable);
    }
  });

  it('should provision the default module business tables and exclude source-only infrastructure tables', async () => {
    const tenant = await createTestTenant(superAdminToken);
    createdTenantIds.push(tenant.id);

    const tables = await getTenantSchemaTables(tenant.id);
    const missingTables = [...DEFAULT_MODULE_TABLES].filter((table) => !tables.includes(table));
    const clonedInfrastructureTables = [...SOURCE_ONLY_INFRASTRUCTURE_TABLES]
      .filter((table) => table !== MIGRATION_LEDGER_TABLE)
      .filter((table) => tables.includes(table));

    expect(missingTables).toEqual([]);
    expect(clonedInfrastructureTables).toEqual([]);
    expect(tables).toContain(tenantMigrationLedgerTable('farm'));
    expect(tables).not.toContain('farm_outbox');
    expect(tables).not.toContain('hr_outbox');
    expect(tables).not.toContain(MIGRATION_LEDGER_TABLE);
    expect(tables).not.toContain('typeorm_migrations');
  });

  it('should keep source schemas free of tenant business rows after provisioning', async () => {
    const tenant = await createTestTenant(superAdminToken);
    createdTenantIds.push(tenant.id);

    for (const { schema, table } of PROTECTED_SOURCE_TABLES) {
      const tableExists = await db.tableExists(schema, table);
      if (!tableExists) continue;

      const tenantIdColumn = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = $2
             AND column_name = 'tenantId'
         ) AS exists`,
        [schema, table],
      );
      if (!tenantIdColumn.rows[0]?.exists) continue;

      const count = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${schema}"."${table}" WHERE "tenantId" = $1`,
        [tenant.id],
      );
      expect(Number(count.rows[0]?.count ?? '0')).toBe(0);
    }
  });

  it('should set tenant status to ACTIVE after successful provisioning', async () => {
    const tenant = await createTestTenant(superAdminToken);
    createdTenantIds.push(tenant.id);

    // Verify tenant status in DB
    const dbTenant = await findTenantById(tenant.id);
    expect(dbTenant).not.toBeNull();
    expect(assertDefined(dbTenant).status).toBe('ACTIVE');
  });

  it('should create unique schemas for different tenants', async () => {
    const tenantA = await createTestTenant(superAdminToken, {
      name: 'Schema Test A',
      slug: `schema-a-${Date.now()}`,
    });
    createdTenantIds.push(tenantA.id);

    const tenantB = await createTestTenant(superAdminToken, {
      name: 'Schema Test B',
      slug: `schema-b-${Date.now()}`,
    });
    createdTenantIds.push(tenantB.id);

    // Both schemas should exist
    const schemaAExists = await tenantSchemaExists(tenantA.id);
    const schemaBExists = await tenantSchemaExists(tenantB.id);
    expect(schemaAExists).toBe(true);
    expect(schemaBExists).toBe(true);

    // Schema names should be different
    const schemaAName = getTenantSchemaName(tenantA.id);
    const schemaBName = getTenantSchemaName(tenantB.id);
    expect(schemaAName).not.toBe(schemaBName);

    // Both should have the core tables
    const tablesA = await getTenantSchemaTables(tenantA.id);
    const tablesB = await getTenantSchemaTables(tenantB.id);

    for (const table of CORE_TENANT_TABLES) {
      expect(tablesA).toContain(table);
      expect(tablesB).toContain(table);
    }
  });

  it('should store correct tenant metadata in auth.tenants', async () => {
    const uniqueName = `Meta Test ${Date.now()}`;
    const uniqueSlug = `meta-test-${Date.now()}`;

    const tenant = await createTestTenant(superAdminToken, {
      name: uniqueName,
      slug: uniqueSlug,
      contactEmail: 'meta@e2e-test.local',
      plan: 'starter',
    });
    createdTenantIds.push(tenant.id);

    const dbTenant = await findTenantById(tenant.id);
    expect(dbTenant).not.toBeNull();
    expect(assertDefined(dbTenant).name).toBe(uniqueName);
    expect(assertDefined(dbTenant).slug).toBe(uniqueSlug);
    expect(assertDefined(dbTenant).plan).toBe('starter');
    expect(assertDefined(dbTenant).status).toBe('ACTIVE');
  });
});
