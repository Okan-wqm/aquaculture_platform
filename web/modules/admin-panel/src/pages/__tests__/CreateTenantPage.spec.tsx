import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { PricingMetricType } from '@platform/pricing-metric-vocabulary';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CreateTenantPage from '../CreateTenantPage';
import {
  billingApi,
  modulesApi,
  tenantsApi,
  BillingCycle,
  TenantProvisioningState,
  TenantTier,
} from '../../services/adminApi';

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
    <BrowserRouter>
      <CreateTenantPage />
    </BrowserRouter>,
  );

const mockPricings = [
  {
    moduleId: 'module-farm',
    moduleCode: 'FARM_MANAGEMENT',
    moduleName: 'Farm Management',
    pricingMetrics: [
      { type: PricingMetricType.BASE_PRICE, price: 100 },
      { type: PricingMetricType.PER_USER, price: 5, includedQuantity: 2 },
      { type: PricingMetricType.PER_FARM, price: 20, includedQuantity: 1 },
      { type: PricingMetricType.PER_POND, price: 10, includedQuantity: 0 },
      { type: PricingMetricType.PER_SENSOR, price: 2, includedQuantity: 0 },
      { type: PricingMetricType.PER_DEVICE, price: 3, includedQuantity: 0 },
      { type: PricingMetricType.PER_GB_STORAGE, price: 1, includedQuantity: 5 },
      { type: PricingMetricType.PER_API_CALL, price: 0.01, includedQuantity: 0 },
      { type: PricingMetricType.PER_ALERT, price: 0.5, includedQuantity: 0 },
      { type: PricingMetricType.PER_REPORT, price: 1, includedQuantity: 0 },
      { type: PricingMetricType.PER_INTEGRATION, price: 15, includedQuantity: 0 },
    ],
  },
  {
    moduleId: 'module-hr',
    moduleCode: 'HR',
    moduleName: 'HR',
    pricingMetrics: [{ type: PricingMetricType.BASE_PRICE, price: 40 }],
  },
  {
    moduleId: 'module-sensor',
    moduleCode: 'SENSORS',
    moduleName: 'Sensors',
    pricingMetrics: [{ type: PricingMetricType.BASE_PRICE, price: 80 }],
  },
  {
    moduleId: 'module-dashboard',
    moduleCode: 'DASHBOARD',
    moduleName: 'Dashboard',
    pricingMetrics: [{ type: PricingMetricType.BASE_PRICE, price: 25 }],
  },
];

const accepted = (state: TenantProvisioningState, overrides = {}) => ({
  status: state,
  statusUrl: '/tenants/provisioning/22222222-2222-4222-8222-222222222222',
  retryAfterMs: state === TenantProvisioningState.RUNNING ? 100 : 0,
  availableActions: state === TenantProvisioningState.FAILED ? ['retryProvisioning'] : [],
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
    vi.mocked(billingApi.getModulePricingWithModules).mockResolvedValue(mockPricings as never);
    vi.mocked(billingApi.calculatePricing).mockResolvedValue({
      subtotal: 100,
      tierDiscount: 0,
      discount: { amount: 0, percent: 0 },
      tax: 0,
      taxRate: 0,
      total: 100,
      monthlyTotal: 100,
      annualTotal: 1200,
      billingCycle: BillingCycle.MONTHLY,
      billingCycleMultiplier: 1,
      currency: 'USD',
      tier: 'starter',
      calculatedAt: new Date().toISOString(),
      modules: [],
    } as never);
    vi.mocked(modulesApi.list).mockResolvedValue({ data: [], total: 0 } as never);
  });

  it('loads module pricing as the source for tenant module selection', async () => {
    renderWithRouter();

    await screen.findByText('Create New Tenant');

    expect(billingApi.getModulePricingWithModules).toHaveBeenCalledTimes(1);
  });

  it('submits a provisioning operation with idempotency and full module quantities', async () => {
    const user = userEvent.setup();
    vi.mocked(tenantsApi.create).mockResolvedValue(
      accepted(TenantProvisioningState.SUCCEEDED) as never,
    );

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
    vi.mocked(tenantsApi.create).mockResolvedValue(
      accepted(TenantProvisioningState.RUNNING) as never,
    );
    vi.mocked(tenantsApi.getProvisioningOperationByStatusUrl).mockResolvedValue(
      accepted(TenantProvisioningState.SUCCEEDED) as never,
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
    vi.mocked(tenantsApi.create).mockResolvedValue(
      accepted(TenantProvisioningState.FAILED) as never,
    );
    vi.mocked(tenantsApi.retryProvisioningOperation).mockResolvedValue(
      accepted(TenantProvisioningState.RUNNING) as never,
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
    vi.mocked(tenantsApi.create).mockResolvedValue(
      accepted(TenantProvisioningState.SUCCEEDED) as never,
    );

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

    // Price summary is $0.00 even though a $100-base module is enabled.
    await waitFor(() => {
      expect(screen.getByText('Monthly Total')).toBeTruthy();
    });
    expect(screen.getAllByText(/\$0\.00/).length).toBeGreaterThan(0);

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
