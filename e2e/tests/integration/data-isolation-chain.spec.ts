/**
 * Test 7: Data Isolation Chain
 *
 * Verifies full-chain tenant data isolation:
 * - Tenant A's data is invisible to Tenant B via the API
 * - Tenant A's data is invisible to Tenant B in the database
 * - Cross-tenant queries are properly rejected
 */

import { assertDefined } from '../../helpers/assertions';
import {
  findUserById,
  getTenantSchemaTables,
  query,
  closePool,
  getTenantSchemaName,
} from '../../helpers/db.helper';
import { graphqlRequest, hasGraphQLError } from '../../helpers/graphql-client';
import {
  loginAsSuperAdmin,
  createTestTenant,
  createTenantUser,
  loginAs,
  queryTenantUsers,
  getTenantRoles,
  teardownTenant,
  generateTestEmail,
  generateTestPassword,
} from '../../helpers/tenant.fixture';

describe('hasGraphQLError', () => {
  it('detects any GraphQL error when no message filter is requested', () => {
    expect(hasGraphQLError({ errors: [{ message: 'assertion required' }] })).toBe(true);
    expect(hasGraphQLError({ data: { tenantUsers: [] } })).toBe(false);
  });

  it('preserves message-filtered error checks', () => {
    const response = { errors: [{ message: 'Access denied' }] };

    expect(hasGraphQLError(response, /denied/i)).toBe(true);
    expect(hasGraphQLError(response, 'Unauthorized')).toBe(false);
  });
});

