/**
 * Test 1: Mutation Chain — Gateway -> Auth Service -> DB
 *
 * Verifies that a createTenantUser mutation flows from the gateway
 * through the auth service, persists to the database, and creates
 * the correct role assignment in the tenant schema.
 */

import { assertDefined } from '../../helpers/assertions';
import {
  findUserById,
  findUserRoleAssignment,
  deleteUserById,
  closePool,
} from '../../helpers/db.helper';
import { decodeJwt } from '../../helpers/jwt.helper';
import {
  loginAsSuperAdmin,
  createTestTenant,
  createTenantUser,
  loginAs,
  getTenantRoles,
  teardownTenant,
  generateTestEmail,
  generateTestPassword,
} from '../../helpers/tenant.fixture';

describe('Mutation Chain: Gateway -> Auth Service -> DB', () => {
  let superAdminToken: string;
  let tenantId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    superAdminToken = await loginAsSuperAdmin();

    // Create a test tenant
    const tenant = await createTestTenant(superAdminToken);
    tenantId = tenant.id;

    // Tenant operations below run with the SUPER_ADMIN token: the tenant admin
    // created by createTenant is gated behind a password-reset flow, and
    // SUPER_ADMIN can operate on any tenant directly.
  });

  afterAll(async () => {
    // Cleanup created users
    for (const userId of createdUserIds) {
      try {
        await deleteUserById(userId);
      } catch {
        // User may already be deleted
      }
    }
    await teardownTenant(tenantId);
    await closePool();
  });

  it('should create a tenant user and persist to auth.users in the DB', async () => {
    // 1. Get tenant roles to find a valid roleId
    const roles = await getTenantRoles(superAdminToken);
    expect(roles.length).toBeGreaterThan(0);

    const defaultRole = roles.find((r) => r.isDefault) || roles[0];
    expect(defaultRole).toBeDefined();

    const testEmail = generateTestEmail('mutation-chain');
    const testPassword = generateTestPassword();

    // 2. Send GraphQL mutation through gateway
    const createdUser = await createTenantUser(superAdminToken, {
      firstName: 'E2E',
      lastName: 'MutationChain',
      email: testEmail,
      password: testPassword,
      roleId: defaultRole.id,
      sendInvitation: false,
    });

    createdUserIds.push(createdUser.userId);

    // 3. Assert GraphQL response
    expect(createdUser.userId).toBeDefined();
    expect(createdUser.email).toBe(testEmail);
    expect(createdUser.firstName).toBe('E2E');
    expect(createdUser.lastName).toBe('MutationChain');

    // 4. Verify user exists in DB (auth.users)
    const dbUser = await findUserById(createdUser.userId);
    expect(dbUser).not.toBeNull();
    expect(assertDefined(dbUser).email).toBe(testEmail);
    expect(assertDefined(dbUser).tenantId).toBe(tenantId);
    expect(assertDefined(dbUser).isActive).toBe(true);
  });

  it('should create role assignment in tenant schema', async () => {
    const roles = await getTenantRoles(superAdminToken);
    const defaultRole = roles.find((r) => r.isDefault) || roles[0];

    const testEmail = generateTestEmail('role-assign');
    const testPassword = generateTestPassword();

    const createdUser = await createTenantUser(superAdminToken, {
      firstName: 'E2E',
      lastName: 'RoleAssign',
      email: testEmail,
      password: testPassword,
      roleId: defaultRole.id,
      sendInvitation: false,
    });

    createdUserIds.push(createdUser.userId);

    // Verify role assignment in tenant schema
    const roleAssignment = await findUserRoleAssignment(tenantId, createdUser.userId);
    expect(roleAssignment).not.toBeNull();
    expect(assertDefined(roleAssignment).user_id).toBe(createdUser.userId);
    expect(assertDefined(roleAssignment).role_id).toBe(defaultRole.id);
    expect(assertDefined(roleAssignment).is_active).toBe(true);
  });

  it('should return correct role info in the GraphQL response', async () => {
    const roles = await getTenantRoles(superAdminToken);
    const targetRole = roles.find((r) => r.isDefault) || roles[0];

    const testEmail = generateTestEmail('role-info');
    const testPassword = generateTestPassword();

    const createdUser = await createTenantUser(superAdminToken, {
      firstName: 'E2E',
      lastName: 'RoleInfo',
      email: testEmail,
      password: testPassword,
      roleId: targetRole.id,
      sendInvitation: false,
    });

    createdUserIds.push(createdUser.userId);

    // Verify the roleAssignment in the response matches
    expect(createdUser.roleAssignment).toBeDefined();
    expect(createdUser.roleAssignment.roleId).toBe(targetRole.id);
    expect(createdUser.roleAssignment.roleName).toBeTruthy();
  });

  it('should allow the newly created user to login successfully', async () => {
    const roles = await getTenantRoles(superAdminToken);
    const defaultRole = roles.find((r) => r.isDefault) || roles[0];

    const testEmail = generateTestEmail('login-verify');
    const testPassword = generateTestPassword();

    const createdUser = await createTenantUser(superAdminToken, {
      firstName: 'E2E',
      lastName: 'LoginVerify',
      email: testEmail,
      password: testPassword,
      roleId: defaultRole.id,
      sendInvitation: false,
    });

    createdUserIds.push(createdUser.userId);

    // Login with the new user
    const loginResult = await loginAs(testEmail, testPassword);
    expect(loginResult.accessToken).toBeTruthy();
    expect(loginResult.user.id).toBe(createdUser.userId);
    expect(loginResult.user.tenantId).toBe(tenantId);

    // Verify JWT payload
    const payload = decodeJwt(loginResult.accessToken);
    expect(payload.sub).toBe(createdUser.userId);
    expect(payload.tenantId).toBe(tenantId);
    expect(payload.email).toBe(testEmail);
  });
});
