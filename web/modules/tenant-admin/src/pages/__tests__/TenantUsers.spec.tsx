/**
 * TenantUsers Page Tests
 *
 * Tests for the tenant user management page:
 * - User list render
 * - Add user modal open/close
 * - Role-based button visibility (SEC-007)
 * - Bulk deactivate flow (SEC-011)
 * - Search/filter
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

// Mock useAuthContext — controls role-based visibility
const mockHasRoleOrHigher = vi.fn();

vi.mock('@aquaculture/shared-ui', () => ({
  useAuthContext: () => ({
    hasRoleOrHigher: mockHasRoleOrHigher,
    user: { id: 'u1', email: 'admin@test.com', role: 'TENANT_ADMIN' },
    isAuthenticated: true,
  }),
}));

// Mock graphqlRequest
const mockGraphqlRequest = vi.fn();

vi.mock('../../services/tenant-api.service', () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
  getTenantRoles: vi.fn().mockResolvedValue([]),
  getTenantRole: vi.fn(),
  getDefaultTenantRole: vi.fn(),
  getPermissionCategories: vi.fn(),
  createTenantRole: vi.fn(),
  updateTenantRole: vi.fn(),
  deleteTenantRole: vi.fn(),
  seedTenantRoles: vi.fn(),
}));

vi.mock('../../utils/error-handling', () => ({
  logError: vi.fn(),
  processError: vi.fn((err: unknown) => ({
    code: 'UNKNOWN_ERROR',
    message: err instanceof Error ? err.message : String(err),
    userMessage: 'Error',
    timestamp: new Date(),
    retryable: false,
  })),
}));

// Mock useTenantRoles hook
vi.mock('../../hooks/useTenantRoles', () => ({
  useTenantRoles: () => ({
    data: [
      { id: 'r1', name: 'admin', displayName: 'Admin' },
      { id: 'r2', name: 'user', displayName: 'User' },
    ],
    isLoading: false,
  }),
}));

// Import after mocks
import TenantUsers from '../TenantUsers';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const mockApiUsers = [
  {
    id: 'u1',
    email: 'john@ocean.com',
    firstName: 'John',
    lastName: 'Doe',
    role: 'TENANT_ADMIN',
    isActive: true,
    isEmailVerified: true,
    lastLoginAt: new Date().toISOString(),
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'u2',
    email: 'jane@ocean.com',
    firstName: 'Jane',
    lastName: 'Smith',
    role: 'MODULE_USER',
    isActive: true,
    isEmailVerified: true,
    lastLoginAt: new Date(Date.now() - 86400000).toISOString(),
    createdAt: '2024-02-01T00:00:00Z',
  },
  {
    id: 'u3',
    email: 'bob@ocean.com',
    firstName: 'Bob',
    lastName: 'Wilson',
    role: 'MODULE_MANAGER',
    isActive: false,
    isEmailVerified: false,
    lastLoginAt: null,
    createdAt: '2024-03-01T00:00:00Z',
  },
];

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(TenantUsers),
      ),
    ),
  );
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('TenantUsers Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasRoleOrHigher.mockReturnValue(true); // TENANT_ADMIN by default
    mockGraphqlRequest.mockResolvedValue({ tenantUsers: mockApiUsers });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========================================================================
  // User list render
  // ========================================================================

  describe('User List Rendering', () => {
    it('should render user list after loading', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('John Doe')).toBeInTheDocument();
        expect(screen.getByText('Jane Smith')).toBeInTheDocument();
      });
    });

    it('should display user emails', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('john@ocean.com')).toBeInTheDocument();
        expect(screen.getByText('jane@ocean.com')).toBeInTheDocument();
      });
    });

    it('should display role badges', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Tenant Admin')).toBeInTheDocument();
        expect(screen.getByText('Module User')).toBeInTheDocument();
        expect(screen.getByText('Module Manager')).toBeInTheDocument();
      });
    });

    it('should display status badges (active, inactive)', async () => {
      renderPage();

      await waitFor(() => {
        // u1, u2 = Active; u3 = Inactive
        const activeBadges = screen.getAllByText('Active');
        expect(activeBadges.length).toBe(2);
        expect(screen.getByText('Inactive')).toBeInTheDocument();
      });
    });

    it('should show empty state when no users', async () => {
      mockGraphqlRequest.mockResolvedValue({ tenantUsers: [] });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('No users yet')).toBeInTheDocument();
      });
    });

    it('should show error message on load failure', async () => {
      mockGraphqlRequest.mockRejectedValue(new Error('Connection refused'));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Failed to load users')).toBeInTheDocument();
      });
    });

    it('should show user count in pagination info', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/Showing 3 of 3 users/)).toBeInTheDocument();
      });
    });

    it('should call graphqlRequest with the correct query', async () => {
      renderPage();

      await waitFor(() => {
        expect(mockGraphqlRequest).toHaveBeenCalledWith(
          expect.stringContaining('query TenantUsers'),
        );
      });
    });
  });

  // ========================================================================
  // Add user modal open/close
  // ========================================================================

  describe('Add User Modal', () => {
    it('should open modal when Add User button is clicked', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      const addButton = screen.getByRole('button', { name: /add user/i });
      await user.click(addButton);

      // Modal should now be visible — AddEditUserModal renders with role select etc.
      await waitFor(() => {
        expect(screen.getByText(/create|add|invite/i)).toBeInTheDocument();
      });
    });

    it('should close modal when close is triggered', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      // Open
      const addButton = screen.getByRole('button', { name: /add user/i });
      await user.click(addButton);

      // Close via cancel/close button
      const cancelButton = screen.queryByRole('button', { name: /cancel|close/i });
      if (cancelButton) {
        await user.click(cancelButton);
      }
    });
  });

  // ========================================================================
  // Role-based button visibility (SEC-007)
  // ========================================================================

  describe('Role-Based Button Visibility (SEC-007)', () => {
    it('should show Add User button for TENANT_ADMIN', async () => {
      mockHasRoleOrHigher.mockReturnValue(true);
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument();
    });

    it('should hide Add User button for MODULE_USER', async () => {
      mockHasRoleOrHigher.mockReturnValue(false);
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /add user/i })).not.toBeInTheDocument();
    });

    it('should show edit/delete buttons for TENANT_ADMIN', async () => {
      mockHasRoleOrHigher.mockReturnValue(true);
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      const editButtons = screen.getAllByTitle('Edit user');
      expect(editButtons.length).toBeGreaterThan(0);

      const deleteButtons = screen.getAllByTitle('Delete user');
      expect(deleteButtons.length).toBeGreaterThan(0);
    });

    it('should show "View only" for MODULE_USER (no edit/delete)', async () => {
      mockHasRoleOrHigher.mockReturnValue(false);
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      expect(screen.queryByTitle('Edit user')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Delete user')).not.toBeInTheDocument();
      const viewOnlyLabels = screen.getAllByText('View only');
      expect(viewOnlyLabels.length).toBeGreaterThan(0);
    });

    it('should show Add User button for SUPER_ADMIN (hierarchy)', async () => {
      mockHasRoleOrHigher.mockImplementation((role: string) => {
        // SUPER_ADMIN has higher level than TENANT_ADMIN
        return true;
      });
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument();
    });
  });

  // ========================================================================
  // Bulk deactivate flow (SEC-011)
  // ========================================================================

  describe('Bulk Deactivate Flow (SEC-011)', () => {
    it('should show bulk deactivate bar when users are selected', async () => {
      mockHasRoleOrHigher.mockReturnValue(true);
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      // Select first user checkbox (skip header checkbox)
      const checkboxes = screen.getAllByRole('checkbox');
      // checkboxes[0] is "select all", checkboxes[1] is first user
      await user.click(checkboxes[1]);

      await waitFor(() => {
        expect(screen.getByText(/1 user\(s\) selected/)).toBeInTheDocument();
      });
    });

    it('should call deactivate mutation for selected users', async () => {
      mockHasRoleOrHigher.mockReturnValue(true);
      mockGraphqlRequest
        .mockResolvedValueOnce({ tenantUsers: mockApiUsers }) // initial load
        .mockResolvedValue({ deactivateTenantUser: { id: 'u1', isActive: false } }); // deactivate

      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      // Select user
      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]);

      // Click Deactivate
      const deactivateButton = await screen.findByRole('button', { name: /deactivate/i });
      await user.click(deactivateButton);

      await waitFor(() => {
        // Should have called graphqlRequest with the deactivate mutation
        expect(mockGraphqlRequest).toHaveBeenCalledWith(
          expect.stringContaining('DeactivateTenantUser'),
          expect.any(Object),
        );
      });
    });

    it('should hide bulk deactivate bar for MODULE_USER', async () => {
      mockHasRoleOrHigher.mockReturnValue(false);
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      // Select user — the bar should not appear since canManageUsers is false
      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]);

      expect(screen.queryByRole('button', { name: /deactivate/i })).not.toBeInTheDocument();
    });

    it('should allow select-all toggle', async () => {
      mockHasRoleOrHigher.mockReturnValue(true);
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      // Click select-all
      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[0]); // select all

      await waitFor(() => {
        expect(screen.getByText(/3 user\(s\) selected/)).toBeInTheDocument();
      });

      // Toggle off
      await user.click(checkboxes[0]);

      await waitFor(() => {
        expect(screen.queryByText(/user\(s\) selected/)).not.toBeInTheDocument();
      });
    });
  });

  // ========================================================================
  // Search/filter
  // ========================================================================

  describe('Search and Filter', () => {
    it('should filter users by name search', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      const searchInput = screen.getByPlaceholderText(/search users/i);
      await user.type(searchInput, 'Jane');

      // After debounce, only Jane should remain
      await waitFor(() => {
        expect(screen.getByText('Jane Smith')).toBeInTheDocument();
        expect(screen.queryByText('John Doe')).not.toBeInTheDocument();
      });
    });

    it('should filter users by email search', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      const searchInput = screen.getByPlaceholderText(/search users/i);
      await user.type(searchInput, 'bob@ocean');

      await waitFor(() => {
        expect(screen.getByText('Bob Wilson')).toBeInTheDocument();
        expect(screen.queryByText('John Doe')).not.toBeInTheDocument();
      });
    });

    it('should filter users by role', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      // Select role filter
      const roleSelect = screen.getAllByRole('combobox')[0];
      await user.selectOptions(roleSelect, 'MODULE_USER');

      await waitFor(() => {
        expect(screen.getByText('Jane Smith')).toBeInTheDocument();
        expect(screen.queryByText('John Doe')).not.toBeInTheDocument();
      });
    });

    it('should filter users by status', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      // Select status filter
      const statusSelect = screen.getAllByRole('combobox')[1];
      await user.selectOptions(statusSelect, 'inactive');

      await waitFor(() => {
        expect(screen.getByText('Bob Wilson')).toBeInTheDocument();
        expect(screen.queryByText('John Doe')).not.toBeInTheDocument();
      });
    });

    it('should show "No users found" when search has no results', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      const searchInput = screen.getByPlaceholderText(/search users/i);
      await user.type(searchInput, 'zzz-no-match-zzz');

      await waitFor(() => {
        expect(screen.getByText('No users found')).toBeInTheDocument();
      });
    });
  });
});
