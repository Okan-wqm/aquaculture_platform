import { JwtUser } from '@aquaculture/backend-common/types';
import { Request } from 'express';

/**
 * admin-api authenticated user.
 *
 * Extends the platform-canonical {@link JwtUser} (identity = REQUIRED `sub`,
 * plus tenantId/roles/email/…) with admin-api-local conveniences. Extending the
 * SSoT — rather than re-declaring a looser local shape — makes `sub` compiler-
 * required, so an auth guard that forgets to set it fails type-check instead of
 * being silently treated as anonymous by the shared ThrottlerGuard
 * (ORPHAN-145/146). `id` is admin-api's local alias for the same subject; every
 * controller reads `req.user.id`.
 */
export interface AuthenticatedUser extends JwtUser {
  /** admin-api-local alias for the JWT subject (`sub`). */
  id: string;
  /** Canonical effective authorization roles established by PlatformAdminGuard. */
  roles: string[];
  /** Verified JWT identifier required by the revocation fence. */
  jti: string;
  /** Verified JWT issued-at epoch seconds used by revocation and step-up age. */
  iat: number;
  /** Normalized MFA claim; false when the verified token did not assert MFA. */
  mfaVerified: boolean;
  /** display name (falls back to email). */
  name?: string;
}

/**
 * Express Request extended with JWT-decoded user payload.
 * NestJS guards (JwtAuthGuard, etc.) attach `req.user` after token validation.
 */
export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Safely extracts the authenticated user from a request.
 * Returns undefined if not authenticated.
 */
export function getAuthUser(req: Request): AuthenticatedUser | undefined {
  return (req as AuthenticatedRequest).user;
}

/**
 * Safely extracts the authenticated user ID from a request.
 * Returns undefined if not authenticated.
 */
export function getAuthUserId(req: Request): string | undefined {
  return (req as AuthenticatedRequest).user?.id;
}

/**
 * Safely extracts the authenticated user email from a request.
 * Returns undefined if not authenticated.
 */
export function getAuthUserEmail(req: Request): string | undefined {
  return (req as AuthenticatedRequest).user?.email;
}

/**
 * Safely extracts the authenticated user name from a request.
 * Returns undefined if not available.
 */
export function getAuthUserName(req: Request): string | undefined {
  const user = (req as AuthenticatedRequest).user;
  return user?.name || user?.email;
}

/**
 * Stable, non-null label for audit/display fields that historically assumed
 * every JWT carried email PII. Identity remains `id`; this label prefers
 * optional presentation claims and falls back to that verified identifier.
 */
export function authenticatedActorLabel(user: AuthenticatedUser): string {
  return user.name ?? user.email ?? user.id;
}
