/**
 * Test 4: Schema Provisioning
 *
 * Verifies that when a new tenant is created via the GraphQL API:
 * - A PostgreSQL schema is provisioned with the correct naming convention
 * - The schema contains the expected tables for all assigned modules
 * - The tenant record in auth.tenants has the correct status
 */

import {
  loginAsSuperAdmin,
  createTestTenant,
  teardownTenant,
} from '../../helpers/tenant.fixture';
import {
  findTenantById,
  tenantSchemaExists,
  getTenantSchemaTables,
  getTenantSchemaName,
  closePool,
} from '../../helpers/db.helper';

/**
 * Minimum expected tables in a tenant schema.
 * These are the core tables provisioned by the schema manager
 * for tenant-level role management and data isolation.
 */
const CORE_TENANT_TABLES = [
  'tenant_roles',
  'tenant_role_permissions',
  'user_role_assignments',
];

describe('Schema Provisioning', () => {
  let superAdminToken: string;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    superAdminToken = await loginAsSuperAdmin();
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      await teardownTenant(tenantId);
    }
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

  it('should set tenant status to ACTIVE after successful provisioning', async () => {
    const tenant = await createTestTenant(superAdminToken);
    createdTenantIds.push(tenant.id);

    // Verify tenant status in DB
    const dbTenant = await findTenantById(tenant.id);
    expect(dbTenant).not.toBeNull();
    expect(dbTenant!.status).toBe('ACTIVE');
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
    expect(dbTenant!.name).toBe(uniqueName);
    expect(dbTenant!.slug).toBe(uniqueSlug);
    expect(dbTenant!.plan).toBe('starter');
    expect(dbTenant!.status).toBe('ACTIVE');
  });
});
