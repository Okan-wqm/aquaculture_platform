/**
 * APA-134 — a KPI card's arrow must agree with its own number.
 * APA-136 — a failed load must render an error, not a dashboard of zeros.
 *
 * APA-134: `KpiCard` took `change` (magnitude) and `trend` (arrow + colour) as
 * two INDEPENDENT props and rendered `Math.abs(change)`, so the direction shown
 * and the number shown could contradict each other by construction. Three cards
 * hardcoded `trend="up"` regardless of sign, so a negative growth rate rendered
 * as a GREEN UP-ARROW over an absolute value; the churn card passed a literal
 * `change={-0.5}` backed by no field anywhere in the contract. The two chart
 * footers hardcoded both the '+' sign and the green class, so -3.2% rendered as
 * a green "+-3.2%". The cure is the prop shape, not the call sites: direction
 * is now derived from the delta, and the metric's polarity travels with it so a
 * bad-direction metric cannot inherit "up = green".
 *
 * APA-136: the page had no failure state. Every failure path substituted an
 * all-zero `getDefaultData()`, and because the requests go through
 * `Promise.allSettled` a rejected summary was not an exception but a settled
 * value the code ignored — so an auth failure, a 500 or a network outage
 * rendered a complete, confident dashboard reading 0 tenants and $0 MRR,
 * indistinguishable from a healthy platform with no customers.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-134
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-136
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

function renderPage(): void {
  render(
    <BrowserRouter>
      <AnalyticsDashboardPage />
    </BrowserRouter>,
  );
}

describe('AnalyticsDashboardPage KPI deltas (APA-134)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getTenantGrowthTrend.mockResolvedValue({ data: [] });
    api.getRevenueTrend.mockResolvedValue({ data: [] });
    api.getUserActivity.mockResolvedValue({ data: [] });
  });

  it('renders a negative delta with a down arrow, never a green up-arrow', async () => {
    const summary = dashboardSummaryFixture();
    summary.financial.revenueGrowthRate = -3.2;
    summary.users.growthRate = -1.5;
    api.getDashboardSummary.mockResolvedValue(summary);

    renderPage();
    await waitFor(() => expect(api.getDashboardSummary).toHaveBeenCalled());

    // The magnitude is still absolute, but the glyph now carries the sign.
    const down = await screen.findAllByText(/↓/);
    expect(down.length).toBeGreaterThan(0);
    expect(screen.queryByText(/↑/)).not.toBeInTheDocument();

    // The chart footer must not print a green "+-3.2%".
    expect(document.body.textContent).not.toMatch(/\+-/);
  });

  it('colours a fall in revenue red and a rise green, from the same input', async () => {
    const falling = dashboardSummaryFixture();
    falling.financial.revenueGrowthRate = -3.2;
    falling.users.growthRate = 2.0;
    api.getDashboardSummary.mockResolvedValue(falling);

    renderPage();
    await waitFor(() => expect(api.getDashboardSummary).toHaveBeenCalled());

    // Both an up and a down indicator coexist, driven by their own numbers —
    // impossible while every card hardcoded trend="up".
    expect(await screen.findAllByText(/↓/)).toHaveLength(1);
    expect(screen.getAllByText(/↑/)).toHaveLength(1);
  });

  it('shows no delta at all when there is no baseline to compare against', async () => {
    const summary = dashboardSummaryFixture();
    summary.financial.revenueGrowthRate = null;
    summary.users.growthRate = 0;
    api.getDashboardSummary.mockResolvedValue(summary);

    renderPage();
    await waitFor(() => expect(api.getDashboardSummary).toHaveBeenCalled());

    // A null delta prints nothing — not "0.0%", which claims a measured
    // no-change against a baseline that was never taken.
    await screen.findByText(/Analytics Dashboard/);
    expect(document.body.textContent).not.toMatch(/\bnull\b/);
    // tenants.growthRate and financial.revenueGrowthRate are both null here, so
    // the only delta line is the users' flat 0.0%.
    expect(screen.getAllByText(/vs previous snapshot/)).toHaveLength(1);
  });
});

describe('AnalyticsDashboardPage load failure (APA-136)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getTenantGrowthTrend.mockResolvedValue({ data: [] });
    api.getRevenueTrend.mockResolvedValue({ data: [] });
    api.getUserActivity.mockResolvedValue({ data: [] });
  });

  it('renders an error instead of a confident dashboard of zeros', async () => {
    api.getDashboardSummary.mockRejectedValue(new Error('Request failed with status 500'));

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be loaded/i);
    expect(alert).toHaveTextContent(/500/);

    // The tell-tale zeros of the retired getDefaultData() literal must be gone:
    // no KPI cards at all render on the failure path.
    expect(screen.queryByText('Total Tenants')).not.toBeInTheDocument();
    expect(screen.queryByText('MRR')).not.toBeInTheDocument();
  });

  it('offers a Retry that re-issues the request and recovers', async () => {
    api.getDashboardSummary.mockRejectedValueOnce(new Error('network down'));
    api.getDashboardSummary.mockResolvedValueOnce(dashboardSummaryFixture());

    renderPage();

    const retry = await screen.findByRole('button', { name: /retry/i });
    await userEvent.click(retry);

    expect(await screen.findByText('Total Tenants')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.getDashboardSummary).toHaveBeenCalledTimes(2);
  });

  it('does not claim a failure when only a secondary trend fails', async () => {
    api.getDashboardSummary.mockResolvedValue(dashboardSummaryFixture());
    api.getRevenueTrend.mockRejectedValue(new Error('trend unavailable'));

    renderPage();

    // The summary IS the page; an empty trend series is a legitimate result and
    // must not blank out a dashboard whose numbers loaded fine.
    expect(await screen.findByText('Total Tenants')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
