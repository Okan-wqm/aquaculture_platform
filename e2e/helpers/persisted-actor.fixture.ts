import { randomUUID } from 'node:crypto';
import { createTestTenant } from '../fixtures/tenant.fixture';
import { createTestUser } from '../fixtures/user.fixture';
import { TestDatabase } from './db.helper';
import type { TestTokenOptions } from './jwt.helper';
import { assertIsolatedFixtureDatabase, FIXTURE_PASSWORD, loginFixtureUser } from './real-auth.fixture';

type PersistedActorOptions = Pick<TestTokenOptions, 'userId' | 'sub' | 'email' | 'role' | 'roles' | 'tenantId'>;

/** Replace fabricated successful JWTs with persisted actors and real login. */
export async function issueTestToken(options: PersistedActorOptions = {}): Promise<string> {
  assertIsolatedFixtureDatabase();
  const role = options.role ?? (options.roles ? options.roles[0] : undefined) ?? 'TENANT_ADMIN';
  const tenantId = options.tenantId === undefined ? (role === 'SUPER_ADMIN' ? null : randomUUID()) : options.tenantId;
  const userId = options.userId ?? options.sub ?? randomUUID();
  const db = new TestDatabase();
  try {
    if (tenantId) {
      const existing = await db.query<{ id: string }>('SELECT id FROM auth.tenants WHERE id = $1', [tenantId]);
      if (existing.rowCount === 0) await createTestTenant(db, { id: tenantId });
    }
    const existing = await db.query<{ email: string; role: string; tenantId: string | null }>(
      'SELECT email, role, "tenantId" FROM auth.users WHERE id = $1', [userId]);
    const user = existing.rows[0];
    if (user) {
      if (user.role !== role || user.tenantId !== tenantId) throw new Error('Fixture identity disagrees with persisted actor');
      return await loginFixtureUser(user.email, FIXTURE_PASSWORD);
    }
    const created = await createTestUser(db, { id: userId, email: options.email, role, tenantId });
    return created.token;
  } finally {
    await db.close();
  }
}

export async function issueModuleUserToken(options: PersistedActorOptions = {}): Promise<string> {
  return issueTestToken({ ...options, role: 'MODULE_USER' });
}
export async function issueTenantAdminToken(options: PersistedActorOptions = {}): Promise<string> {
  return issueTestToken({ ...options, role: 'TENANT_ADMIN' });
}
