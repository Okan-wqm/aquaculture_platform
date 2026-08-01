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
      createdAt
    }
  }
`;

/**
 * Farm-service is the SSoT for the tenant's active Site catalog. The gateway
 * supplies the authenticated tenant boundary; callers must not pass a tenant
 * id as user-controlled GraphQL input.
 */
export const ACTIVE_SITE_ACCESS_CATALOG_QUERY = `
  query ActiveSiteAccessCatalog {
    activeSiteAccessCatalog {
      id
      name
      code
    }
  }
`;

/**
 * Auth-service is the SSoT for user_site_assignments. This read is deliberately
 * target-user scoped and guarded by TenantAdminOrHigher on the backend.
 */
export const USER_ASSIGNED_SITE_IDS_QUERY = `
  query UserAssignedSiteIds($userId: ID!) {
    userAssignedSiteIds(userId: $userId)
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

export const ASSIGN_USER_TO_SITE_MUTATION = `
  mutation AssignUserToSite($input: AssignUserToSiteInput!) {
    assignUserToSite(input: $input) {
      success
      message
      userId
      siteId
    }
  }
`;

export const UNASSIGN_USER_FROM_SITE_MUTATION = `
  mutation UnassignUserFromSite($userId: ID!, $siteId: ID!) {
    unassignUserFromSite(userId: $userId, siteId: $siteId) {
      success
      message
      userId
      siteId
    }
  }
`;
