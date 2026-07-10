/**
 * Tenant-RBAC capability SSoT (frontend).
 *
 * One place for "does this user hold capability X" and "may this user enter the
 * tenant-admin panel". Mirrors the backend TenantPermissionGuard /
 * hasAllResourcePermissions semantics: SUPER_ADMIN and TENANT_ADMIN BYPASS (full
 * access, their tokens carry no resourcePermissions); every other user is checked
 * against the `resourcePermissions` claim decoded from their access token.
 *
 * FE gating drives VISIBILITY + reachability only — the backend
 * (@RequireTenantPermission, MT-HIGH-060) enforces every action independently.
 * Both useAuth().hasPermission and the shell/module route guards import these
 * functions so the FE has exactly one capability-check implementation.
 */

/** Minimal user shape this module needs (a subset of AuthUser / the JWT claims). */
export interface CapabilityUser {
  role?: string | null;
  resourcePermissions?: string[];
}

function isTenantAdminRole(role: string | null | undefined): boolean {
  return role === 'SUPER_ADMIN' || role === 'TENANT_ADMIN';
}

/**
 * True if the user holds `permission` (a `resource:action` string). Admins bypass.
 * Fail-closed: an ungranted, non-admin user returns false.
 */
export function hasResourcePermission(
  user: CapabilityUser | null | undefined,
  permission: string,
): boolean {
  if (!user) return false;
  if (isTenantAdminRole(user.role)) return true;
  return user.resourcePermissions?.includes(permission) ?? false;
}

/**
 * Delegatable tenant-admin capabilities that grant ENTRY to the /tenant panel.
 * A tenant user whose custom role carries any of these can reach the panel; once
 * inside, each page is additionally gated by its own specific capability, and
 * admin-only pages (billing, database, audit, modules, …) still require a global
 * tenant admin.
 */
export const TENANT_PANEL_CAPABILITIES = [
  'users:view',
  'roles:view',
  'settings:view',
] as const;

/**
 * True if the user may enter the tenant-admin panel (`/tenant/*`): a global
 * tenant admin (or super admin), or a delegate holding any delegatable panel
 * capability. Fail-closed otherwise.
 */
export function hasTenantPanelAccess(user: CapabilityUser | null | undefined): boolean {
  if (!user) return false;
  if (isTenantAdminRole(user.role)) return true;
  return TENANT_PANEL_CAPABILITIES.some(
    (cap) => user.resourcePermissions?.includes(cap) ?? false,
  );
}
