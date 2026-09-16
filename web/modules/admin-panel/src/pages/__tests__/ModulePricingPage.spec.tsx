/**
 * The module price sheets, and the two places this page threw away the only
 * thing that could have told an operator what to do next.
 *
 * Both the read and the save caught their error, wrote `console.error`, and set
 * a fixed string — "Failed to load module pricings. Please try again." and
 * "Failed to save pricing. Please try again." The server's own message went
 * nowhere.
 *
 * On the save that is the worse of the two. The contract takes an exact decimal
 * multiplier in (0, 10] and the server REFUSES anything outside it with a
 * reason rather than coercing — a rule this page already records in
 * `handleTierMultiplierChange`. Replacing that refusal with "Please try again"
 * means the operator retries the same rejected value, gets the same generic
 * sentence, and never learns which field is wrong.
 *
 * Also fixed here: `parseInt(value) || 0` on the included-quantity field, which
 * silently turned "1OO" into 1 and "abc" into 0 on a field that decides what a
 * tenant is charged for. The multiplier beside it had already been fixed this
 * way in an earlier wave; this one had been missed.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import ModulePricingPage from '../ModulePricingPage';
import { billingApi } from '../../services/adminApi';
import type { ModulePricingWithModule } from '../../services/types/billing';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    billingApi: {
      getModulePricingWithModules: vi.fn(),
      updateModulePricing: vi.fn(),
    },
  };
});

const sheets = vi.mocked(billingApi.getModulePricingWithModules);

function sheet(): ModulePricingWithModule {
  return {
    id: 'price-1',
    moduleId: 'module-1',
    moduleCode: 'FARM',
    moduleName: 'Farm Management',
    currency: 'USD',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    isActive: true,
    version: 1,
    metrics: [{ metricType: 'per_user', price: '5.00', includedQuantity: 25 }],
    tierMultipliers: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ModulePricingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ModulePricingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sheets.mockResolvedValue([sheet()]);
  });

  it("shows the server's own reason for a failed read, not a fixed sentence", async () => {
    sheets.mockRejectedValue(new Error('module pricing rejected: capability billing-ops required'));
    renderPage();

    const alert = await screen.findByRole('alert');
    // The regression: console.error, then "Please try again." — which tells an
    // operator nothing about a capability refusal they could act on.
    expect(alert).toHaveTextContent('capability billing-ops required');
    expect(alert).not.toHaveTextContent('Please try again');
  });

  it('forwards an abort signal to the sheet read', async () => {
    renderPage();

    await waitFor(() => expect(sheets).toHaveBeenCalled());
    expect(sheets.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('stays silent when the sheets load', async () => {
    renderPage();

    expect(await screen.findByText('Farm Management')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
