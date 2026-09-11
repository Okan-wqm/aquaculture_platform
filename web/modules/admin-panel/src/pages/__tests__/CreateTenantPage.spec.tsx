import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CreateTenantPage from '../CreateTenantPage';
import {
  billingApi,
  modulesApi,
  tenantsApi,
  BillingCycle,
  PricingMetricType,
  TenantProvisioningState,
  TenantTier,
} from '../../services/adminApi';
import type { ModulePricingWithModule, PricingCalculation } from '../../services/types/billing';
import type { CreateTenantAcceptedResponse } from '../../services/types/tenant';

vi.mock('../../services/adminApi', () => ({
  tenantsApi: {
    create: vi.fn(),
    getProvisioningOperation: vi.fn(),
    getProvisioningOperationByStatusUrl: vi.fn(),
    retryProvisioningOperation: vi.fn(),
  },
  modulesApi: {
    list: vi.fn(),
  },
  billingApi: {
    getModulePricingWithModules: vi.fn(),
    calculatePricing: vi.fn(),
  },
  TenantTier: {
    FREE: 'free',
    STARTER: 'starter',
    PROFESSIONAL: 'professional',
    ENTERPRISE: 'enterprise',
  },
  TenantProvisioningState: {
    QUEUED: 'QUEUED',
    RESERVING: 'RESERVING',
    RUNNING: 'RUNNING',
    SUCCEEDED: 'SUCCEEDED',
    FAILED: 'FAILED',
  },
  PlanTier: {
    STARTER: 'starter',
    PROFESSIONAL: 'professional',
    ENTERPRISE: 'enterprise',
  },
  BillingCycle: {
    MONTHLY: 'monthly',
    ANNUAL: 'annual',
  },
  // The wire values, exactly. This mock used to carry UPPERCASE names the API
  // never sends, and the page carried a case-normalising lookup to tolerate
  // them — the workaround and the fixture agreed with each other and with
  // nothing else. `billing.module_price_metrics` CHECKs these fifteen strings.
  PricingMetricType: {
    BASE_PRICE: 'base_price',
    PER_USER: 'per_user',
    PER_FARM: 'per_farm',
    PER_POND: 'per_pond',
    PER_SENSOR: 'per_sensor',
    PER_DEVICE: 'per_device',
    PER_GB_STORAGE: 'per_gb_storage',
    PER_GB_TRANSFER: 'per_gb_transfer',
    PER_API_CALL: 'per_api_call',
    PER_ALERT: 'per_alert',
    PER_REPORT: 'per_report',
    PER_SMS: 'per_sms',
    PER_EMAIL: 'per_email',
    PER_INTEGRATION: 'per_integration',
    PER_WORKFLOW: 'per_workflow',
  },
}));

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const renderWithRouter = () =>
  render(
    // `retry: false` so a rejected sheet read surfaces its error on the first
    // attempt instead of being retried past the assertion.
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BrowserRouter>
        <CreateTenantPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );

/** Walk as far as the "Module Selection & Pricing" step and stop there. */
async function goToModuleStep(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Create New Tenant');
  await user.type(screen.getByLabelText(/company name/i), 'Test Company');
  await user.click(screen.getByRole('button', { name: /continue/i }));

  await screen.findByText('Admin Information');
  await user.type(screen.getByLabelText(/full name/i), 'Jane Admin');
  await user.type(screen.getByLabelText(/e-posta/i), 'jane@example.com');
  await user.click(screen.getByRole('button', { name: /continue/i }));

  await screen.findByText('Module Selection & Pricing');
}

