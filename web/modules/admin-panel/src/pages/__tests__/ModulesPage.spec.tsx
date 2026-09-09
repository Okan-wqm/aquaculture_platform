/**
 * ModulesPage on the admin data layer (ADMIN-HIGH-121).
 *
 * Two defects the migration removed, both of which this spec pins:
 *
 *   1. **A write that refreshed half of what it changed.** Toggling a module
 *      called `refresh()`, which re-fetched the LIST — while the stats sat in
 *      a separate `useAsyncData` cache entry with its own TTL. So the "Active
 *      Modules" card kept the count from before the toggle, for up to a
 *      minute, on the same screen as the switch the operator had just
 *      flipped. `invalidateKeys` names both slices.
 *
 *   2. **Four stat cards that fell back to a page-scoped computation.**
 *      `stats?.totalModules ?? modules.length` looks like a safe default and
 *      is not: `modules` is the CURRENT PAGE, so a failed stats call turned
 *      "Total Modules" into a page count and "Total Assignments" into the sum
 *      over one page, both indistinguishable from the real figures. They
 *      render an em dash now, and the failure is reported.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import ModulesPage from '../ModulesPage';
import { modulesApi } from '../../services/adminApi';
import type { ModuleStats, PaginatedResult, SystemModule } from '../../services/types';
import { derivePaginationMetadataV1 } from '@platform/pagination-contracts';

vi.mock('../../services/adminApi', () => ({
  modulesApi: {
    list: vi.fn(),
    getStats: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
  },
}));

const listMock = vi.mocked(modulesApi.list);
const statsMock = vi.mocked(modulesApi.getStats);
const deactivateMock = vi.mocked(modulesApi.deactivate);

function systemModule(overrides: Partial<SystemModule> = {}): SystemModule {
  return {
    id: 'module-1',
    code: 'FARM_CORE',
    name: 'Farm Core',
    description: 'Core farm management',
    isActive: true,
    isCore: true,
    tenantsCount: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as SystemModule;
}

function modulePage(rows: SystemModule[]): PaginatedResult<SystemModule> {
  return { ...derivePaginationMetadataV1(rows.length, 1, 20), data: rows };
}

function moduleStats(): ModuleStats {
  return {
    totalModules: 42,
    activeModules: 31,
    coreModules: 7,
    totalAssignments: 118,
  } as ModuleStats;
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ModulesPage />
    </QueryClientProvider>,
  );
}

describe('ModulesPage on the admin data layer (ADMIN-HIGH-121)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(modulePage([systemModule()]));
    statsMock.mockResolvedValue(moduleStats());
    deactivateMock.mockResolvedValue(systemModule({ isActive: false }));
  });

  it('forwards the abort signal to both reads', async () => {
    renderPage();

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);

    await waitFor(() => expect(statsMock).toHaveBeenCalled());
    expect(statsMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('shows the server statistics, not a computation over the current page', async () => {
    renderPage();

    // 42 is the server total; the page holds ONE module. The old fallback
    // would have rendered 1 here and looked entirely plausible.
    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('118')).toBeInTheDocument();
  });

  it('renders an em dash, not a page count, when the statistics call fails', async () => {
    statsMock.mockRejectedValue(new Error('module statistics unavailable'));
    renderPage();

    // The failure is reported rather than papered over by the fallback…
    expect(await screen.findByText(/module statistics unavailable/)).toBeInTheDocument();
    // …and the four cards say "unknown" instead of a page-scoped count.
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it('invalidates the statistics as well as the list when a module is toggled', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Farm Core')).toBeInTheDocument();
    await waitFor(() => expect(statsMock).toHaveBeenCalledTimes(1));

    const toggle = screen.getAllByRole('button').find((button) => button.textContent === '');
    await user.click(toggle ?? screen.getAllByRole('button')[0]!);

    await waitFor(() => expect(deactivateMock).toHaveBeenCalledWith('module-1'));
    // The regression: the old handler re-fetched the list only, so the
    // "Active Modules" card kept its pre-toggle count until its own TTL.
    await waitFor(() => expect(statsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });
});
