import { Request } from 'express';

/**
 * Type-safe interface for requests with JWT-authenticated user.
 * Use `getAuthUserId(req)` to safely extract the user ID.
 */
export interface AuthenticatedUser {
  id: string;
  sub?: string;
  email?: string;
  name?: string;
  roles?: string[];
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
