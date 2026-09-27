/**
 * The subscription page's reads on the admin data layer (ADMIN-HIGH-121), and
 * a Retry button that could never clear the error it offered to retry.
 *
 * `loadData()` assigned `error` in its catch and NOTHING ever assigned `null`
 * again — not on a successful reload, not anywhere. The render returned a
 * full-page error whenever `error` was set. So after one transient failure the
 * Retry button fetched successfully and the page went on showing the error,
 * permanently, until a reload of the browser.
 *
 * Worth recording what this page already got right, because it is the
 * exception in this batch: the stat cards are guarded by `{stats && …}`, so it
 * never invented a zero. That is left alone.
 *
 * The three lifecycle writes also stopped passing a literal `'admin'` under a
 * `// TODO: get from auth context` comment. The client functions took it as
 * `_cancelledBy` and never put it on the wire — the server derives the actor
 * from the authenticated request and refuses without one (ADMIN-CRITICAL-008).
 * The comment described a gap that was already closed, and "fixing" it by
 * sending a client-supplied actor is what would have opened a real one.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import SubscriptionManagementPage from '../SubscriptionManagementPage';
import { billingApi } from '../../services/adminApi';
import type { SubscriptionStats } from '../../services/types/billing';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    billingApi: {
      getSubscriptions: vi.fn(),
      getSubscriptionStats: vi.fn(),
      cancelSubscription: vi.fn(),
      extendTrial: vi.fn(),
      reactivateSubscription: vi.fn(),
    },
  };
});

const list = vi.mocked(billingApi.getSubscriptions);
const stats = vi.mocked(billingApi.getSubscriptionStats);

function statsFixture(): SubscriptionStats {
  return {
    totalSubscriptions: 12,
    byStatus: { active: 9, trialing: 3 },
    byPlanTier: {},
    byBillingCycle: {},
    mrr: 4200,
    arr: 50400,
    churnRate: 2.1,
    averageRevenuePerUser: 350,
    trialConversionRate: 44,
    expiringThisMonth: 1,
    pastDueCount: 0,
    totalRevenue: 90000,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SubscriptionManagementPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SubscriptionManagementPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue({ subscriptions: [], total: 0 });
    stats.mockResolvedValue(statsFixture());
  });

  it('clears the error once a retry succeeds', async () => {
    list.mockRejectedValueOnce(new Error('subscriptions are unreachable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('subscriptions are unreachable');

    // The regression: `loadData` never assigned `error = null`, so this button
    // fetched successfully and the page kept showing the failure forever.
    list.mockResolvedValue({ subscriptions: [], total: 0 });
    await userEvent.setup().click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() =>
      expect(screen.queryByText('subscriptions are unreachable')).not.toBeInTheDocument(),
    );
  });

  it('keeps showing the page when a read fails, rather than replacing it', async () => {
    stats.mockRejectedValue(new Error('subscription stats are unreachable'));
    renderPage();

    // A failed aggregate names itself without taking the list away.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'subscription stats are unreachable',
    );
    expect(screen.getByText('Subscription Management')).toBeInTheDocument();
  });

  it('forwards an abort signal to both reads', async () => {
    renderPage();

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(stats.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('shows the server aggregate once it loads', async () => {
    renderPage();

    expect(await screen.findByText('$4,200.00')).toBeInTheDocument();
  });
});
