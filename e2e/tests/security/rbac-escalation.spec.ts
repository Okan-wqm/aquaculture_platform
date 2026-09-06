/**
 * RBAC Escalation Prevention Tests
 *
 * Verifies that role-based access control cannot be bypassed:
 * - MODULE_USER cannot call admin-only mutations (createTenantUser, updateTenantSettings)
 * - MODULE_USER cannot access other users' settings
 * - TENANT_ADMIN cannot call SUPER_ADMIN-only operations (suspendTenant)
 */

import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

import { GraphQLTestClient, GraphQLError } from '../../helpers/graphql-client';
import { issueModuleUserToken, issueTenantAdminToken } from '../../helpers/persisted-actor.fixture';

/** Response types (zero any policy) */
interface CreateTenantUserResponse {
  createTenantUser: {
    userId: string;
    email: string;
  } | null;
}

interface MobileSettingsResponse {
  getMobileUserSettings: {
    userId: string;
    isMobileEnabled: boolean;
  } | null;
}

interface SuspendTenantResponse {
  suspendTenant: {
    id: string;
    status: string;
  } | null;
}

interface UpdateTenantSettingsResponse {
  updateTenantSettings: {
    id: string;
    name: string;
  } | null;
}

const TENANT_ID = uuidv4();
const OTHER_USER_ID = uuidv4();
const TARGET_TENANT_ID = uuidv4();

/**
 * Helper: assert that a GraphQL response contains a forbidden/access-denied error
 */
function expectForbiddenOrDenied(errors: GraphQLError[] | undefined, status: number): void {
  const isForbiddenStatus = status === 403;
  const hasForbiddenError =
    errors?.some(
      (e) =>
        e.message.includes('Access denied') ||
        e.message.includes('Forbidden') ||
        e.message.includes('does not have required role') ||
        e.message.includes('Insufficient') ||
        e.extensions?.code === 'FORBIDDEN',
    ) ?? false;

  expect(
    isForbiddenStatus || hasForbiddenError,
    `Expected forbidden response. Status: ${status}, Errors: ${JSON.stringify(errors)}`,
  ).toBe(true);
}

test.describe('RBAC Escalation Prevention', () => {
  let client: GraphQLTestClient;

  test.beforeEach(({ request }) => {
    client = new GraphQLTestClient(request);
  });

  test('MODULE_USER cannot call createTenantUser mutation', async () => {
    // Generate a MODULE_USER token (lowest privilege level)
    const moduleUserToken = await issueModuleUserToken({
      tenantId: TENANT_ID,
      email: 'user@tenant.com',
    });

    // Attempt to create a new tenant user — requires TENANT_ADMIN or higher
    const response = await client.mutate<CreateTenantUserResponse>(
      `mutation CreateUser($input: CreateTenantUserInput!) {
        createTenantUser(input: $input) {
          userId
          email
        }
      }`,
      {
        input: {
          firstName: 'Test',
          lastName: 'User',
          email: 'newuser@tenant.com',
          password: 'TestP@ss123!',
          roleId: uuidv4(),
        },
      },
      {
        token: moduleUserToken,
        tenantId: TENANT_ID,
      },
    );

    // Must be rejected — MODULE_USER lacks TENANT_ADMIN role
    expectForbiddenOrDenied(response.body.errors, response.status);

    // Data must not be returned
    if (response.body.data) {
      expect(response.body.data.createTenantUser).toBeNull();
    }
  });

  test('MODULE_USER cannot access MobileSettings for other users', async () => {
    const moduleUserToken = await issueModuleUserToken({
      tenantId: TENANT_ID,
      email: 'user@tenant.com',
    });

    // Attempt to read another user's mobile settings
    const response = await client.query<MobileSettingsResponse>(
      `query GetMobileSettings($userId: ID!) {
        getMobileUserSettings(userId: $userId) {
          userId
          isMobileEnabled
        }
      }`,
      { userId: OTHER_USER_ID },
      {
        token: moduleUserToken,
        tenantId: TENANT_ID,
      },
    );

    // The getMobileUserSettings resolver uses @CurrentUser().tenantId for filtering.
    // If the other user doesn't belong to the same tenant, it should fail.
    // Even within the same tenant, a MODULE_USER should not be able to
    // access other users' settings without proper authorization.
    //
    // Acceptable outcomes:
    // 1. 403 Forbidden (role guard blocks it)
    // 2. null/empty result (service layer filters it)
    // 3. Error about not found
    if (response.body.errors && response.body.errors.length > 0) {
      // Error is acceptable — either forbidden or not found
      expect(response.body.errors.length).toBeGreaterThan(0);
    } else if (response.body.data?.getMobileUserSettings) {
      // If data is returned, it should only be for the requesting user's own settings
      // In a properly isolated system, another user's settings should not leak
      expect(response.body.data.getMobileUserSettings.userId).not.toBe(OTHER_USER_ID);
    }
  });

  test('TENANT_ADMIN cannot call suspendTenant', async () => {
    // Generate a TENANT_ADMIN token — should NOT have SUPER_ADMIN privileges
    const tenantAdminToken = await issueTenantAdminToken({
      tenantId: TENANT_ID,
      email: 'admin@tenant.com',
    });

    // Attempt to suspend a tenant — @SuperAdminOnly() operation
    const response = await client.mutate<SuspendTenantResponse>(
      `mutation SuspendTenant($id: ID!) {
        suspendTenant(id: $id) {
          id
          status
        }
      }`,
      { id: TARGET_TENANT_ID },
      {
        token: tenantAdminToken,
        tenantId: TENANT_ID,
      },
    );

    // Must be rejected — suspendTenant requires SUPER_ADMIN
    expectForbiddenOrDenied(response.body.errors, response.status);

    // Data must not be returned
    if (response.body.data) {
      expect(response.body.data.suspendTenant).toBeNull();
    }
  });

  test('MODULE_USER cannot call updateTenantSettings', async () => {
    const moduleUserToken = await issueModuleUserToken({
      tenantId: TENANT_ID,
      email: 'user@tenant.com',
    });

    // Attempt to update tenant settings — @TenantAdminOrHigher() operation
    const response = await client.mutate<UpdateTenantSettingsResponse>(
      `mutation UpdateSettings($input: UpdateTenantInput!) {
        updateTenantSettings(input: $input) {
          id
          name
        }
      }`,
      {
        input: {
          name: 'Hacked Tenant Name',
        },
      },
      {
        token: moduleUserToken,
        tenantId: TENANT_ID,
      },
    );

    // Must be rejected — updateTenantSettings requires TENANT_ADMIN or higher
    expectForbiddenOrDenied(response.body.errors, response.status);

    // Data must not be returned
    if (response.body.data) {
      expect(response.body.data.updateTenantSettings).toBeNull();
    }
  });
});
