import { JwtUser } from '@aquaculture/backend-common/types';
import { UnauthorizedException } from '@nestjs/common';
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
 * The authenticated operator's id, or a 401 — for writes that ATTRIBUTE.
 *
 * The `getAuthUser*` readers above return `undefined` for an unauthenticated
 * request, which is right for an optional read and wrong for an audit record:
 * a caller that has to decide what to do with `undefined` will eventually
 * decide to substitute something. It did — `createdBy: 'admin', // Would come
 * from auth context` stamped a fictitious operator onto retention policies and
 * security-incident timelines, so the audit trail attributed a real person's
 * action to a name no account has (ADMIN-HIGH-097).
 *
 * These two return the identity or refuse, so the substituting branch has
 * nowhere to live. Every route reaching them already sits behind the
 * SUPER_ADMIN guard, so the throw is a contract assertion rather than an
 * expected path.
 */
export function requireAuthUserId(req: Request): string {
  const id = getAuthUserId(req);
  if (!id) {
    throw new UnauthorizedException(
      'Request reached an attributed write without an authenticated user',
    );
  }
  return id;
}

/** Display name for an attributed write, falling back to email and then to the id. */
export function requireAuthUserName(req: Request): string {
  return getAuthUserName(req) ?? requireAuthUserId(req);
}
