/**
 * RequireTenantAdmin - route-level guard for all tenant admin pages.
 *
 * SEC-007: defense-in-depth, module-level RBAC.
 * Uses hasRoleOrHigher so that SUPER_ADMIN also passes (role hierarchy).
 * Redirects unauthorized users to /unauthorized rather than showing the UI.
 *
 * LOW-15: Extracted from Module.tsx to its own reusable component so it
 * can be unit-tested and reused independently.
 */

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthContext } from '@aquaculture/shared-ui';

export const RequireTenantAdmin: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { hasRoleOrHigher, isAuthenticated, isLoading } = useAuthContext();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        Checking session...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (!hasRoleOrHigher('TENANT_ADMIN')) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
};
