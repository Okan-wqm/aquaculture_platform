/**
 * Module (RequireTenantAdmin Guard) Tests
 *
 * SEC-007: Defense-in-depth route guard for tenant admin pages.
 * Tests:
 * - Authenticated TENANT_ADMIN -> render children
 * - Authenticated MODULE_USER  -> redirect /unauthorized
 * - Unauthenticated            -> redirect /login
 * - SUPER_ADMIN                -> render children (hierarchy)
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTenantAdminTestQueryClient } from '../test/query-client';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

const mockHasRoleOrHigher = vi.fn();
const mockIsAuthenticated = vi.fn();
const mockIsLoading = vi.fn();

vi.mock('@aquaculture/shared-ui', () => ({
  useAuthContext: () => ({
    hasRoleOrHigher: mockHasRoleOrHigher,
    isAuthenticated: mockIsAuthenticated(),
    isLoading: mockIsLoading(),
    user: { id: 'u1', email: 'test@test.com', role: 'TENANT_ADMIN' },
  }),
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
  default: () => React.createElement('div', null, 'Settings'),
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
  default: () => React.createElement('div', null, 'Roles'),
}));
vi.mock('../pages/TenantAuditLogPage', () => ({
  default: () => React.createElement('div', null, 'Audit Log'),
}));
vi.mock('../pages/TenantBillingPage', () => ({
  default: () => React.createElement('div', null, 'Billing'),
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

describe('RequireTenantAdmin Guard (SEC-007)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsLoading.mockReturnValue(false);
    mockIsAuthenticated.mockReturnValue(true);
    mockHasRoleOrHigher.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========================================================================
  // Authenticated TENANT_ADMIN -> render children
  // ========================================================================

  describe('Authenticated TENANT_ADMIN', () => {
    it('should render dashboard for TENANT_ADMIN', async () => {
      mockIsAuthenticated.mockReturnValue(true);
      mockHasRoleOrHigher.mockReturnValue(true);

      renderModule('/tenant');

      await waitFor(() => {
        expect(screen.getByTestId('tenant-dashboard')).toBeInTheDocument();
      });
    });

    it('should render users page for TENANT_ADMIN', async () => {
      mockIsAuthenticated.mockReturnValue(true);
      mockHasRoleOrHigher.mockReturnValue(true);

      renderModule('/tenant/users');

      await waitFor(() => {
        expect(screen.getByTestId('tenant-users')).toBeInTheDocument();
      });
    });

    it('should check hasRoleOrHigher with TENANT_ADMIN', () => {
      mockIsAuthenticated.mockReturnValue(true);
      mockHasRoleOrHigher.mockReturnValue(true);

      renderModule('/tenant');

      expect(mockHasRoleOrHigher).toHaveBeenCalledWith('TENANT_ADMIN');
    });
  });

  // ========================================================================
  // Authenticated MODULE_USER -> redirect /unauthorized
  // ========================================================================

  describe('Authenticated MODULE_USER', () => {
    it('should redirect MODULE_USER to /unauthorized', async () => {
      mockIsAuthenticated.mockReturnValue(true);
      mockHasRoleOrHigher.mockReturnValue(false); // MODULE_USER fails the check

      renderModule('/tenant');

      await waitFor(() => {
        expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
      });
    });

    it('should redirect MODULE_USER from any tenant sub-route', async () => {
      mockIsAuthenticated.mockReturnValue(true);
      mockHasRoleOrHigher.mockReturnValue(false);

      renderModule('/tenant/users');

      await waitFor(() => {
        expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
      });
    });

    it('should not render tenant content for MODULE_USER', async () => {
      mockIsAuthenticated.mockReturnValue(true);
      mockHasRoleOrHigher.mockReturnValue(false);

      renderModule('/tenant');

      await waitFor(() => {
        expect(screen.queryByTestId('tenant-dashboard')).not.toBeInTheDocument();
      });
    });
  });

  // ========================================================================
  // Unauthenticated -> redirect /login
  // ========================================================================

  describe('Unauthenticated User', () => {
    it('should redirect unauthenticated user to /login', async () => {
      mockIsAuthenticated.mockReturnValue(false);
      mockHasRoleOrHigher.mockReturnValue(false);

      renderModule('/tenant');

      await waitFor(() => {
        expect(screen.getByTestId('login-page')).toBeInTheDocument();
      });
    });

    it('should redirect unauthenticated user from nested route', async () => {
      mockIsAuthenticated.mockReturnValue(false);
      mockHasRoleOrHigher.mockReturnValue(false);

      renderModule('/tenant/settings');

      await waitFor(() => {
        expect(screen.getByTestId('login-page')).toBeInTheDocument();
      });
    });
  });

  // ========================================================================
  // SUPER_ADMIN -> render children (hierarchy)
  // ========================================================================

  describe('SUPER_ADMIN (Role Hierarchy)', () => {
    it('should render dashboard for SUPER_ADMIN', async () => {
      mockIsAuthenticated.mockReturnValue(true);
      // SUPER_ADMIN has higher rank than TENANT_ADMIN, so hasRoleOrHigher returns true
      mockHasRoleOrHigher.mockReturnValue(true);

      renderModule('/tenant');

      await waitFor(() => {
        expect(screen.getByTestId('tenant-dashboard')).toBeInTheDocument();
      });
    });

    it('should render users page for SUPER_ADMIN', async () => {
      mockIsAuthenticated.mockReturnValue(true);
      mockHasRoleOrHigher.mockReturnValue(true);

      renderModule('/tenant/users');

      await waitFor(() => {
        expect(screen.getByTestId('tenant-users')).toBeInTheDocument();
      });
    });
  });

  // ========================================================================
  // Loading state
  // ========================================================================

  describe('Loading State', () => {
    it('should show loading message while auth is loading', () => {
      mockIsLoading.mockReturnValue(true);
      mockIsAuthenticated.mockReturnValue(false);

      renderModule('/tenant');

      expect(screen.getByText('Checking session...')).toBeInTheDocument();
      expect(screen.queryByTestId('tenant-dashboard')).not.toBeInTheDocument();
      expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
    });

    it('should not redirect while auth is still loading', () => {
      mockIsLoading.mockReturnValue(true);
      mockIsAuthenticated.mockReturnValue(false);

      renderModule('/tenant');

      expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
      expect(screen.queryByTestId('unauthorized-page')).not.toBeInTheDocument();
    });
  });
});
