import { SetMetadata } from '@nestjs/common';

import { Role } from './roles.decorator';

/**
 * Metadata key for required tenant permissions
 */
export const REQUIRED_TENANT_PERMISSIONS_KEY = 'requiredTenantPermissions';

/**
 * RequireTenantPermission Decorator
 *
 * Marks a route handler as requiring specific tenant-level resource permissions.
 * Used together with TenantPermissionGuard to enforce fine-grained RBAC.
 *
 * Permission format: "resource:action" (e.g., "tanks:create", "sensors:configure")
 *
 * Behaviour:
 * - Opt-in: If the decorator is not present, the guard passes through.
 * - SUPER_ADMIN and TENANT_ADMIN bypass permission checks (full access).
 * - MODULE_MANAGER and MODULE_USER must have every listed permission in their
 *   JWT `resourcePermissions` array.
 *
 * @example
 * ```ts
 * @RequireTenantPermission('tanks:create')
 * @Post()
 * createTank() { ... }
 *
 * @RequireTenantPermission('sensors:configure', 'sensors:calibrate')
 * @Patch(':id/calibrate')
 * calibrateSensor() { ... }
 * ```
 */
export const RequireTenantPermission = (...permissions: string[]) =>
  SetMetadata(REQUIRED_TENANT_PERMISSIONS_KEY, permissions);

/**
 * Minimal user shape a capability check needs — a subset of CurrentUserPayload
 * / the verified JWT claims.
 */
export interface ResourcePermissionUser {
  role?: string | Role | null;
  roles?: (string | Role)[] | null;
  resourcePermissions?: string[] | null;
}

const ROLE_VALUES: ReadonlySet<string> = new Set(Object.values(Role));

/** Normalize a user's role(s) to canonical `Role` values (uppercase, deduped). */
function normalizeRoles(user: ResourcePermissionUser): Role[] {
  const roles: Role[] = [];
  const add = (r: string | Role): void => {
    const upper = String(r).toUpperCase();
    if (ROLE_VALUES.has(upper) && !roles.includes(upper as Role)) {
      roles.push(upper as Role);
    }
  };
  if (Array.isArray(user.roles)) {
    user.roles.forEach(add);
  }
  if (user.role) {
    add(user.role);
  }
  return roles;
}

/**
 * SSoT for the tenant-RBAC capability check. Shared by `TenantPermissionGuard`
 * (route-level, via `@RequireTenantPermission`) AND any programmatic /
 * conditional check — e.g. a multi-branch mutation that must gate only ONE
 * branch (creating a GROUP channel) without blanket-guarding the whole handler.
 *
 * SUPER_ADMIN and TENANT_ADMIN bypass (full access); otherwise EVERY required
 * capability must be present in the user's `resourcePermissions`. Fail-closed on
 * a missing user. Mirrors the frontend `useAuth().hasPermission` exactly so the
 * UI-visibility and the server-enforcement verdicts agree.
 */
export function hasAllResourcePermissions(
  user: ResourcePermissionUser | null | undefined,
  requiredPermissions: readonly string[],
): boolean {
  if (!user) {
    return false;
  }
  const roles = normalizeRoles(user);
  if (roles.includes(Role.SUPER_ADMIN) || roles.includes(Role.TENANT_ADMIN)) {
    return true;
  }
  const granted = user.resourcePermissions ?? [];
  return requiredPermissions.every((permission) => granted.includes(permission));
}

/** Single-capability convenience over {@link hasAllResourcePermissions}. */
export function hasResourcePermission(
  user: ResourcePermissionUser | null | undefined,
  requiredPermission: string,
): boolean {
  return hasAllResourcePermissions(user, [requiredPermission]);
}
