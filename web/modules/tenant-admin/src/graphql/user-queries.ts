/**
 * GraphQL queries and mutations for tenant user management.
 *
 * TENANT_USERS_QUERY is the single parameterized version that
 * replaces 3+ inline variants with different field selections.
 * All fields are included; callers filter on the client side.
 */

// ============================================================================
// Queries
// ============================================================================

export const TENANT_USERS_QUERY = `
  query TenantUsers($status: String, $role: String, $limit: Int, $offset: Int) {
    tenantUsers(status: $status, role: $role, limit: $limit, offset: $offset) {
      id
      email
      firstName
      lastName
      role
      isActive
      isEmailVerified
      lastLoginAt
      lockedUntil
      createdAt
    }
  }
`;

export const USER_EFFECTIVE_PERMISSIONS_QUERY = `
  query GetUserEffectivePermissions($userId: ID!) {
    getUserEffectivePermissions(userId: $userId) {
      roleId
      roleName
      panelPermissions
      resourcePermissions
      overrides { grants revokes }
    }
  }
`;

// ============================================================================
// Mutations
// ============================================================================

export const CREATE_TENANT_USER_MUTATION = `
  mutation CreateTenantUser($input: CreateTenantUserInput!) {
    createTenantUser(input: $input) {
      userId
      email
      firstName
      lastName
      roleAssignment { id roleId roleName }
      invitationSent
      createdAt
    }
  }
`;

export const UPDATE_USER_MUTATION = `
  mutation UpdateTenantUser($userId: ID!, $input: UpdateTenantUserInput!) {
    updateTenantUser(userId: $userId, input: $input) {
      id
      email
      firstName
      lastName
      role
      isActive
    }
  }
`;

export const DELETE_USER_MUTATION = `
  mutation DeleteTenantUser($userId: ID!) {
    deleteTenantUser(userId: $userId)
  }
`;

export const DEACTIVATE_TENANT_USER_MUTATION = `
  mutation DeactivateTenantUser($userId: ID!) {
    deactivateTenantUser(userId: $userId) {
      id
      isActive
    }
  }
`;

export const ACTIVATE_TENANT_USER_MUTATION = `
  mutation ActivateTenantUser($userId: ID!) {
    activateTenantUser(userId: $userId) {
      id
      isActive
    }
  }
`;

// Clears the failed-login lockout (server resets failedLoginAttempts and
// nulls lockedUntil — ORPHAN-MEDIUM-320).
export const UNLOCK_TENANT_USER_MUTATION = `
  mutation UnlockTenantUser($userId: ID!) {
    unlockTenantUser(userId: $userId) {
      id
      lockedUntil
    }
  }
`;

export const BULK_ASSIGN_USER_ROLE_MUTATION = `
  mutation BulkAssignUserRole($input: BulkAssignRoleInput!) {
    bulkAssignUserRole(input: $input) {
      success
      failed { userId error }
    }
  }
`;
