/**
 * Tenant Fixture Helper for E2E Integration Tests
 *
 * Provides reusable fixtures for creating and tearing down
 * tenants, users, and roles during integration tests.
 */

import { graphqlMutation, graphqlQuery, graphqlRequest, GraphQLResponse } from './graphql-client';
import { decodeJwt } from './jwt.helper';
import { deleteTenant, deleteUserById, findUserByEmail, closePool } from './db.helper';

// ============================================================
// SUPER_ADMIN Authentication
// ============================================================

const SUPER_ADMIN_EMAIL = process.env['SUPER_ADMIN_EMAIL'] || 'admin@aquaculture.local';
const SUPER_ADMIN_PASSWORD = process.env['SUPER_ADMIN_PASSWORD'] || 'Admin123!@#';

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    role: string;
    tenantId: string | null;
  };
  expiresIn: number;
}

/**
 * Login as SUPER_ADMIN and return access token.
 */
export async function loginAsSuperAdmin(): Promise<string> {
  const result = await graphqlMutation<{ login: LoginResult }>(
    `mutation Login($input: LoginInput!) {
      login(input: $input) {
        accessToken
        refreshToken
        user { id email role tenantId }
        expiresIn
      }
    }`,
    {
      input: {
        email: SUPER_ADMIN_EMAIL,
        password: SUPER_ADMIN_PASSWORD,
      },
    },
  );
  return result.login.accessToken;
}

/**
 * Login with specific credentials and return full auth payload.
 */
export async function loginAs(email: string, password: string): Promise<LoginResult> {
  const result = await graphqlMutation<{ login: LoginResult }>(
    `mutation Login($input: LoginInput!) {
      login(input: $input) {
        accessToken
        refreshToken
        user { id email role tenantId }
        expiresIn
      }
    }`,
    {
      input: { email, password },
    },
  );
  return result.login;
}

/**
 * Attempt login and return raw response (for error testing).
 */
export async function attemptLogin(
  email: string,
  password: string,
): Promise<GraphQLResponse<{ login: LoginResult }>> {
  return graphqlRequest<{ login: LoginResult }>(
    `mutation Login($input: LoginInput!) {
      login(input: $input) {
        accessToken
        refreshToken
        user { id email role tenantId }
        expiresIn
      }
    }`,
    {
      input: { email, password },
    },
  );
}

// ============================================================
// Tenant Creation / Teardown
// ============================================================

interface CreatedTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
}

/**
 * Create a test tenant via the GraphQL API (requires SUPER_ADMIN token).
 */
export async function createTestTenant(
  superAdminToken: string,
  overrides: Partial<{
    name: string;
    slug: string;
    contactEmail: string;
    plan: string;
  }> = {},
): Promise<CreatedTenant> {
  const suffix = Math.random().toString(36).substring(2, 8);
  const name = overrides.name || `E2E Test Tenant ${suffix}`;
  const slug = overrides.slug || `e2e-test-${suffix}`;
  const contactEmail = overrides.contactEmail || `admin-${suffix}@e2e-test.local`;

  const result = await graphqlMutation<{ createTenant: CreatedTenant }>(
    `mutation CreateTenant($input: CreateTenantInput!) {
      createTenant(input: $input) {
        id
        name
        slug
        status
        plan
      }
    }`,
    {
      input: {
        name,
        slug,
        contactEmail,
        plan: overrides.plan || 'starter',
      },
    },
    { token: superAdminToken },
  );

  return result.createTenant;
}

/**
 * Suspend a tenant via the GraphQL API (requires SUPER_ADMIN token).
 */
export async function suspendTenant(
  superAdminToken: string,
  tenantId: string,
): Promise<CreatedTenant> {
  const result = await graphqlMutation<{ suspendTenant: CreatedTenant }>(
    `mutation SuspendTenant($id: ID!) {
      suspendTenant(id: $id) {
        id name slug status
      }
    }`,
    { id: tenantId },
    { token: superAdminToken },
  );
  return result.suspendTenant;
}

/**
 * Activate a tenant via the GraphQL API (requires SUPER_ADMIN token).
 */
export async function activateTenant(
  superAdminToken: string,
  tenantId: string,
): Promise<CreatedTenant> {
  const result = await graphqlMutation<{ activateTenant: CreatedTenant }>(
    `mutation ActivateTenant($id: ID!) {
      activateTenant(id: $id) {
        id name slug status
      }
    }`,
    { id: tenantId },
    { token: superAdminToken },
  );
  return result.activateTenant;
}

// ============================================================
// User Creation / Teardown
// ============================================================

interface CreatedTenantUser {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  roleAssignment: {
    id: string;
    roleId: string;
    roleName: string;
    resourcePermissions: string[];
    effectivePermissions: string[];
  };
  invitationSent: boolean;
}

/**
 * Create a tenant user via the GraphQL API (requires TENANT_ADMIN or SUPER_ADMIN token).
 */
export async function createTenantUser(
  token: string,
  input: {
    firstName: string;
    lastName: string;
    email: string;
    password?: string;
    roleId: string;
    sendInvitation?: boolean;
  },
): Promise<CreatedTenantUser> {
  const result = await graphqlMutation<{ createTenantUser: CreatedTenantUser }>(
    `mutation CreateTenantUser($input: CreateTenantUserInput!) {
      createTenantUser(input: $input) {
        userId
        email
        firstName
        lastName
        roleAssignment {
          id
          roleId
          roleName
          resourcePermissions
          effectivePermissions
        }
        invitationSent
      }
    }`,
    {
      input: {
        ...input,
        sendInvitation: input.sendInvitation ?? false,
      },
    },
    { token },
  );

  return result.createTenantUser;
}

