/**
 * UserManagementPage on the admin data layer (ADMIN-HIGH-121), and the two
 * things its hand-rolled reads and writes reported that were not true.
 *
 * 1. **Activating a user left "Active Users" at the pre-change figure.** Five
 *    write handlers called `fetchUsers()` AND `fetchInitialData()`;
 *    `handleToggleStatus` called only `fetchUsers()`. So the table refreshed
 *    and the four cards above it did not — on the one write whose entire
 *    purpose is to move a user between "active" and "inactive".
 *
 * 2. **Force-logout announced a completed security action on any 200.** The
 *    endpoint answers `{ success, count }`; the handler discarded both and set
 *    "User has been logged out of all sessions." So a refusal, or a user with
 *    no sessions to end, read exactly like a successful termination.
 *
 * Plus the tenant dropdown, which was cached in a `useRef` under a five-minute
 * TTL — outside the shell's `QueryClient`, where `logoutCleanup()` cannot reach
 * it and no tenant write can invalidate it.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import UserManagementPage from '../UserManagementPage';
import { usersApi, tenantsApi } from '../../services/adminApi';
import type { User, UserStats, Tenant, RoleTemplate } from '../../services/types';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    usersApi: {
      list: vi.fn(),
      getStats: vi.fn(),
      getRoleTemplates: vi.fn(),
      checkTenantLimit: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      activate: vi.fn(),
      deactivate: vi.fn(),
      forceLogout: vi.fn(),
      invite: vi.fn(),
    },
    tenantsApi: { list: vi.fn() },
  };
});

const listMock = vi.mocked(usersApi.list);
const statsMock = vi.mocked(usersApi.getStats);
const rolesMock = vi.mocked(usersApi.getRoleTemplates);
const tenantsMock = vi.mocked(tenantsApi.list);
const deactivateMock = vi.mocked(usersApi.deactivate);
const forceLogoutMock = vi.mocked(usersApi.forceLogout);

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    role: 'MODULE_USER',
    tenantId: 'tenant-1',
    tenantName: 'Ocean Farms',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as User;
}

function page<T>(
  rows: T[],
  limit: number,
): {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
} {
  return {
    data: rows,
    total: rows.length,
    page: 1,
    limit,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function stats(): UserStats {
  return {
    totalUsers: 4821,
    activeUsers: 4630,
    loginsLast24Hours: 912,
    newUsersLast30Days: 143,
  } as UserStats;
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UserManagementPage />
    </QueryClientProvider>,
  );
}

/**
 * The stat card carrying `label`.
 *
 * Scoped to the card's own label class: "Active" also appears as a status badge
 * on every active row, so a page-wide text match finds the table before the
 * card.
 */
function card(label: string): HTMLElement {
  const parent = screen.getByText(label, { selector: 'p.text-sm.text-gray-500' }).parentElement;
  if (!parent) throw new Error(`no card for ${label}`);
  return parent;
}

async function openDetails(): Promise<void> {
  const actor = userEvent.setup();
  await actor.click(await screen.findByRole('button', { name: 'Details' }));
}

describe('UserManagementPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(page([user()], 20));
    statsMock.mockResolvedValue(stats());
    rolesMock.mockResolvedValue([] as RoleTemplate[]);
    tenantsMock.mockResolvedValue(page([] as Tenant[], 100));
    deactivateMock.mockResolvedValue(user({ isActive: false }));
    forceLogoutMock.mockResolvedValue({ success: true, count: 3 });
  });

  it('forwards the abort signal to all four reads', async () => {
    renderPage();

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(statsMock).toHaveBeenCalled());
    expect(statsMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(rolesMock).toHaveBeenCalled());
    expect(rolesMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(tenantsMock).toHaveBeenCalled());
    expect(tenantsMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('refetches the STATS after a status change, not just the list', async () => {
    renderPage();
    await openDetails();

    const statsCallsBefore = statsMock.mock.calls.length;
    const actor = userEvent.setup();
    await actor.click(screen.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(deactivateMock).toHaveBeenCalledWith('user-1'));
    // The regression: this handler refreshed the table and left the four cards
    // showing the counts from before the change.
    await waitFor(() => expect(statsMock.mock.calls.length).toBeGreaterThan(statsCallsBefore));
  });

  it('reports how many sessions force-logout actually ended', async () => {
    renderPage();
    await openDetails();

    const actor = userEvent.setup();
    await actor.click(screen.getByRole('button', { name: 'Force Logout' }));

    expect(await screen.findByText(/Ended 3 sessions for this user\./)).toBeInTheDocument();
  });

  it('does not claim a logout the server refused', async () => {
    forceLogoutMock.mockResolvedValue({ success: false, count: 0 });
    renderPage();
    await openDetails();

    const actor = userEvent.setup();
    await actor.click(screen.getByRole('button', { name: 'Force Logout' }));

    // The regression: any 200 produced "User has been logged out of all
    // sessions." regardless of `success`.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('did not end');
    expect(screen.queryByText(/Ended \d+ session/)).not.toBeInTheDocument();
  });

  it("shows the server's user counts, not the listed page's", async () => {
    renderPage();

    await screen.findByText('4,821');
    expect(within(card('Total')).getByText('4,821')).toBeInTheDocument();
    expect(within(card('Active')).getByText('4,630')).toBeInTheDocument();
  });

  it('renders an em dash rather than a zero when the counts fail', async () => {
    statsMock.mockRejectedValue(new Error('user stats unavailable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('user stats unavailable');
    expect(within(card('Total')).getByText('—')).toBeInTheDocument();
  });

  it('names the failed read rather than showing an empty user list', async () => {
    listMock.mockRejectedValue(new Error('user directory is unreachable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('user directory is unreachable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
