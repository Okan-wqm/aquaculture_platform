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

// WHY: Include accessType in the user list query so the UI can display
// platform access badges and pre-populate the edit form.
export const TENANT_USERS_QUERY = `
  query TenantUsers($status: String, $role: String, $limit: Int, $offset: Int) {
    tenantUsers(status: $status, role: $role, limit: $limit, offset: $offset) {
      id
      email
      firstName
      lastName
      role
      accessType
      isActive
      isEmailVerified
      lastLoginAt
      createdAt
    }
  }
`;

// ============================================================================
// Mutations
// ============================================================================

// WHY: The mutation input now includes accessType so the backend can set
// platform access level and auto-provision mobile settings on user creation.
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

// WHY: Return accessType after update so the cache stays in sync with server state.
export const UPDATE_USER_MUTATION = `
  mutation UpdateTenantUser($userId: ID!, $input: UpdateTenantUserInput!) {
    updateTenantUser(userId: $userId, input: $input) {
      id
      email
      firstName
      lastName
      role
      accessType
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
