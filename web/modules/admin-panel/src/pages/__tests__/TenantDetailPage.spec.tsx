/**
 * TenantDetailPage on the admin data layer (ADMIN-HIGH-121), and two things
 * the old shape got wrong in opposite directions.
 *
 * 1. **A write here left every other page stale.** Seven handlers each ended in
 *    `fetchTenant()` — this page only. Suspending a tenant from the detail
 *    screen refreshed the detail screen and left TenantManagementPage's list
 *    and its four platform counts holding the pre-change state until something
 *    else happened to refetch them. `invalidateKeys: [adminKeys.tenants.all()]`
 *    makes one write correct wherever the domain is read.
 *
 * 2. **Four `?? 0` cards, two of them lying and two of them dead.**
 *    `farmCount` and `sensorCount` are REQUIRED by `TenantDetailDto`, so their
 *    `?? 0` was defensive code the compiler had already ruled out.
 *    `userStats` and `modules` are OPTIONAL — theirs rendered a field the
 *    server omitted as a measured zero, so a tenant whose user stats did not
 *    come back displayed "0 users".
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import TenantDetailPage from '../TenantDetailPage';
import { tenantsApi, modulesApi } from '../../services/adminApi';
import type { TenantDetail } from '../../services/adminApi';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ tenantId: 'tenant-1' }), useNavigate: () => vi.fn() };
});

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    tenantsApi: {
      getDetail: vi.fn(),
      update: vi.fn(),
      suspend: vi.fn(),
      activate: vi.fn(),
      createNote: vi.fn(),
      deleteNote: vi.fn(),
    },
    modulesApi: {
      list: vi.fn(),
      assignToTenant: vi.fn(),
      removeFromTenant: vi.fn(),
    },
  };
});

const detailMock = vi.mocked(tenantsApi.getDetail);
const modulesMock = vi.mocked(modulesApi.list);
const activateMock = vi.mocked(tenantsApi.activate);

function detail(overrides: Partial<TenantDetail> = {}): TenantDetail {
  return {
    id: 'tenant-1',
    name: 'Ocean Farms',
    slug: 'oceanfarms',
    tier: 'ENTERPRISE',
    status: 'SUSPENDED',
    farmCount: 12,
    sensorCount: 156,
    userStats: { total: 45, active: 41 },
    modules: [{ isActive: true }, { isActive: false }],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as TenantDetail;
}

function modulePage(): Awaited<ReturnType<typeof modulesApi.list>> {
  return {
    data: [],
    total: 0,
    page: 1,
    limit: 50,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TenantDetailPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The quick-stat card carrying `label`. */
function card(label: string): HTMLElement {
  const parent = screen.getByText(label, { selector: 'h4' }).parentElement;
  if (!parent) throw new Error(`no card for ${label}`);
  return parent;
}

describe('TenantDetailPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detailMock.mockResolvedValue(detail());
    modulesMock.mockResolvedValue(modulePage());
    activateMock.mockResolvedValue(detail({ status: 'ACTIVE' }));
  });

  it('forwards the abort signal to both reads', async () => {
    renderPage();

    await waitFor(() => expect(detailMock).toHaveBeenCalled());
    expect(detailMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(modulesMock).toHaveBeenCalled());
    expect(modulesMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('shows the counts the server sent', async () => {
    renderPage();

    await screen.findAllByText('Ocean Farms');
    expect(within(card('Users')).getByText('45')).toBeInTheDocument();
    expect(within(card('Farms')).getByText('12')).toBeInTheDocument();
    expect(within(card('Sensors')).getByText('156')).toBeInTheDocument();
    expect(within(card('Active Modules')).getByText('1')).toBeInTheDocument();
  });

  it('does not report an omitted optional field as a measured zero', async () => {
    detailMock.mockResolvedValue(detail({ userStats: undefined, modules: undefined }));
    renderPage();

    await screen.findAllByText('Ocean Farms');
    // The regression: `?? 0` rendered "0" here, which reads as a tenant with
    // no users and no modules rather than as a field that did not arrive.
    expect(within(card('Users')).getByText('—')).toBeInTheDocument();
    expect(within(card('Active Modules')).getByText('—')).toBeInTheDocument();
    // Required fields still show their number, with no defensive fallback.
    expect(within(card('Farms')).getByText('12')).toBeInTheDocument();
  });

  it('refetches the detail after a write', async () => {
    renderPage();
    await screen.findAllByText('Ocean Farms');

    const detailCallsBefore = detailMock.mock.calls.length;
    const actor = userEvent.setup();
    await actor.click(screen.getByRole('button', { name: 'Activate' }));

    await waitFor(() => expect(activateMock).toHaveBeenCalledWith('tenant-1'));
    await waitFor(() => expect(detailMock.mock.calls.length).toBeGreaterThan(detailCallsBefore));
  });

  it('names a refused write instead of leaving the page unchanged', async () => {
    activateMock.mockRejectedValue(new Error('tenant is under a legal hold'));
    renderPage();
    await screen.findAllByText('Ocean Farms');

    const actor = userEvent.setup();
    await actor.click(screen.getByRole('button', { name: 'Activate' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((node) => node.textContent?.includes('legal hold'))).toBe(true);
  });

  it('names the failed read rather than claiming the tenant does not exist', async () => {
    detailMock.mockRejectedValue(new Error('tenant detail is unreachable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('tenant detail is unreachable');
    // The regression: `error || !tenant` rendered "Tenant not found" for a
    // read that failed, which is a different claim entirely.
    expect(screen.queryByText('Tenant not found')).not.toBeInTheDocument();
  });
});
