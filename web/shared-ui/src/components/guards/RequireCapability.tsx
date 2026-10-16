/**
 * RequireCapability — per-page gate of the tenant-admin double gate.
 *
 * "Given the user is INSIDE the panel, may they open THIS page?"
 * - TENANT_ADMIN / SUPER_ADMIN (hierarchy-aware `hasRoleOrHigher`) bypass.
 * - A delegate needs the page's specific tenant-RBAC capability
 *   (`resource:action`, checked via `hasResourcePermission`).
 * - `adminOnly` pages (billing, database, audit, …) accept no delegated
 *   capability — only a global tenant admin.
 * - A misconfigured guard (no capability, not adminOnly) denies delegates —
 *   fail-closed.
 *
 * SEC-007 / MT-HIGH-060: the backend enforces every action independently;
 * this gate only decides SPA reachability.
 */

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthContext } from '../../contexts/AuthContext';
import { hasResourcePermission } from '../../utils/tenant-capabilities';
import { GuardLoading } from './GuardLoading';

export interface RequireCapabilityProps {
  children: React.ReactNode;
  /** The tenant-RBAC capability (`resource:action`) a delegate needs for this page. */
  capability?: string;
  /** Page is admin-only: no delegated capability can substitute for a global admin. */
  adminOnly?: boolean;
  /** Rendered while the session check is in flight (default: GuardLoading). */
  loadingFallback?: React.ReactNode;
}

export const RequireCapability: React.FC<RequireCapabilityProps> = ({
  children,
  capability,
  adminOnly,
  loadingFallback,
}) => {
  const { user, isAuthenticated, isLoading, hasRoleOrHigher } = useAuthContext();

  if (isLoading) {
    return <>{loadingFallback ?? <GuardLoading />}</>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Global tenant admin (or super admin via hierarchy) always passes.
  if (hasRoleOrHigher('TENANT_ADMIN')) {
    return <>{children}</>;
  }

  // Admin-only page, or a misconfigured guard with no capability: deny delegates.
  if (adminOnly || !capability) {
    return <Navigate to="/unauthorized" replace />;
  }

  // Delegate: require this page's specific capability.
  if (hasResourcePermission(user, capability)) {
    return <>{children}</>;
  }

  return <Navigate to="/unauthorized" replace />;
};
