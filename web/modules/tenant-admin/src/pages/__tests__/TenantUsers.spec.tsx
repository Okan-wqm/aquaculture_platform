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

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createTenantAdminTestQueryClient } from '../../test/query-client';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

// Mock useAuthContext — controls role-based visibility
const mockHasRoleOrHigher = vi.fn();
const mockToast = vi.fn();

vi.mock('@aquaculture/shared-ui', () => ({
  useAuthContext: () => ({
    hasRoleOrHigher: mockHasRoleOrHigher,
    user: { id: 'u1', email: 'admin@test.com', role: 'TENANT_ADMIN' },
    isAuthenticated: true,
  }),
  useToast: () => ({ toast: mockToast }),
  getAccessToken: vi.fn(() => 'test-access-token'),
  getTenantId: vi.fn(() => 'tenant-1'),
  createTenantQueryKey: (tenantId: string | null | undefined, ...segments: readonly unknown[]) => [
    'tenant',
    tenantId,
    ...segments,
  ],
  // Lightweight stand-ins for the shared-ui components tenant-admin now
  // composes (ADMIN-MEDIUM-004): they preserve the rendered text/roles the
  // assertions below rely on without pulling in the real design system.
  Badge: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('span', null, children),
  Avatar: ({ name }: { name: string }) =>
    React.createElement('div', { role: 'img', 'aria-label': name }),
  ConfirmModal: ({
    isOpen,
    open,
    onClose,
    onConfirm,
    title,
    message,
    confirmText,
    cancelText,
    isLoading,
    loadingText,
  }: {
    isOpen?: boolean;
    open?: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    isLoading?: boolean;
    loadingText?: string;
  }) =>
    (isOpen ?? open)
      ? React.createElement(
          'div',
          { role: 'alertdialog', 'aria-label': title },
          React.createElement('h3', null, title),
          React.createElement('div', null, message),
          React.createElement(
            'button',
            { type: 'button', onClick: onClose, disabled: isLoading },
            cancelText ?? 'Cancel',
          ),
          React.createElement(
            'button',
            { type: 'button', onClick: onConfirm, disabled: isLoading },
            isLoading ? loadingText ?? 'Loading...' : confirmText ?? 'Confirm',
          ),
        )
      : null,
}));

const {
  mockGetTenantUsers,
  mockCreateTenantUser,
  mockUpdateTenantUser,
  mockDeleteTenantUser,
  mockDeactivateTenantUser,
  mockActivateTenantUser,
  mockUnlockTenantUser,
  mockBulkAssignUserRole,
  mockGetUserEffectivePermissions,
  mockUnexpectedTenantApiCall,
} = vi.hoisted(() => ({
  mockGetTenantUsers: vi.fn(),
  mockCreateTenantUser: vi.fn(),
  mockUpdateTenantUser: vi.fn(),
  mockDeleteTenantUser: vi.fn(),
  mockDeactivateTenantUser: vi.fn(),
  mockActivateTenantUser: vi.fn(),
  mockUnlockTenantUser: vi.fn(),
  mockBulkAssignUserRole: vi.fn(),
  mockGetUserEffectivePermissions: vi.fn(),
  mockUnexpectedTenantApiCall: (name: string) =>
    vi.fn(() => Promise.reject(new Error(`Unexpected tenant-admin API call: ${name}`))),
}));

