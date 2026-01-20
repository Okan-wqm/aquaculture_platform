import { SetMetadata } from '@nestjs/common';

/**
 * Roles metadata key
 */
export const ROLES_KEY = 'roles';

/**
 * System Roles - Hierarchical role system
 *
 * SUPER_ADMIN: Full system access, manages all tenants
 * TENANT_ADMIN: Full tenant access, manages tenant users and modules
 * MODULE_MANAGER: Full module access within tenant, manages module users
 * MODULE_USER: Limited module access within tenant
 */
export enum Role {
  /**
   * System administrator - highest privilege
   * - Manages all tenants
   * - Creates tenant admins
   * - System-wide settings
   * - No tenant restriction
   */
  SUPER_ADMIN = 'SUPER_ADMIN',

  /**
   * Tenant administrator
   * - Manages single tenant
   * - Creates module managers/users
   * - Access to all tenant modules
   * - Tenant-level settings
   */
  TENANT_ADMIN = 'TENANT_ADMIN',

  /**
   * Module manager
   * - Manages single module within tenant
   * - Creates module users
   * - Full access to assigned module
   * - Module-level settings
   */
  MODULE_MANAGER = 'MODULE_MANAGER',

  /**
   * Module user
   * - Limited access to assigned module
   * - Read and basic write operations
   * - No user management
   */
  MODULE_USER = 'MODULE_USER',
}

/**
 * Role hierarchy for permission inheritance
 * Higher roles inherit permissions from lower roles
 */
export const ROLE_HIERARCHY: Record<Role, Role[]> = {
  [Role.SUPER_ADMIN]: [Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER],
  [Role.TENANT_ADMIN]: [Role.MODULE_MANAGER, Role.MODULE_USER],
  [Role.MODULE_MANAGER]: [Role.MODULE_USER],
  [Role.MODULE_USER]: [],
};

/**
 * Check if a role has permission of another role (hierarchy check)
 */
export function roleHasPermission(userRole: Role, requiredRole: Role): boolean {
  if (userRole === requiredRole) return true;
  return ROLE_HIERARCHY[userRole]?.includes(requiredRole) ?? false;
}

/**
 * Check if user role satisfies any of required roles
 */
export function hasAnyRole(userRole: Role, requiredRoles: Role[]): boolean {
  return requiredRoles.some(required => roleHasPermission(userRole, required));
}

/**
 * Roles decorator
 * Defines required roles for a route/resolver
 * @param roles Required roles (user must have at least one)
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * SuperAdmin only decorator - shortcut for super admin routes
 */
export const SuperAdminOnly = () => Roles(Role.SUPER_ADMIN);

/**
 * TenantAdmin or higher decorator
 */
export const TenantAdminOrHigher = () => Roles(Role.SUPER_ADMIN, Role.TENANT_ADMIN);

/**
 * ModuleManager or higher decorator
 */
export const ModuleManagerOrHigher = () => Roles(Role.SUPER_ADMIN, Role.TENANT_ADMIN, Role.MODULE_MANAGER);

/**
 * Public decorator - marks endpoint as publicly accessible
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Skip tenant guard decorator - for endpoints that don't require tenant context
 */
export const SKIP_TENANT_GUARD_KEY = 'skipTenantGuard';
export const SkipTenantGuard = () => SetMetadata(SKIP_TENANT_GUARD_KEY, true);

/**
 * Check if metadata indicates public access
 */
export function isPublicMetadata(metadata: Record<string, unknown>): boolean {
  return metadata[IS_PUBLIC_KEY] === true;
}

/**
 * Check if metadata indicates tenant guard should be skipped
 */
export function shouldSkipTenantGuard(metadata: Record<string, unknown>): boolean {
  return metadata[SKIP_TENANT_GUARD_KEY] === true;
}
