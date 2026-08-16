import { createTestTenant } from './fixtures/tenant.fixture';
import { createSuperAdmin, createTenantAdmin } from './fixtures/user.fixture';
import {
  E2E_SUPER_ADMIN_EMAIL,
  E2E_TENANT_ADMIN_EMAIL,
} from './fixtures/platform-admin-credentials.fixture';
import { TestDatabase } from './helpers/db.helper';

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
  const db = new TestDatabase();

  try {
    // ── 1. Verify database connectivity ──────────────────────
    const healthy = await db.isHealthy();
    if (!healthy) {
      throw new Error(
        'Database is not reachable. Ensure PostgreSQL is running and DATABASE_URL is correct. ' +
          `Current DATABASE_URL: ${process.env.DATABASE_URL ?? '(not set, using default)'}`,
      );
    }
    console.log('[global-setup] Database connection verified');

    // ── 2. Ensure auth schema exists ─────────────────────────
    const schemas = await db.listSchemas();
    if (!schemas.includes('auth')) {
      // In CI, the auth schema must be created by migrations or service bootstrap.
      // Create it here only as a fallback for local development.
      await db.query('CREATE SCHEMA IF NOT EXISTS auth');
      console.log('[global-setup] Created auth schema (fallback)');
    }

    // Verify the tenants table exists
    const tenantsTableExists = await db.tableExists('auth', 'tenants');
    if (!tenantsTableExists) {
      // Create minimal tenants table for test isolation
      await db.query(`
        CREATE TABLE IF NOT EXISTS auth.tenants (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          slug VARCHAR(100) UNIQUE NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
          plan VARCHAR(20) NOT NULL DEFAULT 'starter',
          "maxUsers" INT NOT NULL DEFAULT 5,
          "maxStorage" INT NOT NULL DEFAULT -1,
          "contactEmail" VARCHAR(255),
          "userCount" INT NOT NULL DEFAULT 0,
          "farmCount" INT NOT NULL DEFAULT 0,
          "sensorCount" INT NOT NULL DEFAULT 0,
          "isTrialActive" BOOLEAN NOT NULL DEFAULT false,
          version INT NOT NULL DEFAULT 1,
          "createdAt" TIMESTAMP DEFAULT NOW(),
          "updatedAt" TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('[global-setup] Created auth.tenants table (fallback)');
    }

    // Verify the users table exists
    const usersTableExists = await db.tableExists('auth', 'users');
    if (!usersTableExists) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS auth.users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255),
          role VARCHAR(50) NOT NULL DEFAULT 'MODULE_USER',
          "tenantId" UUID,
          "firstName" VARCHAR(100),
          "lastName" VARCHAR(100),
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,
          "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
          "failedLoginAttempts" INT NOT NULL DEFAULT 0,
          "mfaFailedAttempts" INT NOT NULL DEFAULT 0,
          "createdAt" TIMESTAMP DEFAULT NOW(),
          "updatedAt" TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('[global-setup] Created auth.users table (fallback)');
    }

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
      email: E2E_SUPER_ADMIN_EMAIL,
      firstName: 'E2E',
      lastName: 'SuperAdmin',
    });
    console.log(`[global-setup] Created super admin: ${superAdmin.id}`);

    const tenantAdmin = await createTenantAdmin(db, tenant.id, {
      email: E2E_TENANT_ADMIN_EMAIL,
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
