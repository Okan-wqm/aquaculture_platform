/**
 * RequirePlatformAdmin — SUPER_ADMIN gate of the guard family.
 *
 * The admin-panel face: the whole `/admin/*` remote is platform-scope. Unlike
 * the inline role check it replaces (which had no loading state and redirected
 * a still-loading super admin to /unauthorized), this gate waits for the
 * session check, sends unauthenticated visitors to /login, and denies
 * authenticated non-super-admins to /unauthorized.
 */

import React from 'react';
import { RequireRole } from './RequireRole';

export interface RequirePlatformAdminProps {
  children: React.ReactNode;
  /** Rendered while the session check is in flight (default: GuardLoading). */
  loadingFallback?: React.ReactNode;
}

/** Semantic alias: platform scope = SUPER_ADMIN (hierarchy-aware) or deny. */
export const RequirePlatformAdmin: React.FC<RequirePlatformAdminProps> = ({
  children,
  loadingFallback,
}) => (
  <RequireRole requiredRoles={['SUPER_ADMIN']} loadingFallback={loadingFallback}>
    {children}
  </RequireRole>
);
