/**
 * The shell's tenant-panel gate: the company dashboard (/tenant) opens for
 * every tenant member, and every other panel page keeps the gate the whole
 * mount had — TENANT_ADMIN (hierarchy-aware) or a delegate holding a panel
 * capability; anyone else is sent to /unauthorized. The remote's per-page
 * guards (tenant-admin Module) and the backend still apply below this.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantPanelRoute, isCompanyDashboardPath } from '../TenantPanelRoute';

type Role = 'TENANT_ADMIN' | 'MODULE_MANAGER' | 'MODULE_USER';

const session = vi.hoisted(() => ({
  current: { role: 'MODULE_USER' as string, resourcePermissions: [] as string[] },
}));

const RANK: Readonly<Record<string, number>> = {
  MODULE_USER: 1,
  MODULE_MANAGER: 2,
  TENANT_ADMIN: 3,
  SUPER_ADMIN: 4,
};

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useAuthContext: () => ({
      isAuthenticated: true,
      isLoading: false,
      user: {
        id: 'u-1',
        tenantId: 'tenant-1',
        accessType: 'WEB',
        role: session.current.role,
        resourcePermissions: session.current.resourcePermissions,
      },
      isSuperAdmin: () => false,
      hasRoleOrHigher: (role: string) => (RANK[session.current.role] ?? 0) >= (RANK[role] ?? 9),
      hasModuleAccess: () => true,
    }),
  };
});

function as(role: Role, resourcePermissions: string[] = []): void {
  session.current = { role, resourcePermissions };
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/tenant/*"
          element={
            <TenantPanelRoute>
              <p>panel page</p>
            </TenantPanelRoute>
          }
        />
        <Route path="/unauthorized" element={<p>unauthorized</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  as('MODULE_USER');
});

describe('TenantPanelRoute', () => {
  it.each(['/tenant', '/tenant/'])(
    'opens the company dashboard %s to a plain module user',
    (path) => {
      renderAt(path);
      expect(screen.getByText('panel page')).toBeTruthy();
    },
  );

  it.each(['/tenant/users', '/tenant/billing', '/tenant/modules', '/tenant/audit-log'])(
    'keeps %s closed to a module user without a panel capability',
    (path) => {
      renderAt(path);
      expect(screen.getByText('unauthorized')).toBeTruthy();
    },
  );

  it('admits a module manager to the dashboard and no further', () => {
    as('MODULE_MANAGER');
    renderAt('/tenant');
    expect(screen.getByText('panel page')).toBeTruthy();
  });

  it('still admits a delegate holding a panel capability below the dashboard', () => {
    as('MODULE_USER', ['users:view']);
    renderAt('/tenant/users');
    expect(screen.getByText('panel page')).toBeTruthy();
  });

  it('admits a tenant admin everywhere, as before', () => {
    as('TENANT_ADMIN');
    renderAt('/tenant/billing');
    expect(screen.getByText('panel page')).toBeTruthy();
  });

  it('treats only the panel index as the company dashboard', () => {
    expect(isCompanyDashboardPath('/tenant')).toBe(true);
    expect(isCompanyDashboardPath('/tenant/')).toBe(true);
    expect(isCompanyDashboardPath('/tenant/users')).toBe(false);
    expect(isCompanyDashboardPath('/tenantx')).toBe(false);
  });
});
