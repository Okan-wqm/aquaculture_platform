/**
 * APA-137 — the range control must not claim a scope the system never applies.
 *
 * The 7d/30d/90d/1y selector sat in the PAGE header, and its state was a
 * dependency of `loadData`, which refetches `getDashboardSummary()` alongside
 * the three trend series. But the summary endpoint is range-unaware — it takes
 * no arguments, and every windowed KPI is hardcoded month-to-date SQL. So
 * changing the range spun the whole page and returned byte-identical KPIs,
 * which reads to an operator as "the range was applied and nothing moved".
 *
 * The control is not fake — it genuinely drives three charts. Its PLACEMENT was
 * the lie. It now sits with the trends it re-fetches, and the KPI block states
 * the window it actually reports.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-137
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import AnalyticsDashboardPage from '../AnalyticsDashboardPage';
import { analyticsApi } from '../../services/adminApi';
import { dashboardSummaryFixture } from './fixtures/dashboardSummary';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    analyticsApi: {
      ...actual.analyticsApi,
      getDashboardSummary: vi.fn(),
      getTenantGrowthTrend: vi.fn(),
      getRevenueTrend: vi.fn(),
      getUserActivity: vi.fn(),
    },
  };
});

const api = vi.mocked(analyticsApi);

describe('AnalyticsDashboardPage range scope (APA-137)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDashboardSummary.mockResolvedValue(dashboardSummaryFixture());
    api.getTenantGrowthTrend.mockResolvedValue({ data: [] });
    api.getRevenueTrend.mockResolvedValue({ data: [] });
    api.getUserActivity.mockResolvedValue({ data: [] });

    render(
      <BrowserRouter>
        <AnalyticsDashboardPage />
      </BrowserRouter>,
    );
  });

  it('scopes the range control to the trends it actually drives', async () => {
    await screen.findByText('Total Tenants');

    // The control is labelled as a trend range, not a page-wide filter.
    const group = screen.getByRole('group', { name: /trend range/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument();
  });

  it('states the window the KPI block actually reports', async () => {
    // Without this the operator has no way to know the totals ignore the range.
    expect(await screen.findByText(/as of now; rates are month to date/i)).toBeInTheDocument();
  });

  it('re-fetches the trends when the range changes', async () => {
    await screen.findByText('Total Tenants');
    const before = api.getTenantGrowthTrend.mock.calls.length;

    await userEvent.click(screen.getByRole('button', { name: '7d' }));

    await waitFor(() =>
      expect(api.getTenantGrowthTrend.mock.calls.length).toBeGreaterThan(before),
    );
    expect(api.getTenantGrowthTrend).toHaveBeenLastCalledWith('7d', 'day');
  });

  it('maps each range to the granularity the backend expects', async () => {
    await screen.findByText('Total Tenants');

    await userEvent.click(screen.getByRole('button', { name: '90d' }));
    await waitFor(() => expect(api.getRevenueTrend).toHaveBeenLastCalledWith('90d', 'week'));

    await userEvent.click(screen.getByRole('button', { name: '1y' }));
    await waitFor(() => expect(api.getRevenueTrend).toHaveBeenLastCalledWith('1y', 'month'));
  });
});
