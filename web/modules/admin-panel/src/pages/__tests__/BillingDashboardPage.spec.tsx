/**
 * The billing overview's three reads, on the admin data layer (ADMIN-HIGH-121),
 * and the three ways this page used to state something untrue about money.
 *
 * 1. The "Recent Transactions" feed sat behind a bare `catch { return [] }`, so
 *    billing being unreachable rendered as "No recent transactions" — a claim
 *    that the platform took no money, made from a request that never answered.
 *
 * 2. `mrr: subs.mrr || revenue.mrr` (and the same for `arr` and ARPU). `||`
 *    treats a real 0 as absent, so a tenant base that genuinely bills nothing
 *    silently displayed a DIFFERENT endpoint's figure under the same heading.
 *    Absent may fall back; zero is an answer.
 *
 * 3. The feed collapsed `billing.invoices.status` — eight states — into three,
 *    mapping `paid` and `pending` and calling everything else "failed". A sent
 *    invoice, an overdue receivable, a draft, a partial payment, a void and a
 *    refund all rendered with a red Failed badge. An overdue invoice is money
 *    still owed, not money that failed to move.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import BillingDashboardPage from '../BillingDashboardPage';
import { analyticsApi, billingApi } from '../../services/adminApi';
import type { InvoiceOverview } from '../../services/types/billing';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    analyticsApi: { getRevenueAnalytics: vi.fn(), getRevenueTrend: vi.fn() },
    billingApi: {
      getSubscriptionStats: vi.fn(),
      getInvoiceStats: vi.fn(),
      getPaymentStats: vi.fn(),
      getInvoices: vi.fn(),
    },
  };
});

const revenue = vi.mocked(analyticsApi.getRevenueAnalytics);
const trend = vi.mocked(analyticsApi.getRevenueTrend);
const subs = vi.mocked(billingApi.getSubscriptionStats);
const invoiceStats = vi.mocked(billingApi.getInvoiceStats);
const paymentStats = vi.mocked(billingApi.getPaymentStats);
const invoices = vi.mocked(billingApi.getInvoices);

/**
 * Billing's own numbers, complete as the contract declares them. Written out in
 * full rather than cast: vitest does not type-check, so a partial fixture keeps
 * a suite green while drifting from the response shape it stands in for — the
 * spec type gate is what catches that, and it should have nothing to catch.
 */
function healthyStats(overrides: { subsMrr?: number; subsArr?: number } = {}): void {
  revenue.mockResolvedValue({
    totalRevenue: 900,
    mrr: 777,
    arr: 8888,
    averageRevenuePerTenant: 55,
    revenueByPlan: [],
    revenueByMonth: [],
  });
  subs.mockResolvedValue({
    totalSubscriptions: 4,
    byStatus: { active: 3, trialing: 1 },
    byPlanTier: {},
    byBillingCycle: {},
    mrr: overrides.subsMrr ?? 100,
    arr: overrides.subsArr ?? 1200,
    churnRate: 1.5,
    averageRevenuePerUser: 25,
    trialConversionRate: 0.5,
    expiringThisMonth: 0,
    pastDueCount: 0,
    totalRevenue: 900,
  });
  invoiceStats.mockResolvedValue({
    totalInvoices: 2,
    totalAmount: 50,
    totalPaid: 0,
    totalPending: 50,
    totalOverdue: 0,
    byStatus: { pending: { count: 2, amount: 50 } },
    byCurrency: {},
    avgPaymentTime: 0,
    overdueRate: 0,
    paidThisMonth: 0,
    pendingThisMonth: 2,
  });
  paymentStats.mockResolvedValue({
    totalPayments: 5,
    succeeded: 4,
    failed: 1,
    refunded: 0,
    pending: 0,
    successRate: 0.8,
    totalAmount: 400,
    succeededAmount: 320,
    refundedAmount: 0,
    last30Days: {
      totalPayments: 5,
      succeeded: 4,
      failed: 1,
      refunded: 0,
      pending: 0,
      successRate: 0.8,
      totalAmount: 400,
      succeededAmount: 320,
      refundedAmount: 0,
    },
  });
  trend.mockResolvedValue({
    range: '1y',
    granularity: 'month',
    data: [],
    source: 'billing',
    asOf: '2026-09-09T00:00:00.000Z',
  });
}

/** One invoice as the list endpoint returns it. */
function invoiceRow(
  id: string,
  tenantName: string,
  amount: number,
  status: string,
): InvoiceOverview {
  return {
    id,
    invoiceNumber: `INV-${id}`,
    tenantId: `tenant-${id}`,
    tenantName,
    tenantEmail: `${tenantName.toLowerCase()}@example.com`,
    amount,
    amountPaid: 0,
    amountDue: amount,
    currency: 'USD',
    status,
    issueDate: '2026-01-01',
    dueDate: '2026-02-01',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    createdAt: `2026-01-0${id}`,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BillingDashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BillingDashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    healthyStats();
    invoices.mockResolvedValue({ invoices: [], total: 0 });
  });

  it('names a failed transaction read instead of reporting no transactions', async () => {
    invoices.mockRejectedValue(new Error('billing invoices are unreachable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('billing invoices are unreachable');
    // The regression: `catch { return [] }` rendered this instead.
    expect(screen.queryByText('No recent transactions')).not.toBeInTheDocument();
  });

  it('still says "no recent transactions" when billing genuinely returns none', async () => {
    renderPage();

    expect(await screen.findByText('No recent transactions')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a real zero MRR rather than falling through to the analytics figure', async () => {
    // Subscriptions bill nothing; analytics reports 777 for a different question.
    healthyStats({ subsMrr: 0, subsArr: 0 });
    renderPage();

    // Scoped to the MRR card: ARR is zero here too, so an unscoped query for
    // "$0" matches more than one card and proves nothing about this one.
    const mrrCard = (await screen.findByText('Monthly Recurring Revenue')).parentElement;
    // `0 || 777` was 777 — the analytics figure under the subscriptions
    // heading. `0 ?? 777` is 0.
    expect(mrrCard).toHaveTextContent('$0');
    expect(mrrCard).not.toHaveTextContent('$777');
    expect(screen.queryByText('$777')).not.toBeInTheDocument();
  });

  it('labels every invoice state honestly instead of calling six of them failed', async () => {
    invoices.mockResolvedValue({
      invoices: [
        invoiceRow('1', 'Ocean', 10, 'overdue'),
        invoiceRow('2', 'Reef', 20, 'sent'),
        invoiceRow('3', 'Bay', 30, 'refunded'),
        invoiceRow('4', 'Cove', 40, 'partially_paid'),
      ],
      total: 4,
    });
    renderPage();

    // All four used to render as "failed".
    expect(await screen.findByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('Refunded')).toBeInTheDocument();
    expect(screen.getByText('Partially paid')).toBeInTheDocument();
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
  });

  it('forwards an abort signal to each composed stat read', async () => {
    renderPage();

    await waitFor(() => expect(subs).toHaveBeenCalled());
    expect(subs.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(invoiceStats.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(paymentStats.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });
});
