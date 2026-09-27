/**
 * The metered-usage dashboard's four reads, and the three that threw their
 * errors away.
 *
 * Only the summary read destructured an `error`. The other three — tenants,
 * trends, top-tenants — discarded theirs, and each rendered its failure as an
 * empty result:
 *
 *   - "No usage data for this period"
 *   - "No tenant usage data for this meter type"
 *   - "No tenant usage data available"
 *
 * On a metered-billing surface those are claims about consumption, and
 * consumption is what the invoice is built from. An unanswered request is not
 * zero usage.
 *
 * A second, smaller defect on the same page: the button labelled "Refresh Data"
 * called `refreshSummary`, so it refreshed one of the four reads and left the
 * other three showing whatever they already held.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import UsageDashboardPage from '../UsageDashboardPage';
import { billingApi } from '../../services/adminApi';
import type { UsageSummaryStats } from '../../services/types/billing';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    billingApi: {
      getUsageSummary: vi.fn(),
      getAllTenantsUsage: vi.fn(),
      getUsageTrends: vi.fn(),
      getTopTenantsByUsage: vi.fn(),
    },
  };
});

const summary = vi.mocked(billingApi.getUsageSummary);
const tenants = vi.mocked(billingApi.getAllTenantsUsage);
const trends = vi.mocked(billingApi.getUsageTrends);
const topTenants = vi.mocked(billingApi.getTopTenantsByUsage);

/**
 * The summary as the contract declares it — written out, not cast. The first
 * draft of this fixture invented a `meters` field and cast the object; vitest
 * does not type-check and the cast silenced tsc, so the page crashed on
 * `summary.meterBreakdown.length` instead. A cast in a fixture is the bug.
 */
function summaryFixture(): UsageSummaryStats {
  return {
    totalTenants: 4,
    totalEvents: 1000,
    meterBreakdown: [],
    periodCovered: { from: '2026-09-01', to: '2026-09-30' },
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <UsageDashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UsageDashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    summary.mockResolvedValue(summaryFixture());
    tenants.mockResolvedValue({ tenants: [], total: 0 });
    trends.mockResolvedValue([]);
    topTenants.mockResolvedValue([]);
  });

  it('names a failed top-tenants read instead of reporting no usage for the meter', async () => {
    topTenants.mockRejectedValue(new Error('top tenants by usage are unreachable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('top tenants by usage are unreachable');
  });

  it('names a failed trends read instead of reporting no usage for the period', async () => {
    trends.mockRejectedValue(new Error('usage trends are unreachable'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('usage trends are unreachable');
  });

  it('names a failed tenants read instead of reporting no tenant usage', async () => {
    tenants.mockRejectedValue(new Error('tenant usage is unreachable'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('tenant usage is unreachable');
  });

  it('stays silent when the reads genuinely return nothing', async () => {
    renderPage();

    await waitFor(() => expect(summary).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refreshes all four reads, not only the summary', async () => {
    renderPage();
    // Wait for the page itself, not just the request: until the summary
    // resolves the render is still the loading skeleton, which has no buttons.
    const refresh = await screen.findByRole('button', { name: /refresh data/i });
    expect(summary).toHaveBeenCalledTimes(1);

    await userEvent.setup().click(refresh);

    // The regression: this button called refreshSummary, so the other three
    // kept showing whatever they already held.
    await waitFor(() => expect(summary).toHaveBeenCalledTimes(2));
    expect(tenants).toHaveBeenCalledTimes(2);
    expect(trends).toHaveBeenCalledTimes(2);
    expect(topTenants).toHaveBeenCalledTimes(2);
  });

  it('forwards an abort signal to every read', async () => {
    renderPage();

    await waitFor(() => expect(summary).toHaveBeenCalled());
    expect(summary.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(tenants.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(trends.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(topTenants.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });
});
