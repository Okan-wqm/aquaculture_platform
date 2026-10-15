/**
 * RequireTenantPanel — outer gate of the tenant-admin double gate.
 *
 * "May this user ENTER the tenant panel at all?" — a global tenant admin
 * (TENANT_ADMIN, or SUPER_ADMIN via the panel-access SSoT), or a delegate
 * holding any delegatable panel capability. The rule itself lives in
 * `hasTenantPanelAccess` (utils/tenant-capabilities, mirrored by the shell's
 * /tenant route guard) so there is exactly one implementation of panel entry.
 *
 * SEC-007 / MT-HIGH-060: defense-in-depth — the backend
 * (@RequireTenantPermission) enforces every action independently; this gate
 * only decides SPA reachability.
 */

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthContext } from '../../contexts/AuthContext';
import { hasTenantPanelAccess } from '../../utils/tenant-capabilities';
import { GuardLoading } from './GuardLoading';

export interface RequireTenantPanelProps {
  children: React.ReactNode;
  /** Rendered while the session check is in flight (default: GuardLoading). */
  loadingFallback?: React.ReactNode;
}

export const RequireTenantPanel: React.FC<RequireTenantPanelProps> = ({
  children,
  loadingFallback,
}) => {
  const { user, isAuthenticated, isLoading } = useAuthContext();

  if (isLoading) {
    return <>{loadingFallback ?? <GuardLoading />}</>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Fail-closed: a user with no panel capability is bounced before any page
  // loads. Per-page capability gates (RequireCapability) apply after this.
  if (!hasTenantPanelAccess(user)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
};