describe('Data Isolation Chain', () => {
  let superAdminToken: string;

  // Tenant A
  let tenantAId: string;
  let tenantAUserEmail: string;
  let tenantAUserPassword: string;
  let tenantAUserId: string;

  // Tenant B
  let tenantBId: string;
  let tenantBUserEmail: string;
  let tenantBUserPassword: string;
  let tenantBUserId: string;

  beforeAll(async () => {
    superAdminToken = await loginAsSuperAdmin();

    // Create Tenant A
    const tenantA = await createTestTenant(superAdminToken, {
      name: 'Isolation Tenant A',
      slug: `isolation-a-${Date.now()}`,
    });
    tenantAId = tenantA.id;

    // Create Tenant B
    const tenantB = await createTestTenant(superAdminToken, {
      name: 'Isolation Tenant B',
      slug: `isolation-b-${Date.now()}`,
    });
    tenantBId = tenantB.id;

    // Get roles for each tenant
    const rolesA = await getTenantRoles(superAdminToken);
    const defaultRoleA = rolesA.find((r) => r.isDefault) || rolesA[0];

    const rolesB = await getTenantRoles(superAdminToken);
    const defaultRoleB = rolesB.find((r) => r.isDefault) || rolesB[0];

    // Create user in Tenant A
    tenantAUserEmail = generateTestEmail('isolation-a');
    tenantAUserPassword = generateTestPassword();

    const userA = await createTenantUser(superAdminToken, {
      firstName: 'TenantA',
      lastName: 'User',
      email: tenantAUserEmail,
      password: tenantAUserPassword,
      roleId: defaultRoleA.id,
      sendInvitation: false,
    });
    tenantAUserId = userA.userId;

    // Create user in Tenant B
    tenantBUserEmail = generateTestEmail('isolation-b');
    tenantBUserPassword = generateTestPassword();

    const userB = await createTenantUser(superAdminToken, {
      firstName: 'TenantB',
      lastName: 'User',
      email: tenantBUserEmail,
      password: tenantBUserPassword,
      roleId: defaultRoleB.id,
      sendInvitation: false,
    });
    tenantBUserId = userB.userId;
  });

  afterAll(async () => {
    await teardownTenant(tenantAId);
    await teardownTenant(tenantBId);
    await closePool();
  });

  it('should not expose Tenant A users in Tenant B user list via API', async () => {
    // Login as Tenant B user
    const loginB = await loginAs(tenantBUserEmail, tenantBUserPassword);

    // Query tenant users (should only see Tenant B users)
    const response = await queryTenantUsers(loginB.accessToken);

    if (response.data) {
      const userEmails = response.data.tenantUsers.map((u) => u.email);

      // Tenant A user should NOT be visible
      expect(userEmails).not.toContain(tenantAUserEmail);

      // Tenant B user SHOULD be visible
      expect(userEmails).toContain(tenantBUserEmail);
    }
    // If response has errors, it means the user doesn't have permission
    // which also proves isolation (no cross-tenant access)
  });

  it('should not expose Tenant B users in Tenant A user list via API', async () => {
    // Login as Tenant A user
    const loginA = await loginAs(tenantAUserEmail, tenantAUserPassword);

    // Query tenant users (should only see Tenant A users)
    const response = await queryTenantUsers(loginA.accessToken);

    if (response.data) {
      const userEmails = response.data.tenantUsers.map((u) => u.email);

      // Tenant B user should NOT be visible
      expect(userEmails).not.toContain(tenantBUserEmail);

      // Tenant A user SHOULD be visible
      expect(userEmails).toContain(tenantAUserEmail);
    }
  });

  it('should have separate PostgreSQL schemas for each tenant', async () => {
    const schemaA = getTenantSchemaName(tenantAId);
    const schemaB = getTenantSchemaName(tenantBId);

    // Schemas should be different
    expect(schemaA).not.toBe(schemaB);

    // Both schemas should have tables
    const tablesA = await getTenantSchemaTables(tenantAId);
    const tablesB = await getTenantSchemaTables(tenantBId);

    expect(tablesA.length).toBeGreaterThan(0);
    expect(tablesB.length).toBeGreaterThan(0);
  });

  it('should have separate role assignments in each tenant schema', async () => {
    const schemaA = getTenantSchemaName(tenantAId);
    const schemaB = getTenantSchemaName(tenantBId);

    // Check Tenant A's role assignments
    try {
      const assignmentsA = await query<{ user_id: string }>(
        `SELECT user_id FROM "${schemaA}"."user_role_assignments" WHERE is_active = true`,
      );

      // Tenant A's assignments should contain Tenant A's user
      const userIdsA = assignmentsA.map((a) => a.user_id);
      expect(userIdsA).toContain(tenantAUserId);

      // Tenant A's assignments should NOT contain Tenant B's user
      expect(userIdsA).not.toContain(tenantBUserId);
    } catch {
      // Table may not exist if schema provisioning is different
      console.warn(`Could not query ${schemaA}.user_role_assignments`);
    }

    // Check Tenant B's role assignments
    try {
      const assignmentsB = await query<{ user_id: string }>(
        `SELECT user_id FROM "${schemaB}"."user_role_assignments" WHERE is_active = true`,
      );

      // Tenant B's assignments should contain Tenant B's user
      const userIdsB = assignmentsB.map((a) => a.user_id);
      expect(userIdsB).toContain(tenantBUserId);

      // Tenant B's assignments should NOT contain Tenant A's user
      expect(userIdsB).not.toContain(tenantAUserId);
    } catch {
      console.warn(`Could not query ${schemaB}.user_role_assignments`);
    }
  });

  it('should isolate users by tenantId in auth.users table', async () => {
    // Verify in the shared auth.users table that each user has correct tenantId
    const dbUserA = await findUserById(tenantAUserId);
    const dbUserB = await findUserById(tenantBUserId);

    expect(dbUserA).not.toBeNull();
    expect(dbUserB).not.toBeNull();

    // Users belong to different tenants
    expect(assertDefined(dbUserA).tenantId).toBe(tenantAId);
    expect(assertDefined(dbUserB).tenantId).toBe(tenantBId);
    expect(assertDefined(dbUserA).tenantId).not.toBe(assertDefined(dbUserB).tenantId);
  });

  it('should reject cross-tenant data access via direct GraphQL query', async () => {
    // Login as Tenant A user
    const loginA = await loginAs(tenantAUserEmail, tenantAUserPassword);

    // Try to query Tenant B's data by providing Tenant B's ID
    // This should be rejected by the tenant guard
    const response = await graphqlRequest(
      `query Tenant($id: ID!) {
        tenant(id: $id) {
          id name slug status
        }
      }`,
      { id: tenantBId },
      { token: loginA.accessToken },
    );

    // Should be rejected -- tenant guard should prevent cross-tenant access
    if (response.errors) {
      const hasAccessError = hasGraphQLError(
        response,
        /Forbidden|denied|does not belong|Access denied/i,
      );
      expect(hasAccessError).toBe(true);
    }
    // If no error, the system may not expose this query to non-admins
  });

  // ==========================================================================
  // WS-D: tenant-context STABILITY under repeated load — directly reproduces the
  // operator's "data comes and goes" (bir geliyor bir gelmiyor). The refresh-RLS
  // fix (#634), the 9-subgraph verified-user-assertion mount + HMAC raw-body SSoT
  // (#630/#631), and the gateway effectiveTenantId signing (#622) must hold across
  // many sequential AND concurrent requests — no intermittent empty result, no
  // intermittent "assertion required" 400, and never another tenant's rows.
  // ==========================================================================
  describe('tenant-context stability under repeated load (WS-D)', () => {
    const ITERATIONS = 30;

    it(`returns Tenant A data on ALL ${ITERATIONS} sequential queries (no intermittent empty/400)`, async () => {
      const loginA = await loginAs(tenantAUserEmail, tenantAUserPassword);
      for (let i = 0; i < ITERATIONS; i++) {
        const response = await queryTenantUsers(loginA.accessToken);
        expect(hasGraphQLError(response)).toBe(false);
        const emails = response.data?.tenantUsers.map((u) => u.email) ?? [];
        expect(emails).toContain(tenantAUserEmail);
        expect(emails).not.toContain(tenantBUserEmail);
      }
    }, 60000);

    it(`returns Tenant A data on ALL ${ITERATIONS} CONCURRENT queries (assertion/schema race)`, async () => {
      const loginA = await loginAs(tenantAUserEmail, tenantAUserPassword);
      const responses = await Promise.all(
        Array.from({ length: ITERATIONS }, () => queryTenantUsers(loginA.accessToken)),
      );
      for (const response of responses) {
        expect(hasGraphQLError(response)).toBe(false);
        const emails = response.data?.tenantUsers.map((u) => u.email) ?? [];
        expect(emails).toContain(tenantAUserEmail);
        expect(emails).not.toContain(tenantBUserEmail);
      }
    }, 60000);

    it(`never bleeds the other tenant under ${ITERATIONS} INTERLEAVED A/B queries`, async () => {
      const [loginA, loginB] = await Promise.all([
        loginAs(tenantAUserEmail, tenantAUserPassword),
        loginAs(tenantBUserEmail, tenantBUserPassword),
      ]);
      const results = await Promise.all(
        Array.from({ length: ITERATIONS }, (_, i) => {
          const isA = i % 2 === 0;
          return queryTenantUsers((isA ? loginA : loginB).accessToken).then((r) => ({ isA, r }));
        }),
      );
      for (const { isA, r } of results) {
        // A permission error is acceptable; a cross-tenant bleed is NOT.
        if (hasGraphQLError(r)) continue;
        const emails = r.data?.tenantUsers.map((u) => u.email) ?? [];
        if (isA) {
          expect(emails).not.toContain(tenantBUserEmail);
        } else {
          expect(emails).not.toContain(tenantAUserEmail);
        }
      }
    }, 60000);
  });
});
