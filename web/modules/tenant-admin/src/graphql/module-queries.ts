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
      managerId
    }
  }
`;

/** Lightweight query for module UUIDs only (BUG-019) */
export const MY_MODULES_ID_QUERY = `
  query MyModulesWithIds {
    myModules {
      id
      code
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
      managerId
    }
  }
`;

export const REMOVE_MODULE_MANAGER_MUTATION = `
  mutation RemoveModuleManager($moduleId: ID!) {
    removeModuleManager(moduleId: $moduleId) {
      id
      moduleId
      managerId
    }
  }
`;
