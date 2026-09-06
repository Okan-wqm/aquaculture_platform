import { randomUUID } from 'crypto';

import { TestDatabase } from '../helpers/db.helper';
import type { TestRole } from '../helpers/jwt.helper';
import { hashPassword } from '../../libs/backend-common/src/auth/password.util';
import { assertIsolatedFixtureDatabase, FIXTURE_PASSWORD, loginFixtureUser } from '../helpers/real-auth.fixture';

/**
 * Represents a test user created by the fixture.
 */
export interface TestUser {
  id: string;
  email: string;
  role: TestRole;
  tenantId: string | null;
  firstName: string;
  lastName: string;
  /** RS256 access token obtained through actual login */
  token: string;
}

/**
 * Options for creating a test user.
 * All fields optional — sensible defaults applied.
 */
export interface CreateTestUserOptions {
  id?: string;
  email?: string;
  role?: TestRole;
  tenantId?: string | null;
  firstName?: string;
  lastName?: string;
  isActive?: boolean;
  isEmailVerified?: boolean;
  /** Password used by the real login fixture. */
  password?: string;
}

/**
 * Create a persisted test user and obtain its token through password login.
 *
 * This inserts directly into the database, bypassing the API.
 * The user entity's @BeforeInsert hook is NOT triggered,
 * so the fixture uses the production password hashing function.
 *
 * @param db - TestDatabase instance
 * @param options - User configuration overrides
 * @returns The created TestUser with a real RS256 login token
 */
export async function createTestUser(
  db: TestDatabase,
  options?: CreateTestUserOptions,
): Promise<TestUser> {
  assertIsolatedFixtureDatabase();
  const id = options?.id ?? randomUUID();
  const role = options?.role ?? 'TENANT_ADMIN';
  const tenantId =
    options?.tenantId !== undefined
      ? options.tenantId
      : role === 'SUPER_ADMIN'
        ? null
        : randomUUID();
  const email = options?.email ?? `e2e-user-${id.slice(0, 8)}@test.aquaculture.io`;
  const firstName = options?.firstName ?? 'E2E';
  const lastName = options?.lastName ?? `Test ${id.slice(0, 8)}`;
  const isActive = options?.isActive ?? true;
  const isEmailVerified = options?.isEmailVerified ?? true;
  const password = options?.password ?? FIXTURE_PASSWORD;
  const passwordHash = await hashPassword(password);

  await db.query(
    `INSERT INTO auth.users (
       id, email, password, role, "tenantId",
       "firstName", "lastName", "isActive", "isEmailVerified",
       "mfaEnabled", "failedLoginAttempts", "mfaFailedAttempts"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, 0, 0)`,
    [id, email, passwordHash, role, tenantId, firstName, lastName, true, isEmailVerified],
  );

  const token = await loginFixtureUser(email, password);
  if (!isActive) {
    await db.query('UPDATE auth.users SET "isActive" = false WHERE id = $1', [id]);
  }

  return {
    id,
    email,
    role,
    tenantId,
    firstName,
    lastName,
    token,
  };
}

/**
 * Create a SUPER_ADMIN test user.
 * Convenience wrapper — no tenant association.
 */
export async function createSuperAdmin(
  db: TestDatabase,
  options?: Omit<CreateTestUserOptions, 'role' | 'tenantId'>,
): Promise<TestUser> {
  return createTestUser(db, {
    ...options,
    role: 'SUPER_ADMIN',
    tenantId: null,
  });
}

/**
 * Create a TENANT_ADMIN test user for a specific tenant.
 */
export async function createTenantAdmin(
  db: TestDatabase,
  tenantId: string,
  options?: Omit<CreateTestUserOptions, 'role' | 'tenantId'>,
): Promise<TestUser> {
  return createTestUser(db, {
    ...options,
    role: 'TENANT_ADMIN',
    tenantId,
  });
}

/**
 * Create a MODULE_MANAGER test user for a specific tenant.
 */
export async function createModuleManager(
  db: TestDatabase,
  tenantId: string,
  options?: Omit<CreateTestUserOptions, 'role' | 'tenantId'>,
): Promise<TestUser> {
  return createTestUser(db, {
    ...options,
    role: 'MODULE_MANAGER',
    tenantId,
  });
}

/**
 * Create a MODULE_USER test user for a specific tenant.
 */
export async function createModuleUser(
  db: TestDatabase,
  tenantId: string,
  options?: Omit<CreateTestUserOptions, 'role' | 'tenantId'>,
): Promise<TestUser> {
  return createTestUser(db, {
    ...options,
    role: 'MODULE_USER',
    tenantId,
  });
}

/**
 * Clean up a test user by ID.
 */
export async function teardownTestUser(db: TestDatabase, userId: string): Promise<void> {
  await db.deleteUser(userId);
}

/**
 * Create a full set of test users for a tenant (one per role).
 * Returns an object keyed by role for easy access in tests.
 */
export interface TenantUserSet {
  tenantAdmin: TestUser;
  moduleManager: TestUser;
  moduleUser: TestUser;
}

export async function createTenantUserSet(
  db: TestDatabase,
  tenantId: string,
): Promise<TenantUserSet> {
  const [tenantAdmin, moduleManager, moduleUser] = await Promise.all([
    createTenantAdmin(db, tenantId),
    createModuleManager(db, tenantId),
    createModuleUser(db, tenantId),
  ]);

  return { tenantAdmin, moduleManager, moduleUser };
}

/**
 * Tear down all users in a TenantUserSet.
 */
export async function teardownTenantUserSet(
  db: TestDatabase,
  userSet: TenantUserSet,
): Promise<void> {
  await Promise.all([
    teardownTestUser(db, userSet.tenantAdmin.id),
    teardownTestUser(db, userSet.moduleManager.id),
    teardownTestUser(db, userSet.moduleUser.id),
  ]);
}
