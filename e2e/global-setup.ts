import { createTestTenant } from './fixtures/tenant.fixture';
import { createSuperAdmin, createTenantAdmin } from './fixtures/user.fixture';
import { TestDatabase } from './helpers/db.helper';
import { assertIsolatedFixtureDatabase } from './helpers/real-auth.fixture';

/**
 * Global setup for all E2E test suites.
 *
 * Responsibilities:
 * 1. Verify database connectivity
 * 2. Ensure required schemas exist (auth schema)
 * 3. Create a shared test tenant and users available to all tests
 * 4. Store test context in environment variables for test access
 *
 * The global-teardown.ts handles cleanup of everything created here.
 */
export default async function globalSetup(): Promise<void> {
  assertIsolatedFixtureDatabase();
  const db = new TestDatabase();

  try {
    // ── 1. Verify database connectivity ──────────────────────
    const healthy = await db.isHealthy();
    if (!healthy) {
      throw new Error('Isolated E2E database is not reachable');
    }
    console.log('[global-setup] Database connection verified');

    // Runtime and fixtures share the authoritative migrated schema; never fabricate tables.
    for (const table of ['tenants', 'users', 'refresh_tokens']) {
      if (!(await db.tableExists('auth', table)))
        throw new Error(`Authoritative auth.${table} migration is missing`);
    }
    const contract = await db.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='auth' AND table_name='users' AND column_name='credentialVersion') AS present`,
    );
    if (!contract.rows[0] || !contract.rows[0].present)
      throw new Error('Authentication-state migration was not applied');

    // ── 3. Create shared test tenant and users ───────────────
    const tenant = await createTestTenant(db, {
      name: 'E2E Global Test Tenant',
      slug: 'e2e-global-test',
      status: 'ACTIVE',
      plan: 'professional',
      maxUsers: 100,
    });
    console.log(`[global-setup] Created test tenant: ${tenant.id} (${tenant.slug})`);

    const superAdmin = await createSuperAdmin(db, {
      email: 'e2e-superadmin@test.aquaculture.io',
      firstName: 'E2E',
      lastName: 'SuperAdmin',
    });
    console.log(`[global-setup] Created super admin: ${superAdmin.id}`);

    const tenantAdmin = await createTenantAdmin(db, tenant.id, {
      email: 'e2e-tenantadmin@test.aquaculture.io',
      firstName: 'E2E',
      lastName: 'TenantAdmin',
    });
    console.log(`[global-setup] Created tenant admin: ${tenantAdmin.id}`);

    // ── 4. Store test context in env vars ────────────────────
    // These are available in all test files via process.env
    process.env.E2E_TENANT_ID = tenant.id;
    process.env.E2E_TENANT_SLUG = tenant.slug;
    process.env.E2E_TENANT_SCHEMA = tenant.schemaName;
    process.env.E2E_SUPER_ADMIN_ID = superAdmin.id;
    process.env.E2E_SUPER_ADMIN_TOKEN = superAdmin.token;
    process.env.E2E_TENANT_ADMIN_ID = tenantAdmin.id;
    process.env.E2E_TENANT_ADMIN_TOKEN = tenantAdmin.token;

    console.log('[global-setup] E2E environment configured successfully');
  } catch (error) {
    console.error('[global-setup] FATAL:', error);
    throw error;
  } finally {
    await db.close();
  }
}
