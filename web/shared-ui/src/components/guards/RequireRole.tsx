/**
 * RequireRole — the single authorization gate of the guard family.
 *
 * Carries, as explicit parameters, every authorization face the guards in this
 * repo needed (the shell's `ProtectedRoute` surface included):
 *
 * - `requiredRoles` — any-of, HIERARCHY-aware (`hasRoleOrHigher`, so
 *   SUPER_ADMIN passes TENANT_ADMIN routes).
 * - `requiredCapabilities` — any-of tenant-RBAC capabilities
 *   (`hasResourcePermission`), letting a tenant admin delegate route access to
 *   a custom role (MT-HIGH-060).
 * - `requiredModule` — tenant-module access via `hasModuleAccess`
 *   (SUPER_ADMIN bypasses; the shell uses this for farm/hr/sensor/hydroponics).
 * - `blockMobileOnly` — MOBILE_ONLY users are bounced from web-panel routes.
 *
 * A user passes when they hold a required ROLE **or** a required CAPABILITY.
 * Fail-closed: when a requirement is declared and not satisfied, deny.
 *
 * Unauthenticated visitors are sent to `/login` BEFORE any authorization check
 * (an authorization denial is for authenticated users — `/unauthorized`).
 */

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthContext } from '../../contexts/AuthContext';
import { hasResourcePermission } from '../../utils/tenant-capabilities';
import type { UserRole } from '../../contexts/AuthContext';
import { GuardLoading } from './GuardLoading';

export interface RequireRoleProps {
  children: React.ReactNode;
  /** Any-of role requirement (hierarchy-aware: SUPER_ADMIN passes TENANT_ADMIN). */
  requiredRoles?: readonly UserRole[];
  /** Any-of tenant-RBAC capabilities that also satisfy this route (delegation). */
  requiredCapabilities?: readonly string[];
  /** Tenant-module access requirement — SUPER_ADMIN bypasses. */
  requiredModule?: string;
  /** Deny MOBILE_ONLY users (web-panel counterpart of the mobile access rule). */
  blockMobileOnly?: boolean;
  /** Rendered while the session check is in flight (default: GuardLoading). */
  loadingFallback?: React.ReactNode;
}

export const RequireRole: React.FC<RequireRoleProps> = ({
  children,
  requiredRoles,
  requiredCapabilities,
  requiredModule,
  blockMobileOnly,
  loadingFallback,
}) => {
  const { user, isAuthenticated, isLoading, isSuperAdmin, hasRoleOrHigher, hasModuleAccess } =
    useAuthContext();

  if (isLoading) {
    return <>{loadingFallback ?? <GuardLoading />}</>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (blockMobileOnly && user?.accessType === 'MOBILE_ONLY') {
    return <Navigate to="/unauthorized" replace />;
  }

  if ((requiredRoles?.length ?? 0) > 0 || (requiredCapabilities?.length ?? 0) > 0) {
    const hasRequiredRole = requiredRoles?.some((role) => hasRoleOrHigher(role)) ?? false;
    const hasRequiredCapability =
      requiredCapabilities?.some((capability) => hasResourcePermission(user, capability)) ?? false;
    if (!hasRequiredRole && !hasRequiredCapability) {
      return <Navigate to="/unauthorized" replace />;
    }
  }

  if (requiredModule && !isSuperAdmin() && !hasModuleAccess(requiredModule)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
};
