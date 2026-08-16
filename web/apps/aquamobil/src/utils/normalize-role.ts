// ============================================================================
// Role normalization at the auth boundary — FE-MEDIUM-051
// ============================================================================
// WHY: the server's GraphQL `role` field arrives as an untyped string on the
// login/refresh JSON responses (useAuth.tsx issues those as inline fetches, not
// typed documents). With `User.role` now the canonical backend `Role` enum, the
// raw value must be VALIDATED — never `as`-cast — before it enters auth state,
// or a malformed/unknown role would masquerade as a valid one.
//
// WHAT: accepts the v1 platform vocabulary verbatim. The v0 AquaMobil
// vocabulary is registered centrally as retired and is rejected here, just
// like any unknown identity, to the least-privileged MODULE_USER role.

import { Role, isPlatformRole } from '@platform/identity';

/**
 * Normalize a server-provided role string to the canonical backend `Role`.
 * Fail-closed: anything outside platform-role/v1 resolves to MODULE_USER.
 */
export function normalizeRole(raw: string | null | undefined): Role {
  if (isPlatformRole(raw)) {
    return raw;
  }
  // Retired v0 AquaMobil roles and unknown values share the same boundary
  // policy: reject their identity and grant only the minimum v1 privilege.
  return Role.MODULE_USER;
}
