/**
 * Module route-guard tests (SEC-007 + MT-HIGH-060 delegation).
 *
 * - Authenticated TENANT_ADMIN / SUPER_ADMIN -> render children (bypass all gates)
 * - Authenticated MODULE_USER with no panel capability -> redirect /unauthorized
 * - Unauthenticated -> redirect /login
 * - Delegate (MODULE_USER + capability) -> reaches ONLY the delegated pages;
 *   admin-only pages (billing/database/...) still redirect to /unauthorized.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTenantAdminTestQueryClient } from '../test/query-client';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

interface MockUser {
  id: string;
  email: string;
  role: string;
  resourcePermissions?: string[];
}

// Controllable auth state. Tests set `mockUser` (role + granted capabilities);
// hasRoleOrHigher AND the capability SSoT functions all derive from it, so the
// mock behaves like the real shared-ui module.
let mockUser: MockUser | null = null;
const mockIsAuthenticated = vi.fn();
const mockIsLoading = vi.fn();

function isAdminRole(role: string | null | undefined): boolean {
  return role === 'SUPER_ADMIN' || role === 'TENANT_ADMIN';
}

// Kept as a spy (a test asserts it is called with 'TENANT_ADMIN') but its return
// is derived from mockUser so callers see consistent role state.
const mockHasRoleOrHigher = vi.fn((role: string) =>
  role === 'TENANT_ADMIN' ? isAdminRole(mockUser?.role) : false,
);

const PANEL_CAPS = ['users:view', 'roles:view', 'settings:view'];

vi.mock('@aquaculture/shared-ui', () => ({
  useAuthContext: () => ({
    hasRoleOrHigher: mockHasRoleOrHigher,
    isAuthenticated: mockIsAuthenticated(),
    isLoading: mockIsLoading(),
    user: mockUser,
  }),
  hasResourcePermission: (u: MockUser | null | undefined, perm: string) =>
    !!u && (isAdminRole(u.role) || (u.resourcePermissions ?? []).includes(perm)),
  hasTenantPanelAccess: (u: MockUser | null | undefined) =>
    !!u &&
    (isAdminRole(u.role) ||
      PANEL_CAPS.some((c) => (u.resourcePermissions ?? []).includes(c))),
  getTenantId: vi.fn(() => 'tenant-1'),
  createTenantQueryKey: (tenantId: string | null | undefined, ...segments: readonly unknown[]) => [
    'tenant',
    tenantId,
    ...segments,
  ],
}));

// Mock all page components to simple stubs to avoid deep dependency chains
vi.mock('../pages/TenantDashboard', () => ({
  default: () => React.createElement('div', { 'data-testid': 'tenant-dashboard' }, 'Dashboard Page'),
}));
vi.mock('../pages/TenantUsers', () => ({
  default: () => React.createElement('div', { 'data-testid': 'tenant-users' }, 'Users Page'),
}));
vi.mock('../pages/TenantModules', () => ({
  default: () => React.createElement('div', null, 'Modules'),
}));
vi.mock('../pages/TenantSettings', () => ({
  default: () => React.createElement('div', { 'data-testid': 'tenant-settings' }, 'Settings'),
}));
vi.mock('../pages/TenantDatabase', () => ({
  default: () => React.createElement('div', null, 'Database'),
}));
vi.mock('../pages/TenantMessagesPage', () => ({
  default: () => React.createElement('div', null, 'Messages'),
}));
vi.mock('../pages/TenantSupportPage', () => ({
  default: () => React.createElement('div', null, 'Support'),
}));
vi.mock('../pages/TenantAnnouncementsPage', () => ({
  default: () => React.createElement('div', null, 'Announcements'),
}));
vi.mock('../pages/EdgeDevicesPage', () => ({
  default: () => React.createElement('div', null, 'Devices'),
}));
vi.mock('../pages/EdgeDeviceDetailPage', () => ({
  default: () => React.createElement('div', null, 'Device Detail'),
}));
vi.mock('../pages/TenantRolesPage', () => ({
  default: () => React.createElement('div', { 'data-testid': 'tenant-roles' }, 'Roles'),
}));
vi.mock('../pages/TenantAuditLogPage', () => ({
  default: () => React.createElement('div', null, 'Audit Log'),
}));
vi.mock('../pages/TenantBillingPage', () => ({
  default: () => React.createElement('div', { 'data-testid': 'tenant-billing' }, 'Billing'),
}));
vi.mock('../pages/TenantActivityPage', () => ({
  default: () => React.createElement('div', null, 'Activity'),
}));

// Import after mocks
import TenantAdminModule from '../Module';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function renderModule(initialPath: string = '/tenant') {
  const queryClient = createTenantAdminTestQueryClient();

  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        MemoryRouter,
        { initialEntries: [initialPath] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/tenant/*',
            element: React.createElement(TenantAdminModule),
          }),
          React.createElement(Route, {
            path: '/login',
            element: React.createElement('div', { 'data-testid': 'login-page' }, 'Login Page'),
          }),
          React.createElement(Route, {
            path: '/unauthorized',
            element: React.createElement('div', { 'data-testid': 'unauthorized-page' }, 'Unauthorized Page'),
          }),
        ),
      ),
    ),
  );
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('Tenant-admin route guards (SEC-007 + MT-HIGH-060)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { id: 'u1', email: 'test@test.com', role: 'TENANT_ADMIN' };
    mockIsLoading.mockReturnValue(false);
    mockIsAuthenticated.mockReturnValue(true);
    mockHasRoleOrHigher.mockImplementation((role: string) =>
      role === 'TENANT_ADMIN' ? isAdminRole(mockUser?.role) : false,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Authenticated TENANT_ADMIN', () => {
    it('should render dashboard for TENANT_ADMIN', async () => {
      mockUser = { id: 'u1', email: 'a@t.com', role: 'TENANT_ADMIN' };
      renderModule('/tenant');
      await waitFor(() => {
        expect(screen.getByTestId('tenant-dashboard')).toBeInTheDocument();
      });
    });

    it('should render users page for TENANT_ADMIN', async () => {
      mockUser = { id: 'u1', email: 'a@t.com', role: 'TENANT_ADMIN' };
      renderModule('/tenant/users');
      await waitFor(() => {
        expect(screen.getByTestId('tenant-users')).toBeInTheDocument();
      });
    });

    it('should check hasRoleOrHigher with TENANT_ADMIN', async () => {
      mockUser = { id: 'u1', email: 'a@t.com', role: 'TENANT_ADMIN' };
      renderModule('/tenant');
      await waitFor(() => {
        expect(screen.getByTestId('tenant-dashboard')).toBeInTheDocument();
      });
      expect(mockHasRoleOrHigher).toHaveBeenCalledWith('TENANT_ADMIN');
    });
  });

  describe('Authenticated MODULE_USER (no panel capability)', () => {
    it('should redirect a capability-less MODULE_USER to /unauthorized', async () => {
      mockUser = { id: 'u2', email: 'm@t.com', role: 'MODULE_USER' };
      renderModule('/tenant');
      await waitFor(() => {
        expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
      });
    });

    it('should redirect a capability-less MODULE_USER from /tenant/users', async () => {
      mockUser = { id: 'u2', email: 'm@t.com', role: 'MODULE_USER' };
      renderModule('/tenant/users');
      await waitFor(() => {
        expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
      });
    });

    it('should not render tenant content for a capability-less MODULE_USER', async () => {
      mockUser = { id: 'u2', email: 'm@t.com', role: 'MODULE_USER' };
      renderModule('/tenant');
      await waitFor(() => {
        expect(screen.queryByTestId('tenant-dashboard')).not.toBeInTheDocument();
      });
    });
  });

  describe('Delegate (MODULE_USER + tenant-RBAC capability)', () => {
    it('lets a users:view delegate reach /tenant/users', async () => {
      mockUser = { id: 'u3', email: 'd@t.com', role: 'MODULE_USER', resourcePermissions: ['users:view'] };
      renderModule('/tenant/users');
      await waitFor(() => {
        expect(screen.getByTestId('tenant-users')).toBeInTheDocument();
      });
    });

    it('lets a roles:view delegate reach /tenant/roles', async () => {
      mockUser = { id: 'u3', email: 'd@t.com', role: 'MODULE_USER', resourcePermissions: ['roles:view'] };
      renderModule('/tenant/roles');
      await waitFor(() => {
        expect(screen.getByTestId('tenant-roles')).toBeInTheDocument();
      });
    });

    it('redirects a users:view delegate away from an admin-only page (/tenant/billing)', async () => {
      mockUser = { id: 'u3', email: 'd@t.com', role: 'MODULE_USER', resourcePermissions: ['users:view'] };
      renderModule('/tenant/billing');
      await waitFor(() => {
        expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
      });
    });

    it('redirects a users:view delegate away from a non-granted delegatable page (/tenant/roles)', async () => {
      mockUser = { id: 'u3', email: 'd@t.com', role: 'MODULE_USER', resourcePermissions: ['users:view'] };
      renderModule('/tenant/roles');
      await waitFor(() => {
        expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
      });
    });
  });

  describe('Unauthenticated User', () => {
    it('should redirect unauthenticated user to /login', async () => {
      mockIsAuthenticated.mockReturnValue(false);
      renderModule('/tenant');
      await waitFor(() => {
        expect(screen.getByTestId('login-page')).toBeInTheDocument();
      });
    });

    it('should redirect unauthenticated user from nested route', async () => {
      mockIsAuthenticated.mockReturnValue(false);
      renderModule('/tenant/settings');
      await waitFor(() => {
        expect(screen.getByTestId('login-page')).toBeInTheDocument();
      });
    });
  });

  describe('SUPER_ADMIN (Role Hierarchy)', () => {
    it('should render dashboard for SUPER_ADMIN', async () => {
      mockUser = { id: 'u4', email: 's@t.com', role: 'SUPER_ADMIN' };
      renderModule('/tenant');
      await waitFor(() => {
        expect(screen.getByTestId('tenant-dashboard')).toBeInTheDocument();
      });
    });

    it('should render users page for SUPER_ADMIN', async () => {
      mockUser = { id: 'u4', email: 's@t.com', role: 'SUPER_ADMIN' };
      renderModule('/tenant/users');
      await waitFor(() => {
        expect(screen.getByTestId('tenant-users')).toBeInTheDocument();
      });
    });
  });

  describe('Loading State', () => {
    it('shows a checking-session state while auth is loading', () => {
      mockIsLoading.mockReturnValue(true);
      renderModule('/tenant');
      expect(screen.queryByTestId('tenant-dashboard')).not.toBeInTheDocument();
      expect(screen.queryByTestId('unauthorized-page')).not.toBeInTheDocument();
    });
  });
});
