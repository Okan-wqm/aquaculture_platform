import { Request } from 'express';

/**
 * Type-safe interface for requests with JWT-authenticated user.
 * Use `getAuthUserId(req)` to safely extract the user ID.
 */
export interface AuthenticatedUser {
  id: string;
  email?: string;
  name?: string;
  roles?: string[];
}

/**
 * Safely extracts the authenticated user ID from a request.
 * Returns undefined if not authenticated.
 */
export function getAuthUserId(req: Request): string | undefined {
  return (req as unknown as { user?: AuthenticatedUser }).user?.id;
}

/**
 * Safely extracts the authenticated user email from a request.
 * Returns undefined if not authenticated.
 */
export function getAuthUserEmail(req: Request): string | undefined {
  return (req as unknown as { user?: AuthenticatedUser }).user?.email;
}

/**
 * Safely extracts the authenticated user name from a request.
 * Returns undefined if not available.
 */
export function getAuthUserName(req: Request): string | undefined {
  const user = (req as unknown as { user?: AuthenticatedUser }).user;
  return user?.name || user?.email;
}
