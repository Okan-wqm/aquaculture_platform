/**
 * CreateTenantPage's module step on the admin data layer (ADMIN-HIGH-121), and
 * the silent double fallback that let an operator provision a tenant from
 * guessed quantities.
 *
 * The catalogue used to load in a `useEffect` that, on failure, wrote
 * `console.warn` and fetched `modulesApi.list()` instead — a module list
 * carrying NO pricing metrics — then seeded every quantity from a hard-coded
 * `{users: 1, farms: 1, storageGb: 1}` rather than each metric's
 * `includedQuantity`. A second failure produced another `console.warn` and an
 * empty list rendered as "No modules found — Please define modules in Billing >
 * Module Pricing page first", which is the wrong instruction for a request that
 * did not return.
 *
 * Nothing on screen ever said the price sheet had not loaded. This page already
 * states the principle one step later, for the quote (ADR-0013): the number
 * comes from billing, or the page says it could not price the selection.
 * Offering modules that cannot be priced is the same defect one step earlier.
 *
 * The provisioning submit is deliberately not exercised here: it is the
 * best-built write path in this batch — idempotency key, a real provisioning
 * operation, polling with an AbortController, and `success` gated on
 * SUCCEEDED — and this wave does not touch it.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import CreateTenantPage from '../CreateTenantPage';
import { billingApi } from '../../services/adminApi';
import type { ModulePricingWithModule } from '../../services/adminApi';

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
      calculatePricing: vi.fn(),
    },
    tenantsApi: { create: vi.fn() },
  };
});

const sheetMock = vi.mocked(billingApi.getModulePricingWithModules);

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
      metrics: [
        { metricType: 'per_user', price: '5.00', includedQuantity: 25 },
        { metricType: 'per_gb_storage', price: '0.50', includedQuantity: 100 },
      ],
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
        <CreateTenantPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Walk the wizard to the "Modules & Pricing" step. */
async function goToModuleStep(): Promise<void> {
  const actor = userEvent.setup();
  await actor.type(screen.getByLabelText(/company name/i), 'Ocean Farms');
  await actor.click(screen.getByRole('button', { name: 'Continue' }));
  await actor.type(screen.getByLabelText(/full name/i), 'Ada Lovelace');
  await actor.type(screen.getByLabelText(/e-posta/i), 'ada@example.com');
  await actor.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('CreateTenantPage price sheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sheetMock.mockResolvedValue(sheet());
  });

  it('forwards the abort signal to the sheet read', async () => {
    renderPage();

    await waitFor(() => expect(sheetMock).toHaveBeenCalled());
    expect(sheetMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('reads the sheet once, with no module-list fallback behind it', async () => {
    sheetMock.mockRejectedValue(new Error('module pricing is unreachable'));
    renderPage();

    await waitFor(() => expect(sheetMock).toHaveBeenCalled());
    // The regression: a failed sheet silently fetched modulesApi.list() and
    // offered its modules with hard-coded quantities and no prices.
    expect(sheetMock).toHaveBeenCalledTimes(1);
  });

  it('seeds each quantity from what the sheet includes', async () => {
    renderPage();
    await waitFor(() => expect(sheetMock).toHaveBeenCalled());
    await goToModuleStep();

    // The quantity inputs belong to an enabled module, so the seeded values are
    // only observable once the operator selects it.
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Enable Farm Management' }));

    // 25 users and 100 GB come from the metrics' includedQuantity; the
    // fallback's hard-coded seed was 1 and 1.
    expect(await screen.findByDisplayValue('25')).toBeInTheDocument();
    expect(screen.getByDisplayValue('100')).toBeInTheDocument();
  });

  it('names a failed sheet read instead of telling the operator to define modules', async () => {
    sheetMock.mockRejectedValue(new Error('module pricing is unreachable'));
    renderPage();
    await waitFor(() => expect(sheetMock).toHaveBeenCalled());
    await goToModuleStep();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('module pricing is unreachable');
    expect(screen.queryByText('No modules found')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
