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

/** Tenant's assigned modules with relationship details */
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
      module {
        id
        code
        name
        description
        icon
        category
        isActive
      }
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
