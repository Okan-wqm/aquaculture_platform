/**
 * PaymentsPage — APA-087 search filter behaviour.
 *
 * The free-text filter must send its value as `search` (matched against invoice
 * number / transaction / notes on the backend), NOT as `invoiceId` (an exact
 * UUID). Before the fix, typing a non-UUID fired `invoiceId=<text>` per
 * keystroke, the backend cast it as `::uuid`, and the page flipped to the error
 * state on a 500.
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import PaymentsPage from '../PaymentsPage';
import { billingApi } from '../../services/adminApi';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    billingApi: {
      ...actual.billingApi,
      getPayments: vi.fn(),
      recordPayment: vi.fn(),
      refundPayment: vi.fn(),
    },
  };
});

const mockedGetPayments = vi.mocked(billingApi.getPayments);

function renderPage(): void {
  render(
    <BrowserRouter>
      <PaymentsPage />
    </BrowserRouter>,
  );
}

describe('PaymentsPage search filter (APA-087)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetPayments.mockResolvedValue({ payments: [], total: 0 });
  });

  it('sends a free-text keystroke as `search`, never as `invoiceId`, and never flips to the error state', async () => {
    renderPage();
    await waitFor(() => expect(mockedGetPayments).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/search by invoice/i), {
      target: { value: 'abc' },
    });

    await waitFor(() =>
      expect(mockedGetPayments).toHaveBeenCalledWith(expect.objectContaining({ search: 'abc' })),
    );

    // The malformed value went to `search`, not the uuid-cast `invoiceId`.
    const lastArgs = mockedGetPayments.mock.calls.at(-1)?.[0];
    expect(lastArgs?.invoiceId).toBeUndefined();

    // No 500 → the page never renders the error banner.
    expect(screen.queryByText(/failed to load payments/i)).not.toBeInTheDocument();
  });
});