vi.mock('../../lib/api', () => ({
  getMyTenant: mockUnexpectedTenantApiCall('getMyTenant'),
  getTenantStats: mockUnexpectedTenantApiCall('getTenantStats'),
  getMyTenantModules: mockUnexpectedTenantApiCall('getMyTenantModules'),
  getTenantUsers: (...args: unknown[]) => mockGetTenantUsers(...args),
  getTenantDatabase: mockUnexpectedTenantApiCall('getTenantDatabase'),
  getTableSchema: mockUnexpectedTenantApiCall('getTableSchema'),
  getTableData: mockUnexpectedTenantApiCall('getTableData'),
  assignModuleManager: mockUnexpectedTenantApiCall('assignModuleManager'),
  removeModuleManager: mockUnexpectedTenantApiCall('removeModuleManager'),
  updateTenant: mockUnexpectedTenantApiCall('updateTenant'),
  getMyModuleIds: mockUnexpectedTenantApiCall('getMyModuleIds'),
  getModuleUsageStats: mockUnexpectedTenantApiCall('getModuleUsageStats'),
  getEdgeDevices: mockUnexpectedTenantApiCall('getEdgeDevices'),
  getDeviceEvents: mockUnexpectedTenantApiCall('getDeviceEvents'),
  createTenantUser: (...args: unknown[]) => mockCreateTenantUser(...args),
  updateTenantUser: (...args: unknown[]) => mockUpdateTenantUser(...args),
  deleteTenantUser: (...args: unknown[]) => mockDeleteTenantUser(...args),
  deactivateTenantUser: (...args: unknown[]) => mockDeactivateTenantUser(...args),
  activateTenantUser: (...args: unknown[]) => mockActivateTenantUser(...args),
  unlockTenantUser: (...args: unknown[]) => mockUnlockTenantUser(...args),
  bulkAssignUserRole: (...args: unknown[]) => mockBulkAssignUserRole(...args),
  getUserEffectivePermissions: (...args: unknown[]) => mockGetUserEffectivePermissions(...args),
  getNotificationPreferences: mockUnexpectedTenantApiCall('getNotificationPreferences'),
  updateNotificationPreferences: mockUnexpectedTenantApiCall('updateNotificationPreferences'),
  getMobileUsersSettings: mockUnexpectedTenantApiCall('getMobileUsersSettings'),
  updateMobileUserSettings: mockUnexpectedTenantApiCall('updateMobileUserSettings'),
  getMyThreads: mockUnexpectedTenantApiCall('getMyThreads'),
  getThreadMessages: mockUnexpectedTenantApiCall('getThreadMessages'),
  sendMessage: mockUnexpectedTenantApiCall('sendMessage'),
  createThread: mockUnexpectedTenantApiCall('createThread'),
  getMyTickets: mockUnexpectedTenantApiCall('getMyTickets'),
  getTicketComments: mockUnexpectedTenantApiCall('getTicketComments'),
  createTicket: mockUnexpectedTenantApiCall('createTicket'),
  addTicketComment: mockUnexpectedTenantApiCall('addTicketComment'),
  rateTicket: mockUnexpectedTenantApiCall('rateTicket'),
  getMyAnnouncements: mockUnexpectedTenantApiCall('getMyAnnouncements'),
  viewAnnouncement: mockUnexpectedTenantApiCall('viewAnnouncement'),
  acknowledgeAnnouncement: mockUnexpectedTenantApiCall('acknowledgeAnnouncement'),
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
  sanitizeErrorMessage: vi.fn((err: unknown) =>
    err instanceof Error ? err.message : String(err),
  ),
  createErrorToastOptions: vi.fn((err: unknown) => ({
    variant: 'error',
    title: 'Error',
    description: err instanceof Error ? err.message : String(err),
  })),
}));

