import { teardownTestTenant } from './fixtures/tenant.fixture';
import { teardownTestUser } from './fixtures/user.fixture';
import { TestDatabase } from './helpers/db.helper';

/**
 * Global teardown for all E2E test suites.
 *
 * Cleans up the shared test data created in global-setup.ts:
 * - Remove the global test super admin user
 * - Remove the global test tenant admin user
 * - Remove the global test tenant (including its schema if created)
 *
 * Individual tests should clean up their own data in afterAll/afterEach,
 * but this ensures the global fixtures are always cleaned up.
 */
export default async function globalTeardown(): Promise<void> {
  const db = new TestDatabase();

  try {
    const healthy = await db.isHealthy();
    if (!healthy) {
      console.warn('[global-teardown] Database not reachable — skipping cleanup');
      return;
    }

    // Clean up global test users
    const superAdminId = process.env.E2E_SUPER_ADMIN_ID;
    if (superAdminId) {
      await teardownTestUser(db, superAdminId);
      console.log(`[global-teardown] Removed super admin: ${superAdminId}`);
    }

    const tenantAdminId = process.env.E2E_TENANT_ADMIN_ID;
    if (tenantAdminId) {
      await teardownTestUser(db, tenantAdminId);
      console.log(`[global-teardown] Removed tenant admin: ${tenantAdminId}`);
    }

    // Clean up global test tenant
    const tenantId = process.env.E2E_TENANT_ID;
    if (tenantId) {
      await teardownTestTenant(db, tenantId);
      console.log(`[global-teardown] Removed test tenant: ${tenantId}`);
    }

    // Clean up any orphaned e2e test data (belt-and-suspenders)
    await db.query(`DELETE FROM auth.users WHERE email LIKE 'e2e-%@test.aquaculture.io'`);
    await db.query(`DELETE FROM auth.tenants WHERE slug LIKE 'e2e-%'`);

    console.log('[global-teardown] E2E cleanup completed');
  } catch (error) {
    // Log but don't throw — teardown failures should not mask test failures
    console.error('[global-teardown] Error during cleanup:', error);
  } finally {
    await db.close();
  }
}
