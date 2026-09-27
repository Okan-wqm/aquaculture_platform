/**
 * The payments page's money cards, and the subtotal that was labelled a total.
 *
 * "Succeeded Amount", "Refunded" and "Net Revenue" were summed IN THE BROWSER
 * from `payments` — one page of at most 50 rows, narrowed further by whatever
 * status filter was active. Two consequences, both on the platform's revenue
 * figure:
 *
 *   - filter to `failed` and Net Revenue read $0, because no succeeded row was
 *     in the array being summed;
 *   - any platform with more than 50 payments saw the net of its first page
 *     presented as its net revenue.
 *
 * The aggregate belongs to the server, which already ran the GROUP BY that
 * produced the counts. `succeededAmount` and `refundedAmount` are computed
 * there now, over every row, and `refundedAmount` sums `refunded_amount` rather
 * than the amount of rows whose status is refunded — a partially refunded
 * payment returned only part of itself.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import PaymentsPage from '../PaymentsPage';
import { billingApi, PaymentMethod, PaymentStatus } from '../../services/adminApi';
import type { PaymentOverview, PaymentStats } from '../../services/types/billing';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    billingApi: {
      getPayments: vi.fn(),
      getPaymentStats: vi.fn(),
      recordPayment: vi.fn(),
      refundPayment: vi.fn(),
    },
  };
});

const list = vi.mocked(billingApi.getPayments);
const stats = vi.mocked(billingApi.getPaymentStats);

function window0(overrides: Partial<PaymentStats> = {}): PaymentStats {
  const base = {
    totalPayments: 120,
    succeeded: 90,
    failed: 20,
    refunded: 10,
    pending: 0,
    successRate: 0.83,
    totalAmount: 12000,
    succeededAmount: 9000,
    refundedAmount: 1500,
  };
  return { ...base, last30Days: { ...base }, ...overrides };
}

function paymentRow(id: string, status: PaymentStatus, amount: number): PaymentOverview {
  return {
    id,
    invoiceId: `inv-${id}`,
    tenantId: `tenant-${id}`,
    amount,
    refundedAmount: 0,
    currency: 'USD',
    status,
    paymentMethod: PaymentMethod.BANK_TRANSFER,
    paymentDate: '2026-01-01',
    transactionId: `txn-${id}`,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PaymentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function card(label: string): HTMLElement {
  return screen.getByText(label, { selector: 'p.text-sm.text-gray-500' })
    .parentElement as HTMLElement;
}

describe('PaymentsPage money cards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stats.mockResolvedValue(window0());
    list.mockResolvedValue({
      payments: [paymentRow('1', PaymentStatus.SUCCEEDED, 100)],
      total: 120,
    });
  });

  it('takes the totals from the server aggregate, not from the rows on screen', async () => {
    // The page holds ONE row worth $100. The platform figures are the server's.
    renderPage();

    await waitFor(() => expect(card('Succeeded Amount')).toHaveTextContent('$9,000'));
    expect(card('Refunded')).toHaveTextContent('$1,500');
    expect(card('Net Revenue')).toHaveTextContent('$7,500');
    expect(card('Total Payments')).toHaveTextContent('120');
  });

  it('keeps net revenue whole when the list is filtered to a non-revenue status', async () => {
    // The regression: summing the visible rows made this $0, because no
    // succeeded payment was in the filtered array.
    list.mockResolvedValue({ payments: [paymentRow('9', PaymentStatus.FAILED, 40)], total: 20 });
    renderPage();

    await waitFor(() => expect(card('Net Revenue')).toHaveTextContent('$7,500'));
    expect(card('Net Revenue')).not.toHaveTextContent('$0');
  });

  it('renders an em dash rather than a fabricated zero when the aggregate fails', async () => {
    stats.mockRejectedValue(new Error('payment stats are unreachable'));
    renderPage();

    await waitFor(() => expect(card('Net Revenue')).toHaveTextContent('—'));
    expect(card('Succeeded Amount')).toHaveTextContent('—');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('payment stats are unreachable');
  });

  it('forwards an abort signal to both reads', async () => {
    renderPage();

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(stats.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });
});
