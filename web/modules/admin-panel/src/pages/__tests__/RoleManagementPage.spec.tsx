/**
 * RoleManagementPage on the admin data layer (ADMIN-HIGH-121), and a permission
 * matrix that reported a failed request as "this role holds nothing".
 *
 * `loadRolePermissions` caught its error and called
 * `setSelectedRolePermissions([])`. Every permission in the catalogue then
 * rendered with an unchecked box and grey text — which on a permission matrix
 * is not an empty state, it is a claim about a role's authority, read off a
 * request that never returned.
 *
 * The page also carried a fifth hand-typed copy of the role vocabulary: four
 * JSX blocks naming `Super Admin (100)`, `Tenant Admin (90)`,
 * `Module Manager (70)` and `Module User (10)`. The numbers were right, which
 * is the point — the four other copies were right too until they were not
 * (ADMIN-CRITICAL-133), and this one could not notice that the catalogue lost
 * two entries in W8r.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import RoleManagementPage from '../RoleManagementPage';
import { usersApi } from '../../services/adminApi';
import type { Permission, RoleHierarchyItem } from '../../services/types';

vi.mock('../../services/adminApi', () => ({
  usersApi: {
    getRoleHierarchy: vi.fn(),
    getPermissionsByCategory: vi.fn(),
    getRolePermissions: vi.fn(),
  },
}));

const hierarchyMock = vi.mocked(usersApi.getRoleHierarchy);
const catalogueMock = vi.mocked(usersApi.getPermissionsByCategory);
const grantsMock = vi.mocked(usersApi.getRolePermissions);

function role(code: string, name: string, level: number): RoleHierarchyItem {
  return {
    code,
    name,
    description: `${name} description`,
    level,
    permissions: ['dashboard:view'],
    isSystem: true,
    color: '#000000',
    icon: 'shield',
  };
}

/** The four the platform actually defines — SUPERVISOR and OPERATOR are gone. */
function hierarchy(): RoleHierarchyItem[] {
  return [
    role('SUPER_ADMIN', 'Super Admin', 100),
    role('TENANT_ADMIN', 'Tenant Admin', 90),
    role('MODULE_MANAGER', 'Module Manager', 70),
    role('MODULE_USER', 'Module User', 10),
  ];
}

function catalogue(): Record<string, Permission[]> {
  return {
    Dashboard: [
      {
        code: 'dashboard:view',
        name: 'View Dashboard',
        description: 'Access to main dashboard',
        category: 'Dashboard',
      },
    ],
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RoleManagementPage />
    </QueryClientProvider>,
  );
}

describe('RoleManagementPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hierarchyMock.mockResolvedValue(hierarchy());
    catalogueMock.mockResolvedValue(catalogue());
    grantsMock.mockResolvedValue(['dashboard:view']);
  });

  it('forwards the abort signal to all three reads', async () => {
    renderPage();

    await waitFor(() => expect(hierarchyMock).toHaveBeenCalled());
    expect(hierarchyMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(catalogueMock).toHaveBeenCalled());
    expect(catalogueMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(grantsMock).toHaveBeenCalled());
    expect(grantsMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("does not read a role's grants before a role is selected", () => {
    hierarchyMock.mockReturnValue(new Promise(() => undefined));
    renderPage();

    expect(grantsMock).not.toHaveBeenCalled();
  });

  it('says the grants are unknown rather than drawing an empty matrix', async () => {
    grantsMock.mockRejectedValue(new Error('role permissions unavailable'));
    renderPage();

    // The regression: the catch installed `[]`, so every permission rendered
    // unchecked and the role read as holding nothing.
    expect(
      await screen.findByText('Permissions for this role could not be loaded.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('View Dashboard')).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('role permissions unavailable');
  });

  it('renders the assignment rules from the catalogue, not from a hand-typed list', async () => {
    hierarchyMock.mockResolvedValue([role('TENANT_ADMIN', 'Tenant Admin', 90)]);
    renderPage();

    await screen.findByText('Role Assignment Rules');
    // The hand-typed blocks named all four roles unconditionally; a catalogue
    // holding one role must now produce one card.
    expect(screen.getAllByText('Tenant Admin (90)')).toHaveLength(1);
    expect(screen.queryByText(/Super Admin \(100\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Module User \(10\)/)).not.toBeInTheDocument();
  });

  it('names the failed read rather than showing an empty hierarchy', async () => {
    hierarchyMock.mockRejectedValue(new Error('role hierarchy is unreachable'));
    catalogueMock.mockRejectedValue(new Error('role hierarchy is unreachable'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('role hierarchy is unreachable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
