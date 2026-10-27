/**
 * GraphQL queries and mutations for tenant module management.
 */

// ============================================================================
// Queries
// ============================================================================

/** Full module info for dashboard display */
export const MY_MODULES_QUERY = `
  query MyModules {
    myModules {
      id
      moduleId
      code
      name
      description
      icon
      color
      isEnabled
      defaultRoute
    }
  }
`;

/**
 * Tenant's assigned modules (pivot rows).
 *
 * TenantModule exposes only the scalar pivot columns — there is no nested
 * `module` object field on the type (the auth-service entity relation carries no
 * @Field, and no module field-resolver exists). Module catalog details
 * (code/name/icon/etc.) are fetched separately via MY_MODULES_QUERY (`myModules`
 * → UserModuleInfo). Note `category` exists on neither type.
 *
 * No document selects `managerId` (PKG-06; ADR-051 §5): it is the designation copy no token
 * reads, which PKG-06 PR2 removes in R4, and the console never showed it.
 */
export const MY_TENANT_MODULES_QUERY = `
  query MyTenantModules {
    myTenantModules {
      id
      moduleId
      isEnabled
      configuration
      activatedAt
      expiresAt
    }
  }
`;

/** Lightweight query for each assigned module's UUID (BUG-019) and icon name */
export const MY_MODULE_REFS_QUERY = `
  query MyModuleRefs {
    myModules {
      id
      code
      icon
    }
  }
`;

/** Module usage statistics */
export const MODULE_USAGE_STATS_QUERY = `
  query ModuleUsageStats {
    moduleUsageStats {
      moduleCode
      userCount
      lastAccessAt
      actionsThisMonth
      actionsLastMonth
    }
  }
`;

// ============================================================================
// Mutations
// ============================================================================

export const ASSIGN_MODULE_MANAGER_MUTATION = `
  mutation AssignModuleManager($input: AssignModuleManagerInput!) {
    assignModuleManager(input: $input) {
      id
      moduleId
    }
  }
`;

export const REMOVE_MODULE_MANAGER_MUTATION = `
  mutation RemoveModuleManager($moduleId: ID!) {
    removeModuleManager(moduleId: $moduleId) {
      id
      moduleId
    }
  }
`;
