// ============================================================================
// Role-rank SSoT — SEC-MEDIUM-050
// ============================================================================
// WHY: the mobile UI must gate role-floored operations (e.g. harvest, which the
// backend restricts to @Roles(TENANT_ADMIN, MODULE_MANAGER)) with the SAME
// ordering the backend ROLE_HIERARCHY uses, so the client never shows a CTA the
// server will 403 after the success screen. A feature flag proves entitlement;
// a role floor proves privilege — orthogonal gates, and BOTH must hold.
//
// WHAT: a single rank function over the codegen'd backend `Role` enum
// (the FE-MEDIUM-051 SSoT). `meetsRoleFloor(userRole, floor)` is the one helper
// every role-floored route/CTA composes on — no duplicated rank vocabulary, no
// parallel string comparison. The numeric ranks mirror backend ROLE_HIERARCHY
// (SUPER_ADMIN > TENANT_ADMIN > MODULE_MANAGER > MODULE_USER); a role-rank
// parity unit test asserts they stay in lock-step with the backend.

import type { Role } from '../generated/graphql';

// WHY a Record<Role, number> keyed by the generated enum: if the backend Role
// enum ever gains/renames a value, codegen regenerates `Role` and this Record
// becomes a TS exhaustiveness error at compile time (tier-3 detectable) rather
// than silently mis-ranking an unknown role.
const ROLE_RANK: Record<Role, number> = {
  SUPER_ADMIN: 4,
  TENANT_ADMIN: 3,
  MODULE_MANAGER: 2,
  MODULE_USER: 1,
};

/**
 * Numeric privilege rank of a role. Higher === more privileged. Mirrors the
 * backend ROLE_HIERARCHY ordering so client and server agree on "or higher".
 */
export function roleRank(role: Role): number {
  return ROLE_RANK[role];
}

/**
 * True when `userRole` is at least as privileged as `floor` (the "floor-or-
 * higher" check). FAIL-CLOSED by construction: a role strictly below the floor
 * returns false, so a MODULE_USER never clears a MODULE_MANAGER floor.
 */
export function meetsRoleFloor(userRole: Role, floor: Role): boolean {
  return roleRank(userRole) >= roleRank(floor);
}
