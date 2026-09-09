/**
 * MaintenancePage on the admin data layer (ADMIN-HIGH-121), and the operational
 * record it wrote from the operator's browser clock (ADMIN-HIGH-129).
 *
 * Every action discarded the updated window the endpoint returns and invented
 * its own:
 *
 *     await systemSettingsApi.startMaintenance(maintenance.id);
 *     setMaintenanceList(list.map((m) => m.id === maintenance.id
 *       ? { ...m, status: 'in_progress', actualStart: new Date().toISOString() }
 *       : m));
 *
 * `actualStart` and `actualEnd` are the record of when the platform went into
 * maintenance and came out. They were being filled in from the browser, for a
 * transition the server may have performed at a different moment — or, on a
 * 200 that did not change the status, not performed at all. Extend was worse
 * still: it recomputed `scheduledEnd` and added to `estimatedDurationMinutes`
 * locally, so the window's own duration drifted with each click.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import { MaintenancePage } from '../MaintenancePage';
import { systemSettingsApi } from '../../../services/adminApi';
import type { MaintenanceWindow } from '../../../services/types';

vi.mock('../../../services/adminApi', () => ({
  systemSettingsApi: {
    getMaintenanceWindows: vi.fn(),
    createMaintenanceWindow: vi.fn(),
    startMaintenance: vi.fn(),
    endMaintenance: vi.fn(),
    extendMaintenance: vi.fn(),
    cancelMaintenance: vi.fn(),
  },
}));

const listMock = vi.mocked(systemSettingsApi.getMaintenanceWindows);
const startMock = vi.mocked(systemSettingsApi.startMaintenance);

function window_(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: 'window-1',
    title: 'Postgres major upgrade',
    description: 'Upgrade the primary to 17',
    scope: 'global',
    type: 'database_migration',
    status: 'scheduled',
    scheduledStart: '2026-09-10T01:00:00.000Z',
    scheduledEnd: '2026-09-10T03:00:00.000Z',
    estimatedDurationMinutes: 120,
    allowReadOnlyAccess: false,
    bypassForSuperAdmins: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function page(rows: MaintenanceWindow[]) {
  return {
    data: rows,
    total: rows.length,
    page: 1,
    limit: 20,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MaintenancePage />
    </QueryClientProvider>,
  );
}

describe('MaintenancePage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    listMock.mockResolvedValue(page([window_()]));
    startMock.mockResolvedValue(window_({ status: 'in_progress' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards the abort signal to the read', async () => {
    renderPage();

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('re-reads the window after starting instead of stamping actualStart locally', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Postgres major upgrade');
    await user.click(screen.getByRole('button', { name: 'Start Now' }));

    await waitFor(() => expect(startMock).toHaveBeenCalledWith('window-1'));
    // The regression: `actualStart: new Date().toISOString()` from the
    // operator's browser, written into the platform's record of when
    // maintenance actually began.
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('reports a rejected start rather than showing the window as started', async () => {
    const user = userEvent.setup();
    startMock.mockRejectedValue(new Error('maintenance service unavailable'));
    renderPage();

    await screen.findByText('Postgres major upgrade');
    await user.click(screen.getByRole('button', { name: 'Start Now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('maintenance service unavailable');
  });

  it('reports a failed read instead of an empty schedule', async () => {
    listMock.mockRejectedValue(new Error('maintenance windows unavailable'));
    renderPage();

    // An empty schedule reads as "no maintenance planned", which is a
    // different fact from "the schedule did not load".
    expect(await screen.findByRole('alert')).toHaveTextContent('maintenance windows unavailable');
  });
});