// ============================================================
// Tenant Role Helpers
// ============================================================

interface TenantRoleSummary {
  id: string;
  name: string;
  level: number;
  isDefault: boolean;
  permissions: {
    id: string;
    resourcePermissions: string[];
    panelPermissions: Record<string, unknown>;
  } | null;
}

/**
 * Get all tenant roles (requires TENANT_ADMIN or higher token).
 */
export async function getTenantRoles(token: string): Promise<TenantRoleSummary[]> {
  const result = await graphqlQuery<{ tenantRoles: TenantRoleSummary[] }>(
    `query TenantRoles {
      tenantRoles {
        id name level isDefault
        permissions {
          id
          resourcePermissions
          panelPermissions
        }
      }
    }`,
    {},
    { token },
  );
  return result.tenantRoles;
}

/**
 * Create a custom tenant role.
 */
export async function createTenantRole(
  token: string,
  input: {
    name: string;
    description?: string;
    level?: number;
    isDefault?: boolean;
    panelPermissions: Record<string, unknown>;
  },
): Promise<TenantRoleSummary> {
  const result = await graphqlMutation<{ createTenantRole: TenantRoleSummary }>(
    `mutation CreateTenantRole($input: CreateTenantRoleInput!) {
      createTenantRole(input: $input) {
        id name level isDefault
        permissions {
          id
          resourcePermissions
          panelPermissions
        }
      }
    }`,
    { input },
    { token },
  );
  return result.createTenantRole;
}

/**
 * Update a tenant role's permissions.
 */
export async function updateTenantRole(
  token: string,
  roleId: string,
  input: {
    name?: string;
    panelPermissions?: Record<string, unknown>;
  },
): Promise<TenantRoleSummary> {
  const result = await graphqlMutation<{ updateTenantRole: TenantRoleSummary }>(
    `mutation UpdateTenantRole($roleId: ID!, $input: UpdateTenantRoleInput!) {
      updateTenantRole(roleId: $roleId, input: $input) {
        id name level isDefault
        permissions {
          id
          resourcePermissions
          panelPermissions
        }
      }
    }`,
    { roleId, input },
    { token },
  );
  return result.updateTenantRole;
}

// ============================================================
// Token Refresh
// ============================================================

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<LoginResult> {
  const result = await graphqlMutation<{ refreshToken: LoginResult }>(
    `mutation RefreshToken($input: RefreshTokenInput!) {
      refreshToken(input: $input) {
        accessToken
        refreshToken
        user { id email role tenantId }
        expiresIn
      }
    }`,
    {
      input: { refreshToken },
    },
  );
  return result.refreshToken;
}

// ============================================================
// Query Helpers
// ============================================================

/**
 * Query myTenant (requires authenticated token with tenant).
 */
export async function queryMyTenant(
  token: string,
): Promise<GraphQLResponse<{ myTenant: CreatedTenant }>> {
  return graphqlRequest<{ myTenant: CreatedTenant }>(
    `query MyTenant {
      myTenant {
        id name slug status plan
      }
    }`,
    {},
    { token },
  );
}

/**
 * Query tenantUsers (requires TENANT_ADMIN token).
 */
export async function queryTenantUsers(
  token: string,
): Promise<GraphQLResponse<{ tenantUsers: Array<{ id: string; email: string; firstName: string | null; tenantId: string | null }> }>> {
  return graphqlRequest<{ tenantUsers: Array<{ id: string; email: string; firstName: string | null; tenantId: string | null }> }>(
    `query TenantUsers {
      tenantUsers {
        id email firstName tenantId
      }
    }`,
    {},
    { token },
  );
}

/**
 * Deactivate a tenant user.
 */
export async function deactivateTenantUser(
  token: string,
  userId: string,
): Promise<{ id: string; isActive: boolean }> {
  const result = await graphqlMutation<{ deactivateTenantUser: { id: string; isActive: boolean } }>(
    `mutation DeactivateTenantUser($userId: ID!) {
      deactivateTenantUser(userId: $userId) {
        id
        isActive
      }
    }`,
    { userId },
    { token },
  );
  return result.deactivateTenantUser;
}

/**
 * Delete a tenant user.
 */
export async function deleteTenantUser(
  token: string,
  userId: string,
): Promise<boolean> {
  const result = await graphqlMutation<{ deleteTenantUser: boolean }>(
    `mutation DeleteTenantUser($userId: ID!) {
      deleteTenantUser(userId: $userId)
    }`,
    { userId },
    { token },
  );
  return result.deleteTenantUser;
}

// ============================================================
// Cleanup
// ============================================================

/**
 * Full teardown: delete tenant, its schema, and close DB pool.
 */
export async function teardownTenant(tenantId: string): Promise<void> {
  try {
    await deleteTenant(tenantId);
  } catch (error) {
    console.warn(`Teardown warning for tenant ${tenantId}: ${(error as Error).message}`);
  }
}

/**
 * Full teardown and close DB connections.
 */
export async function teardownAll(tenantIds: string[]): Promise<void> {
  for (const id of tenantIds) {
    await teardownTenant(id);
  }
  await closePool();
}

/**
 * Generate a unique test email.
 */
export function generateTestEmail(prefix: string = 'e2e'): string {
  const suffix = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${suffix}@e2e-test.local`;
}

/**
 * Generate a strong test password that meets validation requirements.
 */
export function generateTestPassword(): string {
  return `E2eTest${Math.random().toString(36).substring(2, 6)}!1A`;
}
