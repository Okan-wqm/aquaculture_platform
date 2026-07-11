/**
 * TenantRolesPage Tests
 *
 * Pins the error/empty-state separation and the delete-role contract:
 * - RBAC-M14: a query ERROR must NOT render the false-empty state or the
 *   "Seed Default Roles" offer (`roles` is only the [] default on error;
 *   offering a seed there invites a duplicate seed against unknown state).
 * - RBAC-M8: the backend hard-blocks deleting a role with active holders,
 *   so the delete dialog must state that rule and disable confirm — and a
 *   server rejection must surface in the dialog, not vanish into logError.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

const mockHasPermission = vi.fn();

vi.mock('@aquaculture/shared-ui', () => ({
  useAuth: () => ({
    hasPermission: mockHasPermission,
    user: { id: 'u1', email: 'admin@test.com', role: 'TENANT_ADMIN' },
    tenantId: 'tenant-1',
    isAuthenticated: true,
  }),
  getTenantId: vi.fn(() => 'tenant-1'),
  createTenantQueryKey: (tenantId: string | null | undefined, ...segments: readonly unknown[]) => [
    'tenant',
    tenantId,
    ...segments,
  ],
  createTenantInvalidationKey: (
    tenantId: string | null | undefined,
    ...segments: readonly unknown[]
  ) => ['tenant', tenantId, ...segments],
}));

vi.mock('../../utils/error-handling', () => ({
  logError: vi.fn(),
}));

const {
  mockUseTenantRoles,
  mockDeleteMutation,
  mockIdleMutation,
} = vi.hoisted(() => {
  const idle = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null as { message: string } | null,
    reset: vi.fn(),
  });
  return {
    mockUseTenantRoles: vi.fn(),
    mockDeleteMutation: idle(),
    mockIdleMutation: idle,
  };
});

vi.mock('../../hooks/useTenantRoles', () => ({
  useTenantRoles: (...args: unknown[]) => mockUseTenantRoles(...args),
  usePermissionCategories: () => ({ data: [], isLoading: false }),
  useCreateTenantRole: () => mockIdleMutation(),
  useUpdateTenantRole: () => mockIdleMutation(),
  useDeleteTenantRole: () => mockDeleteMutation,
  useSeedTenantRoles: () => mockIdleMutation(),
}));

// Import after mocks
import TenantRolesPage from '../TenantRolesPage';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

function makeRole(overrides: Record<string, unknown> = {}) {
  return {
    id: 'role-1',
    name: 'Technician',
    description: 'Field technician',
    color: '#22C55E',
    icon: 'wrench',
    level: 30,
    isSystem: false,
    isDefault: false,
    userCount: 0,
    permissions: { id: 'p1', roleId: 'role-1', panelPermissions: {}, resourcePermissions: [] },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  return render(<TenantRolesPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHasPermission.mockReturnValue(true);
  mockDeleteMutation.isPending = false;
  mockDeleteMutation.error = null;
});

// --------------------------------------------------------------------------
// RBAC-M14 — error vs confirmed-empty separation
// --------------------------------------------------------------------------

describe('TenantRolesPage error/empty separation (RBAC-M14)', () => {
  it('renders ONLY the error banner on query error — no seed offer, no false-empty state', () => {
    mockUseTenantRoles.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Network down'),
      refetch: vi.fn(),
    });

    renderPage();

    expect(screen.getByText('Failed to load roles')).toBeInTheDocument();
    expect(screen.getByText('Network down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    // The double-seed trap: neither seed button nor the empty state may render.
    expect(screen.queryByText('Seed Default Roles')).not.toBeInTheDocument();
    expect(screen.queryByText('No roles defined')).not.toBeInTheDocument();
  });

  it('renders the empty state + seed offer only on a CONFIRMED empty list', () => {
    mockUseTenantRoles.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage();

    expect(screen.getByText('No roles defined')).toBeInTheDocument();
    // Header + empty-state both offer the seed (roles:create holder).
    expect(screen.getAllByText('Seed Default Roles').length).toBeGreaterThan(0);
    expect(screen.queryByText('Failed to load roles')).not.toBeInTheDocument();
  });
});

// --------------------------------------------------------------------------
// RBAC-M8 — delete dialog mirrors the backend delete guard
// --------------------------------------------------------------------------

describe('TenantRolesPage delete-role contract (RBAC-M8)', () => {
  it('blocks confirm and states the backend rule when the role has active holders', async () => {
    const user = userEvent.setup();
    mockUseTenantRoles.mockReturnValue({
      data: [makeRole({ userCount: 3 })],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage();
    await user.click(screen.getByRole('button', { name: 'Delete Technician role' }));

    expect(
      screen.getByText(/cannot be deleted while it is assigned to/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Role' })).toBeDisabled();
  });

  it('allows confirm when the role has no holders', async () => {
    const user = userEvent.setup();
    mockUseTenantRoles.mockReturnValue({
      data: [makeRole({ userCount: 0 })],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage();
    await user.click(screen.getByRole('button', { name: 'Delete Technician role' }));

    expect(screen.getByRole('button', { name: 'Delete Role' })).toBeEnabled();
    expect(
      screen.queryByText(/cannot be deleted while it is assigned to/i),
    ).not.toBeInTheDocument();
  });

  it('surfaces a server rejection inside the dialog instead of failing silently', async () => {
    const user = userEvent.setup();
    mockUseTenantRoles.mockReturnValue({
      data: [makeRole({ userCount: 0 })],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDeleteMutation.error = { message: 'Cannot delete role "Technician" - 3 users are still assigned' };

    renderPage();
    await user.click(screen.getByRole('button', { name: 'Delete Technician role' }));

    expect(
      screen.getByText(/3 users are still assigned/i),
    ).toBeInTheDocument();
  });

  it('resets a stale server rejection when reopening the dialog', async () => {
    const user = userEvent.setup();
    mockUseTenantRoles.mockReturnValue({
      data: [makeRole({ userCount: 0 })],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage();
    await user.click(screen.getByRole('button', { name: 'Delete Technician role' }));

    expect(mockDeleteMutation.reset).toHaveBeenCalled();
  });
});
