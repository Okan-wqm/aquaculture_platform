import { platformRoleSatisfies, type PlatformRole } from '@aquaculture/shared-contracts';
import { SetMetadata, applyDecorators } from '@nestjs/common';

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
 * Every role the platform defines, as a value list.
 *
 * `Role` is the vocabulary; this is the same vocabulary in the shape a
 * `class-validator` `@IsEnum(...)` and a UI option list can consume, so neither
 * has to retype it. `Object.values(Role)` rather than a second literal for the
 * reason this constant exists at all: three hand-typed copies of this list —
 * in `users.dto.ts`, in the role-template catalogue, and in the admin-panel's
 * invite form — had each drifted to a DIFFERENT wrong set, naming `MANAGER`,
 * `OPERATOR` and `VIEWER`, none of which is a `Role`, while rejecting
 * `MODULE_MANAGER` and `MODULE_USER`, which are (ADMIN-CRITICAL-133).
 */
export const PLATFORM_ROLES: readonly Role[] = Object.values(Role);

/**
 * The roles an invitation may grant: every platform role except the platform
 * administrator, which is never handed out by invitation.
 *
 * Derived, not retyped — a role added to `Role` is invitable by default and a
 * role removed from it disappears here, so the two cannot disagree.
 */
export const INVITABLE_ROLES: readonly Role[] = PLATFORM_ROLES.filter(
  (role) => role !== Role.SUPER_ADMIN,
);

/**
 * Compile-time parity with the one owner of the platform roles (RBAC-MEDIUM-024): `Role` spells
 * exactly `PlatformRole` (`@aquaculture/shared-contracts`, access/platform-roles.ts), checked in
 * both directions. A role added to one and not the other makes this constant's type `false` and
 * fails the build; `tests/invariants/role-hierarchy-single-owner.spec.ts` checks the same at run
 * time.
 */
type RoleSpellsPlatformRoles = [`${Role}`] extends [PlatformRole]
  ? [PlatformRole] extends [`${Role}`]
    ? true
    : false
  : false;
const ROLE_SPELLS_PLATFORM_ROLES: RoleSpellsPlatformRoles = true;
void ROLE_SPELLS_PLATFORM_ROLES;

/**
 * Check if a role has permission of another role (hierarchy check).
 *
 * The hierarchy is the owner's (`PLATFORM_ROLES_BY_PRIVILEGE`): this module keeps no copy. A
 * higher role inherits every lower one, across account and module roles alike — the check of the
 * services not yet enrolled in ADR-051 (`account-role`); `decideAccess` applies it by kind.
 */
export function roleHasPermission(userRole: Role, requiredRole: Role): boolean {
  return platformRoleSatisfies(userRole, requiredRole);
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
