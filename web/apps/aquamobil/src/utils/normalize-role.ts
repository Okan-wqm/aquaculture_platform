// ============================================================================
// Role normalization at the auth boundary — FE-MEDIUM-051
// ============================================================================
// WHY: the server's GraphQL `role` field arrives as an untyped string on the
// login/refresh JSON responses (useAuth.tsx issues those as inline fetches, not
// typed documents). With `User.role` now the canonical backend `Role` enum, the
// raw value must be VALIDATED — never `as`-cast — before it enters auth state,
// or a malformed/unknown role would masquerade as a valid one.
//
// WHAT: maps the historical pre-canonical role names that may still exist on
// legacy tokens (MANAGER -> MODULE_MANAGER, OPERATOR/VIEWER -> MODULE_USER) as a
// one-time boundary mapping (NOT a permanent compat shim — the backend emits
// only the 4 canonical roles), accepts the 4 canonical roles verbatim, and
// FAILS CLOSED on anything unrecognized by returning the least-privileged
// MODULE_USER so an unknown role can never inherit elevated access.

import type { Role } from '../generated/graphql';

const CANONICAL_ROLES: readonly Role[] = [
  'SUPER_ADMIN',
  'TENANT_ADMIN',
  'MODULE_MANAGER',
  'MODULE_USER',
];

// WHY a type-predicate (not an `as Role` cast): the project bans `as` casting.
// `.includes` over the canonical list narrows the raw string to `Role` through
// the compiler, so the guarded branch returns a real `Role` with no cast.
function isCanonicalRole(raw: string): raw is Role {
  return (CANONICAL_ROLES as readonly string[]).includes(raw);
}

// Legacy -> canonical boundary mapping. Only consulted when the raw value is not
// already canonical; it exists solely to absorb tokens minted before the role
// vocabulary converged, and carries no permanent meaning.
const LEGACY_ROLE_MAP: Readonly<Record<string, Role>> = {
  MANAGER: 'MODULE_MANAGER',
  OPERATOR: 'MODULE_USER',
  VIEWER: 'MODULE_USER',
};

/**
 * Normalize a server-provided role string to the canonical backend `Role`.
 * Fail-closed: anything not canonical and not a known legacy alias resolves to
 * the least-privileged MODULE_USER.
 */
export function normalizeRole(raw: string | null | undefined): Role {
  if (raw && isCanonicalRole(raw)) {
    return raw;
  }
  if (raw && raw in LEGACY_ROLE_MAP) {
    return LEGACY_ROLE_MAP[raw];
  }
  // FAIL-CLOSED: unknown/missing role gets the minimum privilege, never elevated.
  return 'MODULE_USER';
}
