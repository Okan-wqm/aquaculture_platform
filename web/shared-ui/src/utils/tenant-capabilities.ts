/**
 * Tenant-RBAC capability checks (frontend).
 *
 * One place for "does this user hold capability X" and "may this user enter the
 * tenant-admin panel". The rule — an account role (SUPER_ADMIN, TENANT_ADMIN)
 * holds every capability, their tokens carry no resourcePermissions; every other
 * user holds exactly the `resourcePermissions` claim decoded from their access
 * token — is `holdsTenantCapabilities` in `@aquaculture/shared-contracts`, the
 * same function the backend `hasAllResourcePermissions` reads (RBAC-MEDIUM-024),
 * so the two verdicts cannot disagree.
 *
 * FE gating drives VISIBILITY + reachability only — the backend
 * (@RequireTenantPermission, MT-HIGH-060) enforces every action independently.
 * Both useAuth().hasPermission and the shell/module route guards import these
 * functions so the FE has exactly one capability-check implementation.
 */
import {
  accountRoleOf,
  holdsTenantCapabilities,
  type TenantCapability,
  type TenantCapabilityHolder,
} from '@aquaculture/shared-contracts';

/** Minimal user shape this module needs (a subset of AuthUser / the JWT claims). */
export interface CapabilityUser {
  role?: string | null;
  resourcePermissions?: string[];
}

/** The capability holder a session user is: its account role and its claim. */
function holderOf(user: CapabilityUser): TenantCapabilityHolder {
  return {
    accountRole: accountRoleOf(user.role ? [user.role] : []),
    capabilities: user.resourcePermissions ?? [],
  };
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
  return holdsTenantCapabilities(holderOf(user), [permission]);
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
] as const satisfies readonly TenantCapability[];

/**
 * True if the user may enter the tenant-admin panel (`/tenant/*`): a global
 * tenant admin (or super admin), or a delegate holding any delegatable panel
 * capability. Fail-closed otherwise.
 */
export function hasTenantPanelAccess(user: CapabilityUser | null | undefined): boolean {
  if (!user) return false;
  const holder = holderOf(user);
  return TENANT_PANEL_CAPABILITIES.some((capability) =>
    holdsTenantCapabilities(holder, [capability]),
  );
}
