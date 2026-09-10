/**
 * The plan catalogue's read, and two standards of honesty on one page.
 *
 * `loadPlans` caught its error, wrote `console.error` (banned by CLAUDE.md),
 * and set the fixed string "Failed to load plans. Please try again." One
 * function below, `handleDeprecatePlan` set `(err as Error).message` — the
 * server's real reason. The same page therefore told the operator exactly what
 * went wrong when a write failed, and nothing at all when a read did.
 *
 * This raises the lower standard rather than lowering the higher one: both
 * errors are now surfaced verbatim, and the deprecate write invalidates the
 * catalogue instead of hand-reloading it behind a floating promise.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import PlanManagementPage from '../PlanManagementPage';
import { billingApi } from '../../services/adminApi';
import type { PlanDefinition } from '../../services/types/billing';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    billingApi: { getPlans: vi.fn(), deprecatePlan: vi.fn() },
  };
});

const plans = vi.mocked(billingApi.getPlans);

function planFixture(): PlanDefinition[] {
  return [];
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PlanManagementPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PlanManagementPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plans.mockResolvedValue(planFixture());
  });

  it("shows the server's own reason for a failed read, not a fixed sentence", async () => {
    plans.mockRejectedValue(new Error('plan catalogue rejected: capability billing-ops required'));
    renderPage();

    const alert = await screen.findByRole('alert');
    // The regression: console.error, then "Failed to load plans. Please try
    // again." — while the deprecate handler beside it showed the real message.
    expect(alert).toHaveTextContent('capability billing-ops required');
    expect(alert).not.toHaveTextContent('Please try again');
  });

  it('forwards an abort signal, and asks for inactive plans too', async () => {
    renderPage();

    await waitFor(() => expect(plans).toHaveBeenCalled());
    expect(plans.mock.calls[0]?.[0]).toBe(true);
    expect(plans.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('stays silent when the catalogue loads', async () => {
    renderPage();

    await waitFor(() => expect(plans).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
