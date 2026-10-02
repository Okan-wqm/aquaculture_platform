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
