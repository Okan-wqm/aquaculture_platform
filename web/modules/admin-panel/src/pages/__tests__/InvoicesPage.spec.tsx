/**
 * The invoice list's two reads on the admin data layer (ADMIN-HIGH-121), and
 * the three ways this page overstated what it knew about receivables.
 *
 * 1. The five money totals lived in a `useState` seeded with five zeros, so
 *    until billing answered — and forever if it never did — the page asserted
 *    "Overdue: $0", "Pending: $0", "0 invoices". A zero owed is a specific and
 *    reassuring claim, and an unanswered request is no basis for it.
 *
 * 2. A page-local `InvoiceStats` restated five of the contract type's eleven
 *    fields, so the page could not see the six the server also sends and could
 *    drift from it silently.
 *
 * 3. The status filter offered five of the eight states
 *    `billing.invoices.status` can hold. A draft, a sent invoice, a partially
 *    paid one and a refunded one could not be filtered for at all.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import InvoicesPage from '../InvoicesPage';
import { billingApi } from '../../services/adminApi';
import type { InvoiceOverview, InvoiceStats } from '../../services/types/billing';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    billingApi: {
      getInvoices: vi.fn(),
      getInvoiceStats: vi.fn(),
      markInvoicePaid: vi.fn(),
      voidInvoice: vi.fn(),
      createInvoice: vi.fn(),
    },
  };
});

const list = vi.mocked(billingApi.getInvoices);
const stats = vi.mocked(billingApi.getInvoiceStats);

function statsFixture(): InvoiceStats {
  return {
    totalInvoices: 7,
    totalAmount: 1000,
    totalPaid: 600,
    totalPending: 250,
    totalOverdue: 150,
    byStatus: {},
    byCurrency: {},
    avgPaymentTime: 3,
    overdueRate: 0.15,
    paidThisMonth: 4,
    pendingThisMonth: 3,
  };
}

function invoiceRow(id: string, status: string): InvoiceOverview {
  return {
    id,
    invoiceNumber: `INV-${id}`,
    tenantId: `tenant-${id}`,
    tenantName: `Tenant ${id}`,
    tenantEmail: `t${id}@example.com`,
    amount: 100,
    amountPaid: 0,
    amountDue: 100,
    currency: 'USD',
    status,
    issueDate: '2026-01-01',
    dueDate: '2026-02-01',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    createdAt: '2026-01-01',
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <InvoicesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The card whose label is `label`, so a shared "—" cannot satisfy the wrong one. */
function card(label: string): HTMLElement {
  return screen.getByText(label, { selector: 'p.text-sm.text-gray-500' })
    .parentElement as HTMLElement;
}

describe('InvoicesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue({ invoices: [invoiceRow('1', 'paid')], total: 1 });
    stats.mockResolvedValue(statsFixture());
  });

  it('renders an em dash rather than $0 when the totals have not loaded', async () => {
    stats.mockRejectedValue(new Error('invoice stats are unreachable'));
    renderPage();

    await waitFor(() => expect(stats).toHaveBeenCalled());
    // The regression: a useState seeded with zeros claimed nothing was owed.
    await waitFor(() => expect(card('Overdue')).toHaveTextContent('—'));
    expect(card('Overdue')).not.toHaveTextContent('$0');
    expect(card('Pending')).toHaveTextContent('—');
    expect(card('Total Invoices')).toHaveTextContent('—');
  });

  it('names the failed totals read instead of leaving the cards blank', async () => {
    stats.mockRejectedValue(new Error('invoice stats are unreachable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('invoice stats are unreachable');
  });

  it('shows billing figures once they load', async () => {
    renderPage();

    await waitFor(() => expect(card('Overdue')).toHaveTextContent('$150'));
    expect(card('Paid')).toHaveTextContent('$600');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers every invoice state as a filter, not five of the eight', async () => {
    renderPage();
    await waitFor(() => expect(list).toHaveBeenCalled());

    // These four had no filter button at all, so their rows were reachable
    // only by scrolling an unfiltered list.
    for (const status of ['draft', 'sent', 'partially_paid', 'refunded']) {
      expect(screen.getByRole('button', { name: status })).toBeInTheDocument();
    }
  });

  it('forwards an abort signal to both reads', async () => {
    renderPage();

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(stats.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('keys the list by its filters so a filtered read cannot overwrite the full one', async () => {
    renderPage();

    await waitFor(() => expect(list).toHaveBeenCalled());
    const table = await screen.findByRole('table');
    expect(within(table).getByText('INV-1')).toBeInTheDocument();
  });
});
