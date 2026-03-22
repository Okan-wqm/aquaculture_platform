/**
 * GraphQL queries and mutations for tenant role and permission management.
 */

// ============================================================================
// Role fragment (shared field selection)
// ============================================================================

const ROLE_FIELDS = `
  id name description color icon level isSystem isDefault userCount createdAt updatedAt
  permissions { id roleId panelPermissions resourcePermissions }
`;

// ============================================================================
// Queries
// ============================================================================

export const TENANT_ROLES_QUERY = `
  query TenantRoles {
    tenantRoles {
      ${ROLE_FIELDS}
    }
  }
`;

export const TENANT_ROLE_QUERY = `
  query TenantRole($roleId: ID!) {
    tenantRole(roleId: $roleId) {
      ${ROLE_FIELDS}
    }
  }
`;

export const DEFAULT_TENANT_ROLE_QUERY = `
  query DefaultTenantRole {
    defaultTenantRole {
      ${ROLE_FIELDS}
    }
  }
`;

export const PERMISSION_CATEGORIES_QUERY = `
  query PermissionCategories {
    permissionCategories { categoryKey name resources { name actions } }
  }
`;

// ============================================================================
// Mutations
// ============================================================================

export const CREATE_TENANT_ROLE_MUTATION = `
  mutation CreateTenantRole($input: CreateTenantRoleInput!) {
    createTenantRole(input: $input) {
      ${ROLE_FIELDS}
    }
  }
`;

export const UPDATE_TENANT_ROLE_MUTATION = `
  mutation UpdateTenantRole($roleId: ID!, $input: UpdateTenantRoleInput!) {
    updateTenantRole(roleId: $roleId, input: $input) {
      ${ROLE_FIELDS}
    }
  }
`;

export const DELETE_TENANT_ROLE_MUTATION = `
  mutation DeleteTenantRole($roleId: ID!) {
    deleteTenantRole(roleId: $roleId)
  }
`;

export const SEED_TENANT_ROLES_MUTATION = `
  mutation SeedTenantRoles {
    seedTenantRoles {
      ${ROLE_FIELDS}
    }
  }
`;
