/**
 * The custom-plan approval queue, on the admin data layer (ADMIN-HIGH-121).
 *
 * Recorded deliberately: this page was NOT lying. It surfaced
 * `(err as Error).message` — the server's own reason — on the read and on all
 * six writes, and it derived its page count from the shared
 * `expectedTotalPages` helper rather than a hand-rolled `Math.ceil`. No
 * fabricated zero, no swallowed refusal, no subtotal labelled a total.
 *
 * So this migration closes no new finding. What it removes is narrower and
 * still real: a banned `console.error`, six floating `loadPlans()` promises
 * after the writes, and a second cache beside the shell's that
 * `logoutCleanup()` never reached.
 *
 * These tests exist to keep that standing — that the read is keyed by its
 * filters, cancels on unmount, and still names a failure when one happens.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import CustomPlansListPage from '../CustomPlansListPage';
import { billingApi } from '../../services/adminApi';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    billingApi: {
      getCustomPlans: vi.fn(),
      submitCustomPlanForApproval: vi.fn(),
      approveCustomPlan: vi.fn(),
      rejectCustomPlan: vi.fn(),
      activateCustomPlan: vi.fn(),
      cloneCustomPlan: vi.fn(),
      deleteCustomPlan: vi.fn(),
    },
  };
});

const list = vi.mocked(billingApi.getCustomPlans);

function emptyPage(): Awaited<ReturnType<typeof billingApi.getCustomPlans>> {
  return {
    data: [],
    total: 0,
    page: 1,
    limit: 20,
    totalPages: 0,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CustomPlansListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CustomPlansListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(emptyPage());
  });

  it("keeps naming the server's own reason when the queue fails to load", async () => {
    list.mockRejectedValue(new Error('custom plans are unreachable'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('custom plans are unreachable');
  });

  it('forwards an abort signal, so leaving the page cancels the read', async () => {
    renderPage();

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('sends the page and limit as part of the request', async () => {
    renderPage();

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]?.[0]).toMatchObject({ page: 1, limit: 20 });
  });

  it('stays silent when the queue is genuinely empty', async () => {
    renderPage();

    await waitFor(() => expect(list).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
