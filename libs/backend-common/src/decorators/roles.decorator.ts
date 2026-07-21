import { SetMetadata, applyDecorators } from '@nestjs/common';
import type { PlatformRoleCode } from '@platform/event-contracts';

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
 * Compile-time parity guard (APA-050) — pins the canonical `Role` enum to the
 * cross-service `PlatformRoleCode` union in `@platform/event-contracts/roles`.
 *
 * `${Role}` is the enum's string-VALUE union, so the check compares the wire
 * strings (not the nominal enum types). Both directions must hold: if a role is
 * added, removed, or renamed on EITHER side the corresponding `AssertTrue<...>`
 * receives `false` and `tsc --noEmit` fails. This is the tier-1 make-it-
 * impossible half of the role-vocabulary SSoT (the runtime/detectable halves
 * live in the DTO validators and tests/invariants/rbac-vocabulary-ssot.spec.ts).
 */
type AssertTrue<T extends true> = T;
export type RoleEnumSubsetOfContract = AssertTrue<
  `${Role}` extends PlatformRoleCode ? true : false
>;
export type RoleContractSubsetOfEnum = AssertTrue<
  PlatformRoleCode extends `${Role}` ? true : false
>;

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
 * ModuleUser or higher decorator — every authenticated platform role.
 *
 * WHY: self-scoped endpoints (a user reading their OWN modules/settings)
 * must be explicitly role-gated for defense-in-depth (ADR-008) instead of
 * relying on the bare JWT guard. This names the full role set so the
 * intent "any authenticated tenant member" is visible in metadata and
 * testable via ROLES_KEY reflection.
 */
export const ModuleUserOrHigher = () =>
  Roles(Role.SUPER_ADMIN, Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER);

/**
 * Skip tenant guard decorator - for endpoints that don't require tenant context
 */
export const SKIP_TENANT_GUARD_KEY = 'skipTenantGuard';
export const SkipTenantGuard = () => SetMetadata(SKIP_TENANT_GUARD_KEY, true);

/**
 * Public decorator - marks endpoint as publicly accessible.
 * Automatically skips both RolesGuard and TenantGuard, so developers
 * do not need to apply @SkipTenantGuard() separately for public endpoints.
 */
export const IS_PUBLIC_KEY = 'isPublic';
// applyDecorators is Nest's canonical combinator for exactly this
// shape — one decorator stamping multiple metadata keys on either a
// class or a method — and carries the MethodDecorator & ClassDecorator
// typing without any hand-rolled target/descriptor bridging.
export const Public = (): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(IS_PUBLIC_KEY, true),
    SetMetadata(SKIP_TENANT_GUARD_KEY, true),
  );

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
