/**
 * The shell's gate on the tenant panel (/tenant/*).
 *
 * WHY: the company dashboard — the panel's index — opens for every tenant
 * member: it shows a tenant admin the account's cards and anyone else only the
 * notices meant for them (tenant-admin CompanyHome). Every other panel page
 * keeps the gate the whole mount had: TENANT_ADMIN (hierarchy-aware) or a
 * delegate holding a panel capability (MT-HIGH-060), with the per-page
 * capability checked again inside the remote and enforced by the backend.
 *
 * WHAT: ProtectedRoute with no role requirement at `/tenant` itself, and with
 * the panel requirement anywhere below it. One ProtectedRoute either way, so
 * moving between the dashboard and a panel page does not remount the remote.
 */
import { TENANT_PANEL_CAPABILITIES } from '@aquaculture/shared-ui';
import type { ReactElement, ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { ProtectedRoute } from './ProtectedRoute';

const PANEL_ROLES: readonly string[] = ['TENANT_ADMIN'];

/** Whether `pathname` is the company dashboard, the panel's index. */
export function isCompanyDashboardPath(pathname: string): boolean {
  return pathname === '/tenant' || pathname === '/tenant/';
}

export function TenantPanelRoute({ children }: { readonly children: ReactNode }): ReactElement {
  const { pathname } = useLocation();
  const companyDashboard = isCompanyDashboardPath(pathname);
  return (
    <ProtectedRoute
      requiredRoles={companyDashboard ? undefined : [...PANEL_ROLES]}
      requiredCapabilities={companyDashboard ? undefined : [...TENANT_PANEL_CAPABILITIES]}
    >
      {children}
    </ProtectedRoute>
  );
}
