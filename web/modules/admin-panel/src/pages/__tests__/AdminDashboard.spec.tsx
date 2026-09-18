/**
 * AdminDashboard on the admin data layer (ADMIN-HIGH-121), and the zeros the
 * platform's landing page reported when its reads failed (ADMIN-HIGH-124).
 *
 * The page fetched five endpoints with `Promise.allSettled`, mapped every
 * rejection to `null`, and then wrote:
 *
 *     // Calculate metrics with fallbacks
 *     const platformMetrics = metrics?.platform || {
 *       totalTenants: 0, activeTenants: 0, totalUsers: 0,
 *       eventsLast24h: 0, apiCallsLast24h: 0,
 *     };
 *
 * The only `setError` call sat in a `catch` that `allSettled` can never reach,
 * so a failed `/system/metrics` produced a SUPER_ADMIN dashboard reporting zero
 * tenants, zero users and zero API calls in the last 24 hours, with nothing on
 * screen to say a request had failed. This spec pins the two halves of the fix:
 * the cards say "unknown", and the failure is named.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import AdminDashboard from '../AdminDashboard';
import { systemApi, usersApi, auditApi } from '../../services/adminApi';
import type {
  CircuitBreakerStatus,
  ServiceHealth,
  SystemMetrics,
  UserStats,
} from '../../services/types';

vi.mock('../../services/adminApi', () => ({
  systemApi: {
    getMetrics: vi.fn(),
    getServicesHealth: vi.fn(),
    getCircuitBreakers: vi.fn(),
    resetCircuitBreaker: vi.fn(),
  },
  usersApi: { getStats: vi.fn() },
  auditApi: { query: vi.fn() },
}));

const metricsMock = vi.mocked(systemApi.getMetrics);
const servicesMock = vi.mocked(systemApi.getServicesHealth);
const breakersMock = vi.mocked(systemApi.getCircuitBreakers);
const resetMock = vi.mocked(systemApi.resetCircuitBreaker);
const statsMock = vi.mocked(usersApi.getStats);
const auditMock = vi.mocked(auditApi.query);

function systemMetrics(platform: Partial<SystemMetrics['platform']> = {}): SystemMetrics {
  return {
    timestamp: '2026-09-09T00:00:00.000Z',
    database: {
      totalConnections: 20,
      activeConnections: 4,
      idleConnections: 16,
      databaseSize: '2 GB',
      tablesCount: 412,
    },
    platform: {
      totalTenants: 18,
      activeTenants: 17,
      totalUsers: 640,
      totalFarms: 52,
      totalSensors: 1200,
      activeSensors: 1180,
      totalAlertRules: 90,
      activeAlertRules: 84,
      eventsLast24h: 9100,
      apiCallsLast24h: 152340,
      ...platform,
    },
    resources: {
      memoryUsage: { heapUsed: 1, heapTotal: 2, rss: 3 },
      cpuUsage: { user: 1, system: 1 },
      uptime: 1000,
      nodeVersion: 'v22.0.0',
      platform: 'linux',
    },
  };
}

function userStats(): UserStats {
  return {
    totalUsers: 640,
    activeUsers: 600,
    inactiveUsers: 40,
    usersByRole: [],
    usersByTenant: [],
    newUsersLast30Days: 64,
    loginsLast24Hours: 231,
  };
}

const SERVICES: ServiceHealth[] = [
  { name: 'auth-service', status: 'healthy', lastCheck: '2026-09-09T00:00:00.000Z' },
];

const OPEN_BREAKER: CircuitBreakerStatus = {
  stripe: { state: 'open', consecutiveFailures: 5, lastFailureTime: 0 },
};

function emptyAuditPage(): {
  data: [];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
} {
  return {
    data: [],
    total: 0,
    page: 1,
    limit: 10,
    totalPages: 0,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function renderDashboard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The MetricCard whose label is `title`, so a value assertion cannot drift. */
function card(title: string): HTMLElement {
  return screen.getByText(title).closest('div[class*="rounded"]') as HTMLElement;
}

describe('AdminDashboard on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metricsMock.mockResolvedValue(systemMetrics());
    statsMock.mockResolvedValue(userStats());
    servicesMock.mockResolvedValue(SERVICES);
    breakersMock.mockResolvedValue(OPEN_BREAKER);
    auditMock.mockResolvedValue(emptyAuditPage());
    resetMock.mockResolvedValue({ success: true, name: 'stripe', state: 'closed' });
  });

  it('forwards the abort signal to all five reads', async () => {
    renderDashboard();

    await waitFor(() => expect(metricsMock).toHaveBeenCalled());
    // The old page built an AbortController and passed it to nothing: the
    // methods took no signal, so "aborting" only discarded a completed fetch.
    expect(metricsMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(statsMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(servicesMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(breakersMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(auditMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('renders the measured figures', async () => {
    renderDashboard();

    expect(await within(card('Total Users')).findByText('640')).toBeInTheDocument();
    expect(within(card('Active Tenants')).getByText('17/18')).toBeInTheDocument();
    expect(within(card('API Calls (24h)')).getByText('152.340')).toBeInTheDocument();
  });

  it('says unknown, not zero, when the platform metrics do not answer', async () => {
    metricsMock.mockRejectedValue(new Error('system metrics unavailable'));
    statsMock.mockRejectedValue(new Error('user statistics unavailable'));
    renderDashboard();

    // The regression: these read "0", "—" and "0" respectively, and the page
    // said nothing about the two failed requests behind them.
    await waitFor(() => expect(within(card('Total Users')).getByText('—')).toBeInTheDocument());
    expect(within(card('Active Tenants')).getByText('—')).toBeInTheDocument();
    expect(within(card('API Calls (24h)')).getByText('—')).toBeInTheDocument();
    expect(within(card('Logins (Last 24h)')).getByText('—')).toBeInTheDocument();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('system metrics unavailable');
    expect(alert).toHaveTextContent('user statistics unavailable');
  });

  it('still reports a genuine zero as zero', async () => {
    // The previous guard printed a dash when activeTenants AND totalTenants
    // were both 0, so a platform that really had no tenants looked like a
    // failed read. What matters is whether the request answered.
    metricsMock.mockResolvedValue(systemMetrics({ totalTenants: 0, activeTenants: 0 }));
    renderDashboard();

    expect(await within(card('Active Tenants')).findByText('0/0')).toBeInTheDocument();
  });

  it('keeps the rest of the dashboard when one read fails', async () => {
    servicesMock.mockRejectedValue(new Error('service health unavailable'));
    renderDashboard();

    expect(await within(card('Total Users')).findByText('640')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('service health unavailable');
  });

  it('invalidates the breaker slice, and only that slice, after a reset', async () => {
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole('button', { name: 'Reset' }));

    await waitFor(() => expect(resetMock).toHaveBeenCalledWith('stripe'));
    // Re-read: the breakers. Not re-read: the four slices a breaker reset
    // cannot have changed — the old handler refetched by hand and wrote its
    // failure into the same banner the page used for read errors.
    await waitFor(() => expect(breakersMock).toHaveBeenCalledTimes(2));
    expect(metricsMock).toHaveBeenCalledTimes(1);
    expect(statsMock).toHaveBeenCalledTimes(1);
  });
});