/** A sheet row carries its identity and effectivity, not only its metrics. */
const sheetRow = (
  moduleId: string,
  moduleCode: string,
  moduleName: string,
  metrics: ModulePricingWithModule['metrics'],
): ModulePricingWithModule => ({
  id: `price-${moduleId}`,
  moduleId,
  moduleCode,
  moduleName,
  currency: 'USD',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  isActive: true,
  version: 1,
  metrics,
  tierMultipliers: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const mockPricings: ModulePricingWithModule[] = [
  sheetRow('module-farm', 'FARM_MANAGEMENT', 'Farm Management', [
    { metricType: PricingMetricType.BASE_PRICE, price: '100' },
    { metricType: PricingMetricType.PER_USER, price: '5', includedQuantity: 2 },
    { metricType: PricingMetricType.PER_FARM, price: '20', includedQuantity: 1 },
    { metricType: PricingMetricType.PER_POND, price: '10', includedQuantity: 0 },
    { metricType: PricingMetricType.PER_SENSOR, price: '2', includedQuantity: 0 },
    { metricType: PricingMetricType.PER_DEVICE, price: '3', includedQuantity: 0 },
    { metricType: PricingMetricType.PER_GB_STORAGE, price: '1', includedQuantity: 5 },
    { metricType: PricingMetricType.PER_API_CALL, price: '0.01', includedQuantity: 0 },
    { metricType: PricingMetricType.PER_ALERT, price: '0.5', includedQuantity: 0 },
    { metricType: PricingMetricType.PER_REPORT, price: '1', includedQuantity: 0 },
    { metricType: PricingMetricType.PER_INTEGRATION, price: '15', includedQuantity: 0 },
  ]),
  sheetRow('module-hr', 'HR', 'HR', [{ metricType: PricingMetricType.BASE_PRICE, price: '40' }]),
  sheetRow('module-sensor', 'SENSORS', 'Sensors', [
    { metricType: PricingMetricType.BASE_PRICE, price: '80' },
  ]),
  sheetRow('module-dashboard', 'DASHBOARD', 'Dashboard', [
    { metricType: PricingMetricType.BASE_PRICE, price: '25' },
  ]),
];

/**
 * A quote as billing returns it. FREE is a permanent $0 tier and billing
 * clamps it there — the wizard shows that answer rather than deciding it.
 */
const quoteFor = (monthlyTotal: string, tier: PricingCalculation['tier']): PricingCalculation => ({
  modules: [],
  subtotal: monthlyTotal,
  tierDiscount: '0',
  cycleDiscountAmount: '0',
  cycleDiscountPercent: '0',
  discountAmount: '0',
  // A negotiated custom-plan discount; this wizard quotes catalogue plans,
  // so billing answers zero rather than omitting the field.
  negotiatedDiscountAmount: '0',
  tax: '0',
  taxRate: '0',
  total: monthlyTotal,
  monthlyTotal,
  annualTotal: String(Number(monthlyTotal) * 12),
  billingCycle: BillingCycle.MONTHLY,
  billingCycleMultiplier: 1,
  currency: 'USD',
  tier,
  calculatedAt: new Date().toISOString(),
  unpricedModuleCodes: [],
});

const accepted = (
  state: TenantProvisioningState,
  overrides: Partial<CreateTenantAcceptedResponse> = {},
): CreateTenantAcceptedResponse => ({
  status: state,
  statusUrl: '/tenants/provisioning/22222222-2222-4222-8222-222222222222',
  retryAfterMs: state === TenantProvisioningState.RUNNING ? 100 : 0,
  availableActions: state === TenantProvisioningState.FAILED ? ['retryProvisioning'] : [],
  steps: [],
  ...overrides,
});

async function completeFormToReview(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Create New Tenant');

  await user.type(screen.getByLabelText(/company name/i), 'Test Company');
  await user.type(screen.getByLabelText(/domain/i), 'Tenant.Example.COM');
  await user.type(screen.getByLabelText(/country/i), 'tr');
  await user.type(screen.getByLabelText(/region/i), ' Ege ');
  await user.click(screen.getByRole('button', { name: /continue/i }));

  await screen.findByText('Admin Information');
  await user.type(screen.getByLabelText(/full name/i), 'Jane Admin');
  await user.type(screen.getByLabelText(/e-posta/i), 'jane@example.com');
  await user.click(screen.getByRole('button', { name: /continue/i }));

  await screen.findByText('Module Selection & Pricing');
  await user.click(screen.getByRole('button', { name: /enable farm management/i }));
  await user.click(screen.getByRole('button', { name: /continue/i }));

  await screen.findByRole('heading', { name: 'Confirmation' });
}

describe('CreateTenantPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockReset();
    window.sessionStorage.clear();
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'idem-key-1') });
    vi.mocked(billingApi.getModulePricingWithModules).mockResolvedValue(mockPricings);
    // ADR-0013: the quote is billing's answer, in exact decimal strings —
    // the page renders it and never recomputes a total of its own.
    vi.mocked(billingApi.calculatePricing).mockImplementation(async (request) =>
      quoteFor(request.tier === 'free' ? '0' : '100', request.tier),
    );
  });

  it('loads module pricing as the source for tenant module selection', async () => {
    renderWithRouter();

    await screen.findByText('Create New Tenant');

    expect(billingApi.getModulePricingWithModules).toHaveBeenCalledTimes(1);
  });

  it('submits a provisioning operation with idempotency and full module quantities', async () => {
    const user = userEvent.setup();
    vi.mocked(tenantsApi.create).mockResolvedValue(accepted(TenantProvisioningState.SUCCEEDED));

    renderWithRouter();
    await completeFormToReview(user);
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    await waitFor(() => {
      expect(tenantsApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Company',
          slug: 'test-company',
          tier: TenantTier.STARTER,
          domain: 'tenant.example.com',
          country: 'TR',
          region: 'Ege',
          moduleIds: ['module-farm'],
          moduleQuantities: [
            expect.objectContaining({
              moduleId: 'module-farm',
              users: 2,
              farms: 1,
              ponds: 0,
              sensors: 0,
              devices: 0,
              storageGb: 5,
              apiCalls: 0,
              alerts: 0,
              reports: 0,
              integrations: 0,
            }),
          ],
        }),
        'idem-key-1',
      );
    });

    expect(await screen.findByText(/tenant provisioned successfully/i)).toBeTruthy();
  });

  it('shows an in-progress provisioning operation and refreshes to success', async () => {
    const user = userEvent.setup();
    vi.mocked(tenantsApi.create).mockResolvedValue(accepted(TenantProvisioningState.RUNNING));
    vi.mocked(tenantsApi.getProvisioningOperationByStatusUrl).mockResolvedValue(
      accepted(TenantProvisioningState.SUCCEEDED),
    );

    renderWithRouter();
    await completeFormToReview(user);
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    expect(await screen.findByText('Tenant Provisioning')).toBeTruthy();
    expect(
      screen.getByText('/tenants/provisioning/22222222-2222-4222-8222-222222222222'),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      expect(tenantsApi.getProvisioningOperationByStatusUrl).toHaveBeenCalledWith(
        '/tenants/provisioning/22222222-2222-4222-8222-222222222222',
      );
    });
    expect(await screen.findByText(/tenant provisioned successfully/i)).toBeTruthy();
  });

  it('allows retrying a failed provisioning operation', async () => {
    const user = userEvent.setup();
    vi.mocked(tenantsApi.create).mockResolvedValue(accepted(TenantProvisioningState.FAILED));
    vi.mocked(tenantsApi.retryProvisioningOperation).mockResolvedValue(
      accepted(TenantProvisioningState.RUNNING),
    );

    renderWithRouter();
    await completeFormToReview(user);
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    expect(await screen.findByText(/tenant provisioning failed/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(tenantsApi.retryProvisioningOperation).toHaveBeenCalledWith(
        '/tenants/provisioning/22222222-2222-4222-8222-222222222222',
      );
    });
  });

  it('navigates back to the tenant list on cancel', async () => {
    const user = userEvent.setup();
    renderWithRouter();

    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/admin/tenants');
  });

  it('provisions a FREE tenant at $0 with no trial and no free→starter coercion (Faz B)', async () => {
    const user = userEvent.setup();
    vi.mocked(tenantsApi.create).mockResolvedValue(accepted(TenantProvisioningState.SUCCEEDED));

    renderWithRouter();
    await screen.findByText('Create New Tenant');

    // Step 1 — basic info
    await user.type(screen.getByLabelText(/company name/i), 'Free Co');
    await user.type(screen.getByLabelText(/domain/i), 'free.example.com');
    await user.type(screen.getByLabelText(/country/i), 'tr');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Step 2 — admin contact
    await screen.findByText('Admin Information');
    await user.type(screen.getByLabelText(/full name/i), 'Free Admin');
    await user.type(screen.getByLabelText(/e-posta/i), 'free@example.com');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Step 3 — select the Free tier, then enable a PAID module
    await screen.findByText('Module Selection & Pricing');
    await user.click(screen.getByRole('radio', { name: /free/i }));
    // Banner text unique to the FREE-selected Alert (the radio option description
    // also mentions "permanent $0", so match the allowances line instead).
    expect(screen.getByText(/included allowances/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /enable farm management/i }));

    // The summary shows $0.00 even though a $100-base module is enabled —
    // and it is BILLING's answer now, awaited, not a browser short-circuit.
    await waitFor(() => {
      expect(screen.getByText('Monthly Total')).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getAllByText(/0\.00/).length).toBeGreaterThan(0);
    });

    // Submit
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByRole('heading', { name: 'Confirmation' });
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    await waitFor(() => {
      expect(tenantsApi.create).toHaveBeenCalledTimes(1);
    });

    const createArg = vi.mocked(tenantsApi.create).mock.calls[0][0];
    // The real tier passes through (no free→STARTER coercion) ...
    expect(createArg.tier).toBe(TenantTier.FREE);
    // ... and FREE is never a trial.
    expect(createArg.trialDays).toBeUndefined();
    expect(createArg.moduleIds).toEqual(['module-farm']);
  });
});

