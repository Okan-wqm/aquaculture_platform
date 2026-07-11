/**
 * Tenant-admin route guards.
 *
 * SEC-007 / MT-HIGH-060: defense-in-depth, module-level RBAC. The backend
 * (@RequireTenantPermission) is the real enforcement; these guards only decide
 * what a user can REACH in the SPA.
 *
 * Two layers:
 *  - RequireTenantAdmin — outer gate on the whole module: may this user ENTER the
 *    tenant panel at all? A global tenant admin, or a delegate holding any
 *    delegatable panel capability (hasTenantPanelAccess).
 *  - RequireTenantCapability — per-page gate: TENANT_ADMIN/SUPER_ADMIN bypass;
 *    a delegate needs the page's specific capability; admin-only pages accept
 *    only a global tenant admin (adminOnly).
 *
 * Both reuse the shared FE capability SSoT (hasResourcePermission /
 * hasTenantPanelAccess) so there is one implementation of the rule.
 */

import React from 'react';
import { Navigate } from 'react-router-dom';
import {
  useAuthContext,
  hasResourcePermission,
  hasTenantPanelAccess,
} from '@aquaculture/shared-ui';

const CheckingSession: React.FC = () => (
  <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
    Checking session...
  </div>
);

export const RequireTenantAdmin: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isAuthenticated, isLoading } = useAuthContext();

  if (isLoading) {
    return <CheckingSession />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Outer gate: a global tenant admin OR a delegate with any panel capability.
  // Fail-closed — a user with no panel capability is bounced before any page loads.
  if (!hasTenantPanelAccess(user)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
};

export const RequireTenantCapability: React.FC<{
  /** The tenant-RBAC capability (`resource:action`) a delegate needs for this page. */
  capability?: string;
  /** Page is admin-only: no delegated capability can substitute for a global admin. */
  adminOnly?: boolean;
  children: React.ReactNode;
}> = ({ capability, adminOnly, children }) => {
  const { user, hasRoleOrHigher, isAuthenticated, isLoading } = useAuthContext();

  if (isLoading) {
    return <CheckingSession />;
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
