/**
 * The shell's route guard: authentication, the web-panel access type, an
 * any-of role (hierarchy-aware) or tenant-RBAC capability requirement, the
 * module a remote needs, and a tenant.
 *
 * WHY its own file: App.tsx mounts it on every protected route and
 * TenantPanelRoute narrows it for the tenant panel; a guard tested on its own
 * (routing/__tests__) cannot drift from the one the routes use.
 */
import React, { memo } from 'react';
import { Navigate } from 'react-router-dom';
import {
  BrandLoader,
  useAuthContext,
  useI18n,
  hasResourcePermission,
  type UserRole,
} from '@aquaculture/shared-ui';

export interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRoles?: string[];
  // MT-HIGH-060 delegation: any-of tenant-RBAC capabilities that also satisfy
  // this route. A user passes if they hold a required ROLE *or* a required
  // CAPABILITY — letting a tenant admin delegate panel access to a custom role.
  requiredCapabilities?: string[];
  requiredModule?: string;
}

/**
 * Protected route component
 * Handles authentication and role checks
 */
export const ProtectedRoute: React.FC<ProtectedRouteProps> = memo(
  ({ children, requiredRoles, requiredCapabilities, requiredModule }) => {
    const { isAuthenticated, isLoading, user, isSuperAdmin, hasRoleOrHigher, hasModuleAccess } =
      useAuthContext();
    const { t } = useI18n();

    // The session check is the first screen React draws on a refresh: the
    // full-screen BrandLoader, the boot splash's twin, so the hand-off from
    // index.html shows no swap (FE-MEDIUM-349).
    if (isLoading) {
      return <BrandLoader variant="screen" label={t('guards.checkingSession')} />;
    }

    // Authentication required
    if (!isAuthenticated) {
      return <Navigate to="/login" replace />;
    }

    // SECURITY: Block MOBILE_ONLY users from web panel
    if (user?.accessType === 'MOBILE_ONLY') {
      return <Navigate to="/unauthorized" replace />;
    }

    // Authorization — a user passes if they hold a required ROLE (via hierarchy, so
    // SUPER_ADMIN reaches TENANT_ADMIN routes) OR a required tenant-RBAC CAPABILITY
    // (delegation, MT-HIGH-060). Fail-closed: when either requirement is declared
    // and neither is satisfied, deny.
    if ((requiredRoles?.length ?? 0) > 0 || (requiredCapabilities?.length ?? 0) > 0) {
      const hasRequiredRole =
        requiredRoles?.some((role) => hasRoleOrHigher(role as UserRole)) ?? false;
      const hasRequiredCapability =
        requiredCapabilities?.some((cap) => hasResourcePermission(user, cap)) ?? false;
      if (!hasRequiredRole && !hasRequiredCapability) {
        return <Navigate to="/unauthorized" replace />;
      }
    }

    // Module access check — SUPER_ADMIN bypasses (system-level access)
    if (requiredModule && !isSuperAdmin()) {
      if (!hasModuleAccess(requiredModule)) {
        return <Navigate to="/unauthorized" replace />;
      }
    }

    // Tenant check - SUPER_ADMIN doesn't need a tenant
    if (!user?.tenantId && !isSuperAdmin()) {
      return <Navigate to="/unauthorized" replace />;
    }

    return <>{children}</>;
  },
);