// Mock useTenantRoles hook
vi.mock('../../hooks/useTenantRoles', () => ({
  useTenantRoles: () => ({
    data: [
      { id: 'r1', name: 'Admin', color: '#6366F1', icon: 'shield', level: 90, isSystem: true, isDefault: false, userCount: 1 },
      { id: 'r2', name: 'User', color: '#10B981', icon: 'user', level: 10, isSystem: false, isDefault: true, userCount: 2 },
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
    lockedUntil: null as string | null,
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
    // Active failed-login lockout — drives the Unlock row action.
    lockedUntil: new Date(Date.now() + 3600000).toISOString() as string | null,
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
    lockedUntil: null as string | null,
    createdAt: '2024-03-01T00:00:00Z',
  },
];

interface TenantUserQueryOptions {
  limit?: number;
  offset?: number;
  status?: string;
  role?: string;
}

function getApiUserStatus(apiUser: (typeof mockApiUsers)[number]): 'active' | 'inactive' | 'pending' {
  if (apiUser.isActive === false) return 'inactive';
  if (!apiUser.isEmailVerified && !apiUser.lastLoginAt) return 'pending';
  return 'active';
}

function getTenantUsersFixture(options: TenantUserQueryOptions = {}) {
  const filteredUsers = mockApiUsers.filter((apiUser) => {
    const statusMatches = !options.status || getApiUserStatus(apiUser) === options.status;
    const roleMatches = !options.role || apiUser.role === options.role;
    return statusMatches && roleMatches;
  });
  const offset = options.offset ?? 0;
  const limit = options.limit ?? filteredUsers.length;
  return filteredUsers.slice(offset, offset + limit);
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function renderPage() {
  const queryClient = createTenantAdminTestQueryClient();

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
    mockGetTenantUsers.mockImplementation((options?: TenantUserQueryOptions) =>
      Promise.resolve(getTenantUsersFixture(options)),
    );
    mockCreateTenantUser.mockResolvedValue(mockApiUsers[0]);
    mockUpdateTenantUser.mockResolvedValue(mockApiUsers[0]);
    mockDeleteTenantUser.mockResolvedValue(true);
    mockDeactivateTenantUser.mockResolvedValue({ ...mockApiUsers[0], isActive: false });
    mockActivateTenantUser.mockResolvedValue({ id: 'u3', isActive: true });
    mockUnlockTenantUser.mockResolvedValue({ id: 'u2', lockedUntil: null });
    mockBulkAssignUserRole.mockResolvedValue({ success: [], failed: [] });
    mockGetUserEffectivePermissions.mockResolvedValue({
      roleId: 'r2',
      roleName: 'User',
      panelPermissions: { farm: { tanks: { read: true, update: false } } },
      resourcePermissions: ['users:view'],
      overrides: { grants: [], revokes: [] },
    });
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
        const table = within(screen.getByRole('table'));
        expect(table.getByText('Tenant Admin')).toBeInTheDocument();
        expect(table.getByText('Module User')).toBeInTheDocument();
        expect(table.getByText('Module Manager')).toBeInTheDocument();
      });
    });

    it('should display status badges (active, inactive)', async () => {
      renderPage();

      await waitFor(() => {
        // u1, u2 = Active; u3 = Inactive
        const activeBadges = within(screen.getByRole('table')).getAllByText('Active');
        expect(activeBadges.length).toBe(2);
        expect(within(screen.getByRole('table')).getByText('Inactive')).toBeInTheDocument();
      });
    });

    it('should show empty state when no users', async () => {
      mockGetTenantUsers.mockResolvedValue([]);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('No users yet')).toBeInTheDocument();
      });
    });

    it('should show error message on load failure', async () => {
      mockGetTenantUsers.mockRejectedValue(new Error('Connection refused'));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Failed to load users')).toBeInTheDocument();
      });
    });

    it('should show user count in pagination info', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/Showing 3 users \(page 1\)/)).toBeInTheDocument();
      });
    });

    it('should call getTenantUsers with the first-page query options', async () => {
      renderPage();

      await waitFor(() => {
        expect(mockGetTenantUsers).toHaveBeenCalledWith({ limit: 20, offset: 0 });
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

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /add new user/i })).toBeInTheDocument();
      });
    });

    it('should close modal when close is triggered', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      // Open
      const addButton = screen.getByRole('button', { name: /add user/i });
      await user.click(addButton);

      const dialog = await screen.findByRole('dialog', { name: /add new user/i });
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /add new user/i })).not.toBeInTheDocument();
      });
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
      mockHasRoleOrHigher.mockReturnValue(true);
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
      mockGetTenantUsers.mockImplementation((options?: TenantUserQueryOptions) =>
        Promise.resolve(getTenantUsersFixture(options)),
      );
      mockDeactivateTenantUser.mockResolvedValue({ ...mockApiUsers[0], isActive: false });

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
        expect(mockDeactivateTenantUser).toHaveBeenCalledWith('u1');
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
  // Activate + unlock row actions (ADMIN-HIGH-012)
  // ========================================================================

  describe('Activate and Unlock Row Actions (ADMIN-HIGH-012)', () => {
    it('should show the Activate action only for inactive users', async () => {
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      // Only u3 (Bob) is inactive
      expect(screen.getAllByTitle('Activate user')).toHaveLength(1);
    });

    it('should activate an inactive user after confirmation', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('Bob Wilson')).toBeInTheDocument());

      await user.click(screen.getByTitle('Activate user'));

      const dialog = await screen.findByRole('alertdialog', { name: 'Activate User' });
      await user.click(within(dialog).getByRole('button', { name: 'Activate' }));

      await waitFor(() => {
        expect(mockActivateTenantUser).toHaveBeenCalledWith('u3');
      });
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'success', title: 'User activated' }),
      );
    });

    it('should not activate when the confirmation is cancelled', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('Bob Wilson')).toBeInTheDocument());

      await user.click(screen.getByTitle('Activate user'));

      const dialog = await screen.findByRole('alertdialog', { name: 'Activate User' });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(screen.queryByRole('alertdialog', { name: 'Activate User' })).not.toBeInTheDocument();
      });
      expect(mockActivateTenantUser).not.toHaveBeenCalled();
    });

    it('should show the Unlock action only for locked users', async () => {
      renderPage();

      await waitFor(() => expect(screen.getByText('Jane Smith')).toBeInTheDocument());

      // Only u2 (Jane) has an active lockout
      expect(screen.getAllByTitle('Unlock user')).toHaveLength(1);
    });

    it('should unlock a locked user after confirmation', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('Jane Smith')).toBeInTheDocument());

      await user.click(screen.getByTitle('Unlock user'));

      const dialog = await screen.findByRole('alertdialog', { name: 'Unlock User' });
      await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));

      await waitFor(() => {
        expect(mockUnlockTenantUser).toHaveBeenCalledWith('u2');
      });
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'success', title: 'User unlocked' }),
      );
    });

    it('should hide Activate/Unlock actions for MODULE_USER', async () => {
      mockHasRoleOrHigher.mockReturnValue(false);
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      expect(screen.queryByTitle('Activate user')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Unlock user')).not.toBeInTheDocument();
    });
  });

  // ========================================================================
  // Bulk role assignment (ADMIN-MEDIUM-016)
  // ========================================================================

  describe('Bulk Role Assignment (ADMIN-MEDIUM-016)', () => {
    it('should bulk-assign the picked role to the selected users (happy path)', async () => {
      mockBulkAssignUserRole.mockResolvedValue({ success: ['u1'], failed: [] });

      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      // Select first user (checkbox[0] is select-all)
      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]);

      await waitFor(() => {
        expect(screen.getByText(/1 user\(s\) selected/)).toBeInTheDocument();
      });

      // Pick a role and trigger the bulk action
      const rolePicker = screen.getByRole('combobox', { name: /role to assign/i });
      await user.selectOptions(rolePicker, 'r2');

      await user.click(screen.getByRole('button', { name: /assign role/i }));

      // Confirm through the ConfirmModal gate
      const dialog = await screen.findByRole('alertdialog', { name: 'Assign Role' });
      await user.click(within(dialog).getByRole('button', { name: 'Assign Role' }));

      await waitFor(() => {
        expect(mockBulkAssignUserRole).toHaveBeenCalledWith({
          userIds: ['u1'],
          roleId: 'r2',
        });
      });

      // Outcome summary toast + selection cleared
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'success', title: 'Role assigned' }),
      );
      await waitFor(() => {
        expect(screen.queryByText(/user\(s\) selected/)).not.toBeInTheDocument();
      });
    });

    it('should keep the Assign role button disabled until a role is picked', async () => {
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]);

      const assignButton = await screen.findByRole('button', { name: /assign role/i });
      expect(assignButton).toBeDisabled();

      const rolePicker = screen.getByRole('combobox', { name: /role to assign/i });
      await user.selectOptions(rolePicker, 'r1');
      expect(assignButton).toBeEnabled();
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
