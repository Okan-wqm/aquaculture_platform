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

// PKG-06: Assign / Remove Manager name the module by its code and write the module's primary
// manager grant; no document reads tenant_modules.managerId, which PKG-06 PR2 unmaps (ADR-051 §5).
export const ASSIGN_MODULE_MANAGER_MUTATION = `
  mutation AssignModuleManager($input: AssignModuleManagerInput!) {
    assignModuleManager(input: $input) {
      id
      moduleId
    }
  }
`;

export const REMOVE_MODULE_MANAGER_MUTATION = `
  mutation RemoveModuleManager($moduleCode: String!) {
    removeModuleManager(moduleCode: $moduleCode) {
      id
      moduleId
    }
  }
`;

/** Each owner module's designated managers who hold its manager grant (PKG-06). */
export const MODULE_PRIMARY_MANAGERS_QUERY = `
  query ModulePrimaryManagers {
    modulePrimaryManagers {
      moduleCode
      userId
    }
  }
`;

/** A member's module roles as their next token carries them (PKG-06). */
export const USER_MODULE_ACCESS_QUERY = `
  query UserModuleAccess($userId: ID!) {
    userModuleAccess(userId: $userId) {
      userId
      moduleAccess {
        farm
        hr
        sensor
        hydroponics
      }
    }
  }
`;

/** Replaces a member's module roles as a whole (PKG-06, setUserModuleAccess). */
export const SET_USER_MODULE_ACCESS_MUTATION = `
  mutation SetUserModuleAccess($input: SetUserModuleAccessInput!) {
    setUserModuleAccess(input: $input) {
      userId
      moduleAccess {
        farm
        hr
        sensor
        hydroponics
      }
    }
  }
`;
