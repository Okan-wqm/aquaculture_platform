/**
 * PerformanceDashboardPage on the admin data layer (ADMIN-HIGH-121) and the
 * three claims it used to make without evidence (ADMIN-HIGH-123).
 *
 *   1. **A time-range selector that changed nothing.** The page sent
 *      `?start=…&end=…` to an endpoint whose parameters are `startDate` and
 *      `endDate`. An unknown query parameter is not an error — it is ignored —
 *      so all five options returned the server's default last hour, and the
 *      chart under the "Son 24 Saat" label showed one hour of data.
 *
 *   2. **A health score of 100 assembled from nothing.** The headline figure
 *      read `currentSnapshot.overallHealthScore ?? 100`, so a platform that had
 *      never taken a snapshot reported perfect system health. The server now
 *      sends `null` when it has nothing to score, and the page renders it.
 *
 *   3. **One failure blanking three reads.** `Promise.all` meant an unreachable
 *      infrastructure probe discarded a dashboard that had answered, under a
 *      single sentence that did not say which read had failed.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { PerformanceDashboardPage } from '../PerformanceDashboardPage';
import { systemSettingsApi } from '../../../services/adminApi';
import type {
  DatabasePerformance,
  InfrastructureMetrics,
  PerformanceDashboard,
} from '../../../services/types';

vi.mock('../../../services/adminApi', () => ({
  systemSettingsApi: {
    getPerformanceDashboard: vi.fn(),
    getInfrastructureMetrics: vi.fn(),
    getDatabasePerformance: vi.fn(),
  },
}));

const dashboardMock = vi.mocked(systemSettingsApi.getPerformanceDashboard);
const infraMock = vi.mocked(systemSettingsApi.getInfrastructureMetrics);
const databaseMock = vi.mocked(systemSettingsApi.getDatabasePerformance);

function dashboard(overrides: Partial<PerformanceDashboard> = {}): PerformanceDashboard {
  return {
    currentSnapshot: {
      id: 'snapshot-1',
      timestamp: '2026-09-08T12:00:00.000Z',
      applicationMetrics: {
        avgResponseTime: 142,
        p95ResponseTime: 310,
        p99ResponseTime: 520,
        throughput: 1200,
        errorRate: 0.42,
        apdexScore: 0.94,
        activeRequests: 8,
        totalRequests: 90210,
      },
      databaseMetrics: databaseMetrics(),
      infrastructureMetrics: infrastructure(),
      overallHealthScore: 88,
    },
    healthScore: 88,
    trends: { responseTime: [], throughput: [], errorRate: [], cpuUsage: [], memoryUsage: [] },
    serviceBreakdown: [],
    alerts: [],
    ...overrides,
  };
}

function infrastructure(overrides: Partial<InfrastructureMetrics> = {}): InfrastructureMetrics {
  return {
    cpuUsage: 37,
    memoryUsage: 61,
    memoryTotal: 16 * 1024 ** 3,
    diskUsage: 44,
    diskTotal: 512 * 1024 ** 3,
    networkLatency: 12,
    containerCount: 10,
    healthyContainers: 9,
    podRestarts: null,
    ...overrides,
  };
}

function databaseMetrics(overrides: Partial<DatabasePerformance> = {}): DatabasePerformance {
  return {
    activeConnections: 12,
    poolSize: 40,
    poolUtilization: 30,
    avgQueryTime: 3.2,
    slowQueryCount: 1,
    cacheHitRatio: 99.1,
    deadlockCount: 0,
    ...overrides,
  };
}

function renderPage(): { container: HTMLElement } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <PerformanceDashboardPage />
    </QueryClientProvider>,
  );
  return { container };
}

/** The headline "x/100" figure, which is the only `.text-5xl` on the page. */
function healthScoreText(container: HTMLElement): string {
  return container.querySelector('.text-5xl')?.textContent ?? '';
}

describe('PerformanceDashboardPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dashboardMock.mockResolvedValue(dashboard());
    infraMock.mockResolvedValue(infrastructure());
    databaseMock.mockResolvedValue(databaseMetrics());
  });

  it('forwards the abort signal to all three reads', async () => {
    renderPage();

    await waitFor(() => expect(dashboardMock).toHaveBeenCalled());
    expect(dashboardMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);

    await waitFor(() => expect(infraMock).toHaveBeenCalled());
    expect(infraMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);

    await waitFor(() => expect(databaseMock).toHaveBeenCalled());
    expect(databaseMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('sends the selected window under the parameter names the endpoint declares', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('142 ms');
    await waitFor(() => expect(dashboardMock).toHaveBeenCalledTimes(1));
    const [firstQuery] = dashboardMock.mock.calls[0] ?? [];
    // `start`/`end` were silently dropped by the server; these are the names in
    // `PerformanceController_getPerformanceDashboard`.
    expect(Object.keys(firstQuery ?? {}).sort()).toEqual(['endDate', 'startDate']);

    await user.selectOptions(screen.getByLabelText('Time range'), '24h');

    await waitFor(() => expect(dashboardMock).toHaveBeenCalledTimes(2));
    const [secondQuery] = dashboardMock.mock.calls[1] ?? [];
    const span = (query: { startDate?: string; endDate?: string } | undefined): number =>
      new Date(query?.endDate ?? 0).getTime() - new Date(query?.startDate ?? 0).getTime();

    // The selection reaches the request: 24 hours, not the hour every option
    // used to produce.
    expect(span(secondQuery)).toBe(24 * 60 * 60 * 1000);
    expect(span(firstQuery)).toBe(60 * 60 * 1000);
  });

  it('shows the score the server computed', async () => {
    const { container } = renderPage();

    await waitFor(() => expect(healthScoreText(container)).toBe('88'));
  });

  it('renders an em dash, not 100, when the server has nothing to score', async () => {
    dashboardMock.mockResolvedValue(dashboard({ currentSnapshot: null, healthScore: null }));
    const { container } = renderPage();

    // The regression: `?? 100` here meant a platform with no snapshot at all
    // reported perfect health on its own performance dashboard.
    await waitFor(() => expect(healthScoreText(container)).toBe('—'));
    expect(container.querySelector('.text-5xl')).not.toHaveTextContent('100');
  });

  it('keeps the dashboard on screen when only the infrastructure probe fails', async () => {
    infraMock.mockRejectedValue(new Error('infrastructure probe unavailable'));
    renderPage();

    // The dashboard's own figures survive…
    expect(await screen.findByText('142 ms')).toBeInTheDocument();
    // …the failure is named rather than reduced to one generic sentence…
    expect(await screen.findByRole('alert')).toHaveTextContent('infrastructure probe unavailable');
    // …and the CPU card says unknown instead of the 0% it used to seed.
    const cpuCard = screen.getByText('CPU kullanimi').parentElement as HTMLElement;
    expect(within(cpuCard).getByText('—')).toBeInTheDocument();
  });

  it('takes over the page only when nothing answered', async () => {
    dashboardMock.mockRejectedValue(new Error('dashboard unavailable'));
    infraMock.mockRejectedValue(new Error('infrastructure unavailable'));
    databaseMock.mockRejectedValue(new Error('database unavailable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('dashboard unavailable');
    expect(alert).toHaveTextContent('infrastructure unavailable');
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
