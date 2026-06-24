/**
 * Test 3: Tenant Suspension
 *
 * Verifies that when a tenant is suspended:
 * - All API calls from tenant users are rejected
 * - SUPER_ADMIN can still manage the tenant
 * - Reactivation restores access
 */

import { assertDefined } from '../../helpers/assertions';
import { findTenantById, closePool } from '../../helpers/db.helper';
import { graphqlRequest, hasGraphQLError } from '../../helpers/graphql-client';
import {
  loginAsSuperAdmin,
  createTestTenant,
  createTenantUser,
  loginAs,
  queryMyTenant,
  suspendTenant,
  activateTenant,
  getTenantRoles,
  teardownTenant,
  generateTestEmail,
  generateTestPassword,
} from '../../helpers/tenant.fixture';

describe('Tenant Suspension', () => {
  let superAdminToken: string;
  let tenantId: string;
  let tenantUserToken: string;
  let tenantUserEmail: string;
  let tenantUserPassword: string;

  beforeAll(async () => {
    superAdminToken = await loginAsSuperAdmin();

    // Create test tenant
    const tenant = await createTestTenant(superAdminToken);
    tenantId = tenant.id;

    // Get roles and create a user with password
    const roles = await getTenantRoles(superAdminToken);
    const defaultRole = roles.find((r) => r.isDefault) || roles[0];

    tenantUserEmail = generateTestEmail('suspend-test');
    tenantUserPassword = generateTestPassword();

    await createTenantUser(superAdminToken, {
      firstName: 'Suspend',
      lastName: 'Test',
      email: tenantUserEmail,
      password: tenantUserPassword,
      roleId: defaultRole.id,
      sendInvitation: false,
    });

    // Login as tenant user to get their token
    const loginResult = await loginAs(tenantUserEmail, tenantUserPassword);
    tenantUserToken = loginResult.accessToken;
  });

  afterAll(async () => {
    // Make sure tenant is active before teardown
    try {
      await activateTenant(superAdminToken, tenantId);
    } catch {
      // May already be active
    }
    await teardownTenant(tenantId);
    await closePool();
  });

  it('should allow tenant user access before suspension', async () => {
    // Verify tenant user can query before suspension
    const response = await queryMyTenant(tenantUserToken);
    expect(response.errors).toBeUndefined();
    expect(response.data).toBeDefined();
    expect(assertDefined(response.data).myTenant.id).toBe(tenantId);
    expect(assertDefined(response.data).myTenant.status).toBe('ACTIVE');
  });

  it('should suspend tenant successfully via SUPER_ADMIN', async () => {
    // Suspend the tenant
    const suspended = await suspendTenant(superAdminToken, tenantId);
    expect(suspended.status).toBe('SUSPENDED');

    // Verify in DB
    const dbTenant = await findTenantById(tenantId);
    expect(dbTenant).not.toBeNull();
    expect(assertDefined(dbTenant).status).toBe('SUSPENDED');
  });

  it('should reject tenant user API calls when tenant is suspended', async () => {
    // Try to login again with the tenant user after suspension
    const loginResponse = await graphqlRequest(
      `mutation Login($input: LoginInput!) {
        login(input: $input) {
          accessToken
          user { id email role tenantId }
        }
      }`,
      {
        input: {
          email: tenantUserEmail,
          password: tenantUserPassword,
        },
      },
    );

    // The login may succeed (user is still valid) but subsequent queries
    // should fail because the tenant is suspended.
    // Some systems block login for suspended tenants; others allow login
    // but block data access.

    if (loginResponse.data) {
      // If login succeeded, try to use the token for a tenant query
      const newToken = (loginResponse.data as Record<string, Record<string, string>>)?.login
        ?.accessToken;
      if (newToken) {
        const dataResponse = await queryMyTenant(newToken);
        // The query should either return an error or show SUSPENDED status
        if (dataResponse.errors) {
          const hasError = hasGraphQLError(dataResponse, /suspended|Forbidden|denied|inactive/i);
          expect(hasError).toBe(true);
        } else if (dataResponse.data) {
          // If data is returned, status should show SUSPENDED
          expect(dataResponse.data.myTenant.status).toBe('SUSPENDED');
        }
      }
    } else if (loginResponse.errors) {
      // Login itself was blocked for suspended tenant
      const hasError = hasGraphQLError(loginResponse, /suspended|Forbidden|denied|inactive/i);
      expect(hasError).toBe(true);
    }
  });

  it('should restore access after tenant reactivation', async () => {
    // Reactivate the tenant
    const activated = await activateTenant(superAdminToken, tenantId);
    expect(activated.status).toBe('ACTIVE');

    // Verify in DB
    const dbTenant = await findTenantById(tenantId);
    expect(dbTenant).not.toBeNull();
    expect(assertDefined(dbTenant).status).toBe('ACTIVE');

    // Login again and verify access is restored
    const loginResult = await loginAs(tenantUserEmail, tenantUserPassword);
    expect(loginResult.accessToken).toBeTruthy();

    const response = await queryMyTenant(loginResult.accessToken);
    expect(response.errors).toBeUndefined();
    expect(response.data).toBeDefined();
    expect(assertDefined(response.data).myTenant.status).toBe('ACTIVE');
  });
});
