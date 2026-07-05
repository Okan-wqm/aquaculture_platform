/**
 * Read-only JWT claim helpers for the mobile PWA.
 *
 * The mobile app is standalone (its own auth lifecycle, separate from the panel
 * shared-ui), so it decodes the claims it needs at its own trust boundary. These
 * NEVER verify the signature — that is the server's job. They are used only for
 * UI visibility (show/hide granted actions); every action is independently
 * enforced by the backend.
 */

/**
 * Decode the tenant-RBAC `resourcePermissions` claim (an array of
 * `resource:action` capability strings) from an access token. Strictly
 * fail-closed: a missing / malformed / wrong-typed claim yields [] so the UI
 * never surfaces an action off a garbage token. The claim is omitted from the
 * token when empty (and for admins, who bypass the tenant permission guard).
 */
export function decodeResourcePermissions(token: string | null | undefined): string[] {
  if (!token) return [];
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return [];

    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(padded)) as { resourcePermissions?: unknown };

    if (
      Array.isArray(parsed.resourcePermissions) &&
      parsed.resourcePermissions.every((p): p is string => typeof p === 'string')
    ) {
      // The type predicate narrows the array to string[] here, so no cast.
      return parsed.resourcePermissions;
    }
    return [];
  } catch {
    return [];
  }
}
