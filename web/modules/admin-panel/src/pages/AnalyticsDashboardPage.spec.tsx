import '@testing-library/jest-dom/vitest';

import {
  createAnalyticsMetricSectionProjectionV1,
  type AnalyticsMetricSectionValuesV1,
} from '@aquaculture/shared-contracts';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { analyticsApi } from '../services/adminApi';
import { AdminApiError } from '../services/http-client';
import AnalyticsDashboardPage from './AnalyticsDashboardPage';

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    getAdminRoute: () => ({ path: '/admin/analytics/reports' }),
  };
});

vi.mock('../services/adminApi', () => ({
  analyticsApi: {
    getDashboardSummary: vi.fn(),
    getTenantGrowthTrend: vi.fn(),
    getRevenueTrend: vi.fn(),
    getUserActivity: vi.fn(),
  },
}));

const AS_OF = '2026-08-09T12:00:00.000Z';

const tenantValues: AnalyticsMetricSectionValuesV1<'tenants'> = {
  total: 12,
  active: 10,
  inactive: 2,
  trial: 1,
  suspended: 1,
  newThisMonth: 2,
  churnedThisMonth: null,
  churnRate: null,
  growthRate: null,
  byPlan: { starter: 4, professional: 4, enterprise: 3, trial: 1 },
  byRegion: null,
};

const userValues: AnalyticsMetricSectionValuesV1<'users'> = {
  total: 42,
  active: 40,
  inactive: 2,
  newThisMonth: 3,
  activeLastDay: 11,
  activeLastWeek: 25,
  activeLastMonth: 40,
  growthRate: null,
  avgUsersPerTenant: 3.5,
  byRole: { admin: 4, manager: 10, operator: 28 },
};

const financialValues: AnalyticsMetricSectionValuesV1<'financial'> = {
  mrr: 1250,
  arr: 15000,
  arpu: 125,
  arppu: 125,
  ltv: null,
  totalRevenue: 30000,
  revenueThisMonth: 1250,
  revenueGrowthRate: null,
  pendingPayments: 0,
  overduePayments: 25,
  refunds: 0,
  byPlan: { starter: 250, professional: 500, enterprise: 500 },
  byCurrency: null,
};

const systemValues: AnalyticsMetricSectionValuesV1<'system'> = {
  totalStorageBytes: null,
  usedStorageBytes: 4096,
  storageUtilization: null,
  apiCallsToday: null,
  apiCallsThisMonth: null,
  avgResponseTimeMs: null,
  errorRate: null,
  uptimePercent: null,
  activeConnections: 7,
  queuedJobs: null,
};

const usageValues: AnalyticsMetricSectionValuesV1<'usage'> = {
  moduleUsage: null,
  featureAdoption: null,
  topFeatures: null,
  peakHours: null,
  avgDailyActiveUsers: 11,
};

const dashboard = {
  tenants: createAnalyticsMetricSectionProjectionV1('tenants', tenantValues, AS_OF),
  users: createAnalyticsMetricSectionProjectionV1('users', userValues, AS_OF),
  financial: createAnalyticsMetricSectionProjectionV1('financial', financialValues, AS_OF),
  system: createAnalyticsMetricSectionProjectionV1('system', systemValues, AS_OF),
  usage: createAnalyticsMetricSectionProjectionV1('usage', usageValues, AS_OF),
  generatedAt: AS_OF,
};

const emptyTrend = {
  range: '30d' as const,
  granularity: 'day' as const,
  data: [],
  source: 'admin.analytics_snapshots',
  asOf: AS_OF,
};

function renderPage(): void {
  render(
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AnalyticsDashboardPage />
    </BrowserRouter>,
  );
}

describe('AnalyticsDashboardPage measurement authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(analyticsApi.getDashboardSummary).mockResolvedValue(dashboard);
    vi.mocked(analyticsApi.getTenantGrowthTrend).mockResolvedValue(emptyTrend);
    vi.mocked(analyticsApi.getRevenueTrend).mockResolvedValue(emptyTrend);
    vi.mocked(analyticsApi.getUserActivity).mockResolvedValue(emptyTrend);
  });

  afterEach(() => cleanup());

  it('renders a rejected dashboard read as rejected evidence, never zero metrics', async () => {
    vi.mocked(analyticsApi.getDashboardSummary).mockRejectedValueOnce(
      new AdminApiError(
        'Analytics catalog unavailable',
        503,
        'SERVICE_UNAVAILABLE',
        undefined,
        'request_analytics_123',
      ),
    );

    renderPage();

    expect(await screen.findByText('Analytics authority rejected the read')).toBeInTheDocument();
    expect(screen.getByText(/Analytics catalog unavailable/)).toHaveTextContent(
      'request request_analytics_123',
    );
    expect(screen.queryByText('Total Tenants')).not.toBeInTheDocument();
  });

  it('renders unavailable catalog metrics explicitly and preserves measured zero values', async () => {
    renderPage();

    expect(await screen.findByText('Analytics Dashboard')).toBeInTheDocument();
    expect(screen.getByText(/tenants.churnRate/)).toBeInTheDocument();
    expect(screen.getByText('tenants.byRegion authority is not integrated')).toBeInTheDocument();
    expect(screen.getByText('usage.moduleUsage authority is not integrated')).toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
    expect(screen.getByText('$0')).toBeInTheDocument();
  });

  it('keeps a rejected trend distinct from a verified empty snapshot range', async () => {
    vi.mocked(analyticsApi.getTenantGrowthTrend).mockRejectedValueOnce(
      new Error('Snapshot projection unavailable'),
    );

    renderPage();

    expect(
      await screen.findByText('Trend read rejected: Snapshot projection unavailable'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('No catalog-qualified snapshots in this range')).toHaveLength(2);
  });
});
