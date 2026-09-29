import { createTestTenant } from './fixtures/tenant.fixture';
import { createSuperAdmin, createTenantAdmin } from './fixtures/user.fixture';
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

    // ── 2. Require the authoritative auth schema ─────────────
    //
    // ORPHAN-MEDIUM-814: this used to CREATE the auth schema and hand-written
    // copies of auth.tenants / auth.users when they were missing. The copies
    // carried a `credentialVersion` column but not the trigger that owns it
    // (migration 1819200000000-AddUserCredentialVersion), so a suite run on
    // them exercised a token-issuance fence that production does not have.
    // The migration runner is the only author of this schema: an environment
    // it has not migrated is refused here, by name, instead of being faked.
    await requireMigratedAuthSchema(db);

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

/**
 * The auth tables and the credential-version trigger exist only when the
 * auth-service migrations ran; each missing piece is named in the error.
 */
async function requireMigratedAuthSchema(db: TestDatabase): Promise<void> {
  const missing: string[] = [];
  for (const table of ['tenants', 'users']) {
    if (!(await db.tableExists('auth', table))) {
      missing.push(`table auth.${table}`);
    }
  }
  const trigger = await db.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'auth' AND c.relname = 'users'
          AND t.tgname = 'trg_users_bump_credential_version'
          AND NOT t.tgisinternal
     ) AS present`,
  );
  if (!trigger.rows[0]?.present) {
    missing.push('trigger auth.users.trg_users_bump_credential_version');
  }
  if (missing.length > 0) {
    throw new Error(
      `[global-setup] The database is not migrated (missing: ${missing.join(', ')}). ` +
        'Run the auth-service migrations (db-migrate) before the E2E suite; ' +
        'the suite never fabricates schema.',
    );
  }
  console.log('[global-setup] Auth schema verified against its migrations');
}
