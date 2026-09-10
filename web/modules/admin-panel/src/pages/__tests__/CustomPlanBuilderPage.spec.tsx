/**
 * The custom-plan builder: the sheet it prices from, a quantity a typo could
 * zero, and a failure announced in the green box.
 *
 * 1. The catalogue load wrote `console.error` and set "Failed to load module
 *    pricing. Please try again." — the same endpoint, and the same words, that
 *    ModulePricingPage used before ADMIN-HIGH-141. A capability refusal and an
 *    outage looked identical, and retrying only hit the same wall.
 *
 * 2. `parseInt(e.target.value) || 0` turned any unparseable entry — a stray
 *    letter in "1OO" — into 0, silently, on a field this plan's PRICE is
 *    computed from. The quote then came back lower, and the plan could be
 *    created at it.
 *
 * 3. After creating the plan, the auto-submit-for-approval step had a bare
 *    `catch {}` that announced its failure through `setSuccess` — in the green
 *    box, with the server's reason discarded. The plan really was created, so
 *    it is a partial success; but the half that failed is now reported as a
 *    failure, with the words the server used.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import CustomPlanBuilderPage from '../CustomPlanBuilderPage';
import { billingApi } from '../../services/adminApi';
import type { ModulePricingWithModule } from '../../services/types/billing';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    billingApi: {
      getModulePricingWithModules: vi.fn(),
      calculateCustomPlanPricing: vi.fn(),
      createCustomPlan: vi.fn(),
      submitCustomPlanForApproval: vi.fn(),
    },
  };
});

const sheets = vi.mocked(billingApi.getModulePricingWithModules);

function sheet(): ModulePricingWithModule[] {
  return [
    {
      id: 'price-1',
      moduleId: 'module-1',
      moduleCode: 'FARM',
      moduleName: 'Farm Management',
      currency: 'USD',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      isActive: true,
      version: 1,
      metrics: [{ metricType: 'per_user', price: '5.00', includedQuantity: 10 }],
      tierMultipliers: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CustomPlanBuilderPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CustomPlanBuilderPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sheets.mockResolvedValue(sheet());
  });

  it("names the server's own reason when the price sheet fails to load", async () => {
    sheets.mockRejectedValue(new Error('module pricing rejected: capability billing-ops required'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('capability billing-ops required');
    expect(alert).not.toHaveTextContent('Please try again');
  });

  it('forwards an abort signal to the sheet read', async () => {
    renderPage();

    await waitFor(() => expect(sheets).toHaveBeenCalled());
    expect(sheets.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('stays silent when the sheet loads', async () => {
    renderPage();

    expect(await screen.findByText('Farm Management')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the module list from the sheet, with no second source behind it', async () => {
    renderPage();

    await waitFor(() => expect(sheets).toHaveBeenCalledTimes(1));
    // One read: the sheet is the only source of what can be priced.
    expect(sheets).toHaveBeenCalledTimes(1);
    await userEvent.setup(); // settle any pending effects
  });
});
