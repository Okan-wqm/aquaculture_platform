/**
 * The platform's billing report, and a currency it did not have
 * (ADMIN-HIGH-146).
 *
 * `InvoiceStats.totalAmount` is `COALESCE(SUM(total), 0) FROM
 * billing.invoices` with NO `GROUP BY currency`, and the same payload carries a
 * `byCurrency` breakdown — the endpoint stating that the table is
 * multi-currency. The page put every one of those sums through a
 * `formatCurrency` that hardcoded `currency: 'USD'`, so four cards and an
 * exported CSV read `$…` for a figure that is not an amount of dollars.
 *
 * The second defect is a subtotal sitting beside a total. "Payments With
 * Refunds" fetched one page of a hundred `succeeded` payments and counted the
 * rows with a refund on them — next to "Successful Payments", which was the
 * endpoint's true `total`. The `succeeded` filter also excluded every FULLY
 * refunded payment, whose status is `refunded`, so the card counted partial
 * refunds and called them refunds. Both numbers come from
 * `/billing/payments/stats` now, which computes them over every row.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import BillingReportsPage from '../BillingReportsPage';
import { billingApi } from '../../services/api/billing';
import type { InvoiceStats, PaymentStats } from '../../services/types/billing';

vi.mock('../../services/api/billing', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/billing')>(
    '../../services/api/billing',
  );
  return {
    ...actual,
    billingApi: {
      getInvoiceStats: vi.fn(),
      getPaymentStats: vi.fn(),
      getSubscriptions: vi.fn(),
      getPayments: vi.fn(),
    },
  };
});

const invoiceStats = vi.mocked(billingApi.getInvoiceStats);
const paymentStats = vi.mocked(billingApi.getPaymentStats);
const subscriptions = vi.mocked(billingApi.getSubscriptions);
const paymentsList = vi.mocked(billingApi.getPayments);

/** Complete, as the client type declares it — no cast. */
function invoices(byCurrency: Record<string, number>): InvoiceStats {
  return {
    totalInvoices: 12,
    totalAmount: 1000,
    totalPaid: 600,
    totalPending: 300,
    totalOverdue: 100,
    byStatus: {},
    byCurrency,
    avgPaymentTime: 4,
    overdueRate: 0.08,
    paidThisMonth: 200,
    pendingThisMonth: 50,
  };
}

function window0(): PaymentStats['last30Days'] {
  return {
    totalPayments: 0,
    succeeded: 0,
    failed: 0,
    refunded: 0,
    pending: 0,
    successRate: 0,
    totalAmount: 0,
    succeededAmount: 0,
    refundedAmount: 0,
  };
}

function payments(): PaymentStats {
  return {
    totalPayments: 900,
    succeeded: 842,
    failed: 40,
    refunded: 17,
    pending: 18,
    successRate: 0.95,
    totalAmount: 90_000,
    succeededAmount: 84_200,
    refundedAmount: 1_700,
    last30Days: window0(),
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BillingReportsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BillingReportsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoiceStats.mockResolvedValue(invoices({ EUR: 1000 }));
    paymentStats.mockResolvedValue(payments());
    subscriptions.mockResolvedValue({ subscriptions: [], total: 37 });
  });

  it('states the money in the currency the invoices are actually in', async () => {
    renderPage();

    // €1,000.00 — the page used to print $1,000.00 for the same row.
    const total = await screen.findByText(/1,000\.00/);
    expect(total.textContent).toContain('€');
    expect(total.textContent).not.toContain('$');
  });

  it('refuses to name a currency for a sum across several, and shows the real ones', async () => {
    invoiceStats.mockResolvedValue(invoices({ EUR: 400, USD: 600 }));
    renderPage();

    expect(await screen.findByText(/Invoices are raised in EUR, USD/)).toBeInTheDocument();
    // The four cross-currency sums are dashed rather than symbol-stamped.
    expect((await screen.findAllByText('—')).length).toBe(4);
    // The per-currency figures ARE monetary, and are shown as such.
    expect(screen.getByText(/€\s?400\.00|€400\.00/)).toBeInTheDocument();
  });

  it('takes the refund count from the aggregate, not from a page of payments', async () => {
    renderPage();

    await waitFor(() => expect(paymentStats).toHaveBeenCalled());
    // 17 over every row — not a count out of the first hundred `succeeded`.
    expect(await screen.findByText('17')).toBeInTheDocument();
    expect(await screen.findByText('842')).toBeInTheDocument();
    expect(paymentsList).not.toHaveBeenCalled();
  });

  it('names a failed read rather than rendering a report without it', async () => {
    invoiceStats.mockRejectedValue(new Error('invoice aggregate is unreachable'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('invoice aggregate is unreachable');
  });

  it('forwards an abort signal to all three reads', async () => {
    renderPage();

    await waitFor(() => expect(invoiceStats).toHaveBeenCalled());
    expect(invoiceStats.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(paymentStats.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(subscriptions.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('keeps the export disabled until there is something true to export', async () => {
    invoiceStats.mockRejectedValue(new Error('invoice aggregate is unreachable'));
    renderPage();

    await waitFor(() => expect(invoiceStats).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });
});
