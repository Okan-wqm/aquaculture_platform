/**
 * AnalyticsDashboardPage on the admin data layer (ADMIN-HIGH-121), and the
 * forty zeros it rendered as measurements (ADMIN-HIGH-125).
 *
 * `getDefaultData()` built a complete dashboard of zeros — MRR, ARR, LTV,
 * churn rate, uptime — and the page rendered it whenever `/analytics/dashboard`
 * failed, with no banner of any kind, because the only `catch` also swallowed
 * the failure. A platform whose billing source was unreachable displayed
 * "$0 MRR", "0% churn" and "0% uptime" as facts.
 *
 * The endpoint degrades per section too: `unavailable: ['financial']` means the
 * SERVER substituted its own zeros for that section. The page now treats a
 * named section as unknown, so that signal is load-bearing rather than a line
 * of small print above the zeros it describes.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import AnalyticsDashboardPage from '../AnalyticsDashboardPage';
import { analyticsApi, systemApi } from '../../services/adminApi';

vi.mock('../../services/adminApi', () => ({
  analyticsApi: {
    getDashboardSummary: vi.fn(),
    getTenantGrowthTrend: vi.fn(),
    getRevenueTrend: vi.fn(),
    getUserActivity: vi.fn(),
  },
  systemApi: { getServicesHealth: vi.fn() },
}));

const summaryMock = vi.mocked(analyticsApi.getDashboardSummary);
const tenantTrendMock = vi.mocked(analyticsApi.getTenantGrowthTrend);
const revenueTrendMock = vi.mocked(analyticsApi.getRevenueTrend);
const userActivityMock = vi.mocked(analyticsApi.getUserActivity);
const servicesMock = vi.mocked(systemApi.getServicesHealth);

function summary(overrides: Record<string, unknown> = {}): ReturnType<typeof buildSummary> {
  return { ...buildSummary(), ...overrides } as ReturnType<typeof buildSummary>;
}

function buildSummary() {
  return {
    tenants: {
      total: 18,
      active: 17,
      inactive: 1,
      trial: 2,
      suspended: 0,
      newThisMonth: 3,
      churnedThisMonth: 1,
      churnRate: 5.5,
      growthRate: 12.5,
      byPlan: { enterprise: 4, professional: 9, starter: 5, trial: 2 },
      byRegion: { eu: 12, us: 6 },
    },
    users: {
      total: 640,
      active: 600,
      inactive: 40,
      newThisMonth: 64,
      activeLastDay: 231,
      activeLastWeek: 480,
      activeLastMonth: 590,
      growthRate: 8.2,
      avgUsersPerTenant: 36,
      byRole: { SUPER_ADMIN: 3, TENANT_ADMIN: 18, OPERATOR: 619 },
    },
    financial: {
      mrr: 48250,
      arr: 579000,
      arpu: 75,
      arppu: 90,
      ltv: 2400,
      totalRevenue: 1200000,
      revenueThisMonth: 48250,
      revenueGrowthRate: 4.4,
      pendingPayments: 3200,
      overduePayments: 900,
      refunds: 150,
      byPlan: { starter: 5000, professional: 18250, enterprise: 25000 },
      byCurrency: { USD: 48250 },
    },
    system: {
      totalStorageBytes: 1024 ** 4,
      usedStorageBytes: 512 * 1024 ** 3,
      storageUtilization: 50,
      apiCallsToday: 152340,
      apiCallsThisMonth: 4100000,
      avgResponseTimeMs: 84,
      errorRate: 0.12,
      uptimePercent: 0,
      activeConnections: 42,
      queuedJobs: 7,
    },
    usage: {
      moduleUsage: {},
      featureAdoption: {},
      topFeatures: [],
      peakHours: [],
      avgDailyActiveUsers: 220,
    },
    generatedAt: '2026-09-09T00:00:00.000Z',
  };
}

const EMPTY_SERIES = {
  range: '30d' as const,
  granularity: 'day' as const,
  data: [] as Array<{ date: string; value: number }>,
  source: 'analytics',
  asOf: '2026-09-09T00:00:00.000Z',
};

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AnalyticsDashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AnalyticsDashboardPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    summaryMock.mockResolvedValue(summary());
    servicesMock.mockResolvedValue([
      { name: 'auth-service', status: 'healthy', lastCheck: '2026-09-09T00:00:00.000Z' },
      { name: 'billing-service', status: 'unhealthy', lastCheck: '2026-09-09T00:00:00.000Z' },
    ]);
    tenantTrendMock.mockResolvedValue(EMPTY_SERIES);
    revenueTrendMock.mockResolvedValue(EMPTY_SERIES);
    userActivityMock.mockResolvedValue(EMPTY_SERIES);
  });

  it('forwards the abort signal to every read', async () => {
    renderPage();

    await waitFor(() => expect(summaryMock).toHaveBeenCalled());
    expect(summaryMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(servicesMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(tenantTrendMock.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(revenueTrendMock.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(userActivityMock.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });

  it('renders the measured figures', async () => {
    renderPage();

    expect(await screen.findByText('$48,250')).toBeInTheDocument();
    expect(screen.getByText('5.5%')).toBeInTheDocument();
    // Uptime is the share of services reporting healthy: 1 of 2.
    expect(screen.getAllByText('50%').length).toBeGreaterThan(0);
  });

  it('reports the failure instead of rendering a zero-filled dashboard', async () => {
    summaryMock.mockRejectedValue(new Error('analytics dashboard unavailable'));
    renderPage();

    // The regression: $0 MRR, 0% churn, 0% uptime, and no banner at all.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('analytics dashboard unavailable');
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('treats a section the server could not compute as unknown, not as its zeros', async () => {
    summaryMock.mockResolvedValue(summary({ unavailable: ['financial'] }));
    renderPage();

    // The tenant section still answered…
    expect(await screen.findByText('5.5%')).toBeInTheDocument();
    // …while every financial card reads unknown rather than the server's
    // substituted zeros, and the page says which section that is.
    expect(screen.queryByText('$48,250')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toHaveTextContent('financial');
  });

  it('keeps the dashboard when only a trend series fails', async () => {
    revenueTrendMock.mockRejectedValue(new Error('revenue trend unavailable'));
    renderPage();

    expect(await screen.findByText('$48,250')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('revenue trend unavailable');
  });
});