/**
 * ADMIN-HIGH-135 — the catalogue's silent double fallback.
 *
 * The module catalogue used to load in a `useEffect` that, on failure, wrote
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
 * The seeding itself is asserted by the provisioning test above, which pins the
 * submitted quantities to the sheet's `includedQuantity` (users 2, farms 1,
 * storage 5) rather than the fallback's hard-coded 1s.
 */
describe('CreateTenantPage price sheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockReset();
    window.sessionStorage.clear();
    vi.mocked(billingApi.getModulePricingWithModules).mockResolvedValue(mockPricings);
  });

  it('forwards an abort signal to the sheet read', async () => {
    renderWithRouter();

    await waitFor(() => expect(billingApi.getModulePricingWithModules).toHaveBeenCalled());
    expect(vi.mocked(billingApi.getModulePricingWithModules).mock.calls[0]?.[0]).toBeInstanceOf(
      AbortSignal,
    );
  });

  it('reads the sheet once, with no module-list fallback behind it', async () => {
    vi.mocked(billingApi.getModulePricingWithModules).mockRejectedValue(
      new Error('module pricing is unreachable'),
    );

    renderWithRouter();

    await waitFor(() => expect(billingApi.getModulePricingWithModules).toHaveBeenCalled());
    expect(billingApi.getModulePricingWithModules).toHaveBeenCalledTimes(1);
    // The regression: a failed sheet silently fetched modulesApi.list() and
    // offered its modules with hard-coded quantities and no prices.
    expect(modulesApi.list).not.toHaveBeenCalled();
  });

  it('names a failed sheet read instead of telling the operator to define modules', async () => {
    const user = userEvent.setup();
    vi.mocked(billingApi.getModulePricingWithModules).mockRejectedValue(
      new Error('module pricing is unreachable'),
    );

    renderWithRouter();
    await goToModuleStep(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('module pricing is unreachable');
    expect(screen.queryByText('No modules found')).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
