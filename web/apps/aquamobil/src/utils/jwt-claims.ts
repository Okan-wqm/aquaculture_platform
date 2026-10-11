/**
 * Read-only JWT claim helpers for the mobile PWA.
 *
 * The mobile app is standalone (its own auth lifecycle, separate from the panel
 * shared-ui), so it decodes the claims it needs at its own trust boundary. These
 * NEVER verify the signature — that is the server's job. They are used for UI
 * visibility (show/hide granted actions) and to label requests with the tenant
 * the server itself signed into the token; every action is independently
 * enforced by the backend.
 */

/**
 * Decode an access token's payload segment into its claim object. Strictly
 * fail-closed: an absent token, a token that is not three segments, a payload
 * that is not base64url JSON, or a payload that is not an object yields null.
 */
function decodeClaims(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(atob(base64));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    // A non-null, non-array object: every own key is a claim name.
    return Object.fromEntries(Object.entries(parsed));
  } catch {
    return null;
  }
}

/**
 * Decode the tenant-RBAC `resourcePermissions` claim (an array of
 * `resource:action` capability strings) from an access token. Strictly
 * fail-closed: a missing / malformed / wrong-typed claim yields [] so the UI
 * never surfaces an action off a garbage token. The claim is omitted from the
 * token when empty (and for admins, who bypass the tenant permission guard).
 */
export function decodeResourcePermissions(token: string | null | undefined): string[] {
  const claim = decodeClaims(token)?.resourcePermissions;
  if (Array.isArray(claim) && claim.every((p): p is string => typeof p === 'string')) {
    // The type predicate narrows the array to string[] here, so no cast.
    return claim;
  }
  return [];
}

/**
 * Decode the `tenantId` claim from an access token: the tenant the auth service
 * signed this session into. Fail-closed: a missing, empty or non-string claim
 * yields null, so no tenant header is sent rather than a guessed one.
 */
export function decodeTenantId(token: string | null | undefined): string | null {
  const claim = decodeClaims(token)?.tenantId;
  return typeof claim === 'string' && claim.length > 0 ? claim : null;
}

/**
 * The identity subset needed to rebuild the session `User` after a hard
 * navigation (page refresh / URL change) from the persisted access token
 * alone — before any server round-trip.
 *
 * WHAT the auth service actually signs (apps/auth-service token.service): `sub`
 * (user id) and `role` are always present and are the two claims this restore
 * FAILS CLOSED on; `email` is retained only as a deprecated optional claim
 * (H-08: tokens carry non-PII identifiers), and `tenantId` is null for
 * SUPER_ADMIN. The signature is NOT verified here — the server verifies it on
 * every request; this decode only rebuilds the UI-side identity the server
 * itself signed at login time.
 */
export interface JwtIdentityClaims {
  sub: string;
  email: string | null;
  role: string;
  tenantId: string | null;
}

/**
 * Decode the identity claims (`sub`/`email`/`role`/`tenantId`) from an access
 * token. Strictly fail-closed: a token that is not a decodable JWT, or whose
 * `sub`/`role` claims are missing or empty, yields null — a garbage token must
 * never restore an authenticated session.
 */
export function decodeIdentityClaims(token: string | null | undefined): JwtIdentityClaims | null {
  const claims = decodeClaims(token);
  if (!claims) return null;
  const sub = typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : null;
  const role = typeof claims.role === 'string' && claims.role.length > 0 ? claims.role : null;
  if (!sub || !role) return null;
  return {
    sub,
    email: typeof claims.email === 'string' && claims.email.length > 0 ? claims.email : null,
    role,
    tenantId: decodeTenantId(token),
  };
}

/**
 * The tenant a request is sent for — the ONE resolver every request lane uses
 * (foreground authenticatedFetch and the service worker's Background Sync
 * replay alike), so the two cannot disagree about which tenant a write lands in.
 *
 * WHY the token claim first: the access token is what the server signed and
 * what the gateway trusts. Any separately carried tenant id (the auth store
 * copy, an auth response's `user.tenantId`) is a copy that can lag the token or
 * arrive null while the token carries the claim (MOB-MEDIUM-024). The copy only
 * fills in for a token that carries no tenant claim; with neither, the result
 * is null and the caller sends no tenant rather than a guessed one.
 */
export function resolveRequestTenantId(
  accessToken: string | null | undefined,
  carriedTenantId: string | null | undefined,
): string | null {
  const claim = decodeTenantId(accessToken);
  if (claim !== null) return claim;
  return typeof carriedTenantId === 'string' && carriedTenantId.length > 0 ? carriedTenantId : null;
}
