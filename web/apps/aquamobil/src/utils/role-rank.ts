// ============================================================================
// Role-rank SSoT — SEC-MEDIUM-050
// ============================================================================
// WHY: the mobile UI must gate role-floored operations (e.g. harvest, which the
// backend restricts to @Roles(TENANT_ADMIN, MODULE_MANAGER)) with the SAME
// ordering the backend ROLE_HIERARCHY uses, so the client never shows a CTA the
// server will 403 after the success screen. A feature flag proves entitlement;
// a role floor proves privilege — orthogonal gates, and BOTH must hold.
//
// WHAT: the GraphQL-generated role is translated through the canonical platform
// identity validator, then evaluated by the canonical hierarchy helpers.

import {
  PLATFORM_ROLE_DEFINITIONS,
  isPlatformRole,
  roleAtLeast,
  type Role,
} from '@platform/identity';

function platformRole(role: Role): Role {
  if (isPlatformRole(role)) return role;
  throw new Error(`GraphQL emitted an unknown platform role: ${role}`);
}

/**
 * Numeric privilege rank of a role. Higher === more privileged. Mirrors the
 * backend ROLE_HIERARCHY ordering so client and server agree on "or higher".
 */
export function roleRank(role: Role): number {
  return PLATFORM_ROLE_DEFINITIONS[platformRole(role)].level;
}

/**
 * True when `userRole` is at least as privileged as `floor` (the "floor-or-
 * higher" check). FAIL-CLOSED by construction: a role strictly below the floor
 * returns false, so a MODULE_USER never clears a MODULE_MANAGER floor.
 */
export function meetsRoleFloor(userRole: Role, floor: Role): boolean {
  return roleAtLeast(platformRole(userRole), platformRole(floor));
}
