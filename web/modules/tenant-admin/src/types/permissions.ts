/**
 * Permission Types
 *
 * Shared type definitions for permission management across the tenant admin module.
 * These types provide type safety for permission categories, actions, and structures.
 */

// ============================================================================
// Permission Action Types
// ============================================================================

/**
 * Standard CRUD actions for resources
 */
export type PermissionAction = 'create' | 'read' | 'update' | 'delete' | 'manage' | 'export' | 'import';

/**
 * Action permission map for a resource
 */
export type ActionPermissionMap = Record<string, boolean>;

/**
 * Resource permission map (resource name -> action permissions)
 */
export type ResourcePermissionMap = Record<string, ActionPermissionMap>;

/**
 * Category permission map (category key -> resource permissions)
 */
export type CategoryPermissionMap = Record<string, ResourcePermissionMap>;

// ============================================================================
// Panel Permissions Structure
// ============================================================================

/**
 * Panel permissions structure
 * Represents a three-level nested map: Category -> Resource -> Action -> Boolean
 *
 * Example:
 * {
 *   "farm": {
 *     "tanks": {
 *       "create": true,
 *       "read": true,
 *       "update": false,
 *       "delete": false
 *     }
 *   }
 * }
 */
export type PanelPermissions = CategoryPermissionMap;

// ============================================================================
// Permission Category Definitions
// ============================================================================

/**
 * Permission resource definition
 */
export interface PermissionResource {
  /** Resource name (e.g., 'tanks', 'sensors') */
  name: string;
  /** Available actions for this resource */
  actions: string[];
}

/**
 * Permission category definition
 */
export interface PermissionCategory {
  /** Unique category key (e.g., 'farm', 'production') */
  categoryKey: string;
  /** Display name for the category */
  name: string;
  /** Resources within this category */
  resources: PermissionResource[];
}

// ============================================================================
// Permission Selection State
// ============================================================================

/**
 * Selection state for permission UI components
 */
export interface PermissionSelectionState {
  /** Whether all permissions are selected */
  allSelected: boolean;
  /** Whether some (but not all) permissions are selected */
  someSelected: boolean;
  /** Total number of permissions */
  totalCount: number;
  /** Number of selected permissions */
  selectedCount: number;
}

// ============================================================================
// Permission Change Events
// ============================================================================

/**
 * Event data for individual permission change
 */
export interface PermissionChangeEvent {
  categoryKey: string;
  resourceName: string;
  action: string;
  checked: boolean;
}

/**
 * Event data for bulk permission selection
 */
export interface BulkPermissionChangeEvent {
  categoryKey?: string;
  resourceName?: string;
  selected: boolean;
}

// ============================================================================
// Tenant Role Permission Types
// ============================================================================

/**
 * Role permissions structure
 */
export interface TenantRolePermissions {
  id: string;
  roleId: string;
  panelPermissions: PanelPermissions;
  resourcePermissions: string[];
}

// ============================================================================
// Permission Validation Types
// ============================================================================

/**
 * Validation result for permission checks
 */
export interface PermissionValidationResult {
  isValid: boolean;
  errors: PermissionValidationError[];
}

/**
 * Permission validation error
 */
export interface PermissionValidationError {
  categoryKey?: string;
  resourceName?: string;
  action?: string;
  message: string;
}

// ============================================================================
// Permission Checkbox Component Types
// ============================================================================

/**
 * Props for permission checkbox handler
 */
export interface PermissionCheckboxHandlers {
  /** Handle single permission change */
  onPermissionChange: (
    categoryKey: string,
    resourceName: string,
    action: string,
    checked: boolean
  ) => void;
  /** Handle select all for a resource */
  onSelectAllResource: (
    categoryKey: string,
    resourceName: string,
    actions: string[],
    selected: boolean
  ) => void;
  /** Handle select all for a category */
  onSelectAllCategory: (category: PermissionCategory, selected: boolean) => void;
  /** Handle global select all */
  onSelectAll: (selected: boolean) => void;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if value is a valid PanelPermissions object
 */
export function isPanelPermissions(value: unknown): value is PanelPermissions {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  for (const categoryKey in value as Record<string, unknown>) {
    const category = (value as Record<string, unknown>)[categoryKey];
    if (typeof category !== 'object' || category === null) {
      return false;
    }

    for (const resourceKey in category as Record<string, unknown>) {
      const resource = (category as Record<string, unknown>)[resourceKey];
      if (typeof resource !== 'object' || resource === null) {
        return false;
      }

      for (const actionKey in resource as Record<string, unknown>) {
        const action = (resource as Record<string, unknown>)[actionKey];
        if (typeof action !== 'boolean') {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Type guard to check if value is a valid PermissionCategory
 */
export function isPermissionCategory(value: unknown): value is PermissionCategory {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  return (
    typeof obj.categoryKey === 'string' &&
    typeof obj.name === 'string' &&
    Array.isArray(obj.resources) &&
    obj.resources.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as Record<string, unknown>).name === 'string' &&
        Array.isArray((r as Record<string, unknown>).actions)
    )
  );
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Extract action names from a PermissionCategory
 */
export type ExtractActions<T extends PermissionCategory> =
  T['resources'][number]['actions'][number];

/**
 * Create a permission path string
 */
export type PermissionPath = `${string}.${string}.${string}`;

/**
 * Parse a permission path
 */
export function parsePermissionPath(path: PermissionPath): {
  categoryKey: string;
  resourceName: string;
  action: string;
} {
  const [categoryKey, resourceName, action] = path.split('.');
  return { categoryKey, resourceName, action };
}

/**
 * Create a permission path from components
 */
export function createPermissionPath(
  categoryKey: string,
  resourceName: string,
  action: string
): PermissionPath {
  return `${categoryKey}.${resourceName}.${action}` as PermissionPath;
}
