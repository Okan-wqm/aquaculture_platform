/**
 * Billing API (Plans, Subscriptions, Invoices, Discounts, Module Pricing, Custom Plans, Payments)
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  BulkCreateDiscountCodesDto,
  CreateDiscountCodeDto,
  CreatePlanDto,
  PlanComparison,
  PlanDefinition,
  PlanLimits,
  UpdatePlanDto,
  PlanTier,
  DiscountApplication,
  DiscountCode,
  DiscountCodeLookup,
  DiscountCodePage,
  DiscountCodeTemplate,
  DiscountRedemptionPage,
  DiscountStats,
  DiscountSubscriptionChange,
  DiscountValidation,
  UpdateDiscountCodeDto,
  PaymentOverview,
  RecordPaymentDto,
  RefundPaymentDto,
  SubscriptionOverview,
  SubscriptionStatus,
  SubscriptionStats,
  InvoiceOverview,
  InvoiceStats,
  ModulePricing,
  ModulePricingPage,
  ModulePricingWithModule,
  QuickEstimateResult,
  SeedModulePricesResult,
  UpdateModulePricingDto,
  SetModulePricingDto,
  ModuleQuantities,
  QuoteRequest,
  PricingCalculation,
  PricingComparisonResult,
  CustomPlan,
  CustomPlanFilter,
  PaginatedCustomPlans,
  CreateCustomPlanDto,
  UpdateCustomPlanDto,
  UsageSummaryStats,
  TenantUsageOverview,
  UsageTrendPoint,
  TopTenantUsage,
  AggregationPeriod,
  MeterType,
} from '../types';

export const billingApi = {
  // Plans
  getPlans: (includeInactive = false) =>
    apiFetch<PlanDefinition[]>(`/billing/plans?includeInactive=${includeInactive}`),
  getPublicPlans: () => apiFetch<PlanDefinition[]>('/billing/plans/public'),
  getPlanById: (id: string) => apiFetch<PlanDefinition>(`/billing/plans/${id}`),
  getPlanByCode: (code: string) => apiFetch<PlanDefinition>(`/billing/plans/code/${code}`),
  // ADR-0013: admin-api forwards these to `request.billing.admin.*Plan`; the
  // actor comes from the verified principal, never from the body, so no
  // `createdBy` / `updatedBy` argument exists to pass.
  createPlan: (data: CreatePlanDto) =>
    apiFetch<PlanDefinition>('/billing/plans', { method: 'POST', body: JSON.stringify(data) }),
  updatePlan: (id: string, data: UpdatePlanDto) =>
    apiFetch<PlanDefinition>(`/billing/plans/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deprecatePlan: (id: string) =>
    apiFetch<PlanDefinition>(`/billing/plans/${id}/deprecate`, { method: 'POST' }),
  comparePlans: (currentPlanId: string, newPlanId: string) =>
    apiFetch<PlanComparison>('/billing/plans/compare', { method: 'POST', body: JSON.stringify({ currentPlanId, newPlanId }) }),
  getPlanByTier: (tier: string) =>
    apiFetch<PlanDefinition | null>(`/billing/plans/tier/${tier}`),
  // The canonical PLAN_CATALOG limits for a tier (ADR-037), as the backend
  // publishes them — the previous hand-written five-field shape named none of
  // the seventeen fields the endpoint actually returns.
  getDefaultLimitsForTier: (tier: string) =>
    apiFetch<PlanLimits>(`/billing/plans/defaults/${tier}`),

  // Discount Codes
  //
  // ADR-0013: billing owns the catalogue and admin-api forwards every write.
  // The paged reads return `{ data, total, page, limit }` — the previous
  // client typed them as a bare array, so `.map` on the response was always
  // going to be `undefined` at runtime.
  getDiscountCodes: (options?: {
    isActive?: boolean;
    campaignId?: string;
    includeExpired?: boolean;
    page?: number;
    limit?: number;
  }) => apiFetch<DiscountCodePage>(`/billing/discounts?${buildQueryString(options || {})}`),
  getDiscountStats: () => apiFetch<DiscountStats>('/billing/discounts/stats'),
  getDiscountById: (id: string) => apiFetch<DiscountCode>(`/billing/discounts/${id}`),
  getDiscountByCode: (code: string) =>
    apiFetch<DiscountCodeLookup>(`/billing/discounts/code/${code}`),
  // The actor is never a body property: the server reads it from the verified
  // principal and REFUSES a body that claims one (ADMIN-CRITICAL-008), and the
  // contract type no longer has the field to strip.
  createDiscountCode: (data: CreateDiscountCodeDto) =>
    apiFetch<DiscountCode>('/billing/discounts', { method: 'POST', body: JSON.stringify(data) }),
  // Only the mutable half: a code's value, its code and its campaign are minted
  // once, and the server refuses a body that tries to change them.
  updateDiscountCode: (id: string, data: UpdateDiscountCodeDto) =>
    apiFetch<DiscountCode>(`/billing/discounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deactivateDiscountCode: (id: string) =>
    apiFetch<DiscountCode>(`/billing/discounts/${id}/deactivate`, { method: 'POST' }),
  validateDiscountCode: (
    code: string,
    tenantId: string,
    options?: {
      planId?: string;
      subscriptionChange?: DiscountSubscriptionChange;
      /** Exact decimal string. */
      orderAmount?: string;
    },
  ) =>
    apiFetch<DiscountValidation>('/billing/discounts/validate', {
      method: 'POST',
      body: JSON.stringify({ code, tenantId, ...options }),
    }),
  generateUniqueCode: (prefix?: string, length?: number) =>
    apiFetch<{ code: string }>('/billing/discounts/generate-code', {
      method: 'POST',
      body: JSON.stringify({ prefix, length }),
    }),
  applyDiscount: (
    code: string,
    tenantId: string,
    /** Exact decimal string — money is never sent as a float. */
    orderAmount: string,
    options?: {
      subscriptionId?: string;
      invoiceId?: string;
      planId?: string;
      subscriptionChange?: DiscountSubscriptionChange;
    },
  ) =>
    apiFetch<DiscountApplication>('/billing/discounts/apply', {
      method: 'POST',
      body: JSON.stringify({ code, tenantId, orderAmount, ...options }),
    }),
  bulkCreateDiscounts: (count: number, template: DiscountCodeTemplate, codePrefix?: string) =>
    apiFetch<{ success: boolean; count: number; codes: DiscountCode[] }>(
      '/billing/discounts/bulk-create',
      { method: 'POST', body: JSON.stringify({ count, template, codePrefix }) },
    ),
  getDiscountRedemptions: (discountId: string, options?: { page?: number; limit?: number }) =>
    apiFetch<DiscountRedemptionPage>(
      `/billing/discounts/${discountId}/redemptions?${buildQueryString(options || {})}`,
    ),
  getTenantRedemptions: (tenantId: string, options?: { page?: number; limit?: number }) =>
    apiFetch<DiscountRedemptionPage>(
      `/billing/tenant/${tenantId}/redemptions?${buildQueryString(options || {})}`,
    ),

  // Subscriptions
  getSubscriptions: (filters?: {
    status?: SubscriptionStatus[];
    planTier?: PlanTier[];
    search?: string;
    limit?: number;
    offset?: number;
  }) => apiFetch<{ subscriptions: SubscriptionOverview[]; total: number }>(`/billing/subscriptions?${buildQueryString(filters || {})}`),
  getSubscriptionStats: () => apiFetch<SubscriptionStats>('/billing/subscriptions/stats'),
  getSubscriptionReminders: () =>
    apiFetch<Array<{ tenantId: string; tenantName: string; daysUntilExpiry: number; type: 'trial' | 'subscription' }>>('/billing/subscriptions/reminders'),
  getSubscriptionByTenant: (tenantId: string) =>
    apiFetch<SubscriptionOverview | null>(`/billing/subscriptions/tenant/${tenantId}`),
  changePlan: (request: { tenantId: string; currentPlanId: string; newPlanId: string; changedBy?: string }) => {
    const { changedBy: _changedBy, ...payload } = request;
    return apiFetch<Record<string, unknown>>('/billing/subscriptions/change-plan', { method: 'POST', body: JSON.stringify(payload) });
  },
  cancelSubscription: (tenantId: string, reason: string, _cancelledBy?: string) =>
    apiFetch<{ success: boolean }>(`/billing/subscriptions/tenant/${tenantId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  reactivateSubscription: (tenantId: string, _reactivatedBy?: string) =>
    apiFetch<{ success: boolean }>(`/billing/subscriptions/tenant/${tenantId}/reactivate`, {
      method: 'POST',
    }),
  extendTrial: (tenantId: string, additionalDays: number, _extendedBy?: string) =>
    apiFetch<{ success: boolean; newTrialEnd: string }>(`/billing/subscriptions/tenant/${tenantId}/extend-trial`, {
      method: 'POST',
      body: JSON.stringify({ additionalDays }),
    }),

  // Invoices
  getInvoices: (params?: { status?: string; search?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.append('status', params.status);
    if (params?.search) searchParams.append('search', params.search);
    if (params?.limit) searchParams.append('limit', String(params.limit));
    if (params?.offset) searchParams.append('offset', String(params.offset));
    return apiFetch<{ invoices: InvoiceOverview[]; total: number }>(
      `/billing/invoices?${searchParams.toString()}`
    );
  },
  getInvoiceStats: () =>
    apiFetch<InvoiceStats>('/billing/invoices/stats'),
  getInvoiceById: (invoiceId: string) =>
    apiFetch<InvoiceOverview>(`/billing/invoices/${invoiceId}`),
  markInvoicePaid: (invoiceId: string, amount: number) =>
    apiFetch<{ success: boolean; invoice: InvoiceOverview }>(`/billing/invoices/${invoiceId}/mark-paid`, {
      method: 'POST',
      body: JSON.stringify({ amount }),
    }),
  voidInvoice: (invoiceId: string, reason: string) =>
    apiFetch<{ success: boolean }>(`/billing/invoices/${invoiceId}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  createInvoice: (data: {
    tenantId: string;
    billingAddress: {
      companyName: string;
      attention?: string;
      street: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
      taxId?: string;
    };
    lineItems: Array<{
      description: string;
      quantity: number;
      unitPrice: number;
      productCode?: string;
    }>;
    currency: string;
    dueDate: string;
    periodStart: string;
    periodEnd: string;
    notes?: string;
  }) =>
    apiFetch<InvoiceOverview>('/billing/invoices', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Payments
  getPayments: (params?: { status?: string; invoiceId?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.append('status', params.status);
    if (params?.invoiceId) searchParams.append('invoiceId', params.invoiceId);
    if (params?.limit) searchParams.append('limit', String(params.limit));
    if (params?.offset) searchParams.append('offset', String(params.offset));
    return apiFetch<{ payments: PaymentOverview[]; total: number }>(
      `/billing/payments?${searchParams.toString()}`
    );
  },
  recordPayment: (data: RecordPaymentDto) =>
    apiFetch<PaymentOverview>('/billing/payments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  refundPayment: (data: RefundPaymentDto) =>
    apiFetch<PaymentOverview>('/billing/payments/refund', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Module Pricing
  //
  // ADR-0013: billing owns `billing.module_prices` and admin-api forwards every
  // write. A price change publishes a NEW effective window rather than editing
  // one, so an invoice can be read back against the prices that produced it.
  getModulePricings: () => apiFetch<ModulePricing[]>('/billing/module-pricing'),
  getModulePricingByCode: (moduleCode: string) =>
    apiFetch<ModulePricing | null>(`/billing/module-pricing/code/${moduleCode}`),
  getModulePricingWithModules: () =>
    apiFetch<ModulePricingWithModule[]>('/billing/module-pricing/with-modules'),
  getModulePricingHistory: (moduleId: string, options?: { page?: number; limit?: number }) =>
    apiFetch<ModulePricingPage>(
      `/billing/module-pricing/${moduleId}/history?${buildQueryString(options || {})}`,
    ),
  setModulePricing: (data: SetModulePricingDto) =>
    apiFetch<ModulePricing>('/billing/module-pricing', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateModulePricing: (pricingId: string, data: UpdateModulePricingDto) =>
    apiFetch<ModulePricing>(`/billing/module-pricing/${pricingId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deactivateModulePricing: (pricingId: string) =>
    apiFetch<ModulePricing>(`/billing/module-pricing/${pricingId}/deactivate`, { method: 'POST' }),
  // The code → id mapping is resolved server-side from `auth.modules`; a
  // client-supplied map could point one module's prices at another module.
  seedModulePricing: (moduleCodes: string[]) =>
    apiFetch<SeedModulePricesResult>('/billing/module-pricing/seed', {
      method: 'POST',
      body: JSON.stringify({ moduleCodes }),
    }),

  // Quotes — billing does the arithmetic; nothing here recomputes a total.
  calculatePricing: (request: QuoteRequest) =>
    apiFetch<PricingCalculation>('/billing/pricing/calculate', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
  getQuickEstimate: (moduleCodes: string[], tier: PlanTier, quantities?: ModuleQuantities) =>
    apiFetch<QuickEstimateResult>('/billing/pricing/quick-estimate', {
      method: 'POST',
      body: JSON.stringify({ moduleCodes, tier, quantities }),
    }),
  comparePricing: (config1: QuoteRequest, config2: QuoteRequest) =>
    apiFetch<PricingComparisonResult>('/billing/pricing/compare', {
      method: 'POST',
      body: JSON.stringify({ config1, config2 }),
    }),

  // Custom Plans
  getCustomPlans: (filter?: CustomPlanFilter) =>
    apiFetch<PaginatedCustomPlans>(`/billing/custom-plans?${buildQueryString((filter || {}) as Record<string, unknown>)}`),
  getCustomPlan: (planId: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}`),
  getCustomPlanByTenant: (tenantId: string) =>
    apiFetch<CustomPlan | null>(`/billing/custom-plans/tenant/${tenantId}`),
  // The actor is never a body property: the server reads it from the verified
  // principal and REFUSES a body that claims one (ADMIN-CRITICAL-008).
  createCustomPlan: (data: CreateCustomPlanDto) =>
    apiFetch<CustomPlan>('/billing/custom-plans', { method: 'POST', body: JSON.stringify(data) }),
  updateCustomPlan: (planId: string, data: UpdateCustomPlanDto) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}`, { method: 'PUT', body: JSON.stringify(data) }),
  submitCustomPlanForApproval: (planId: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}/submit`, { method: 'POST' }),
  approveCustomPlan: (planId: string, _approverId?: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}/approve`, { method: 'POST' }),
  rejectCustomPlan: (planId: string, reason: string, _rejectedBy?: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  activateCustomPlan: (planId: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}/activate`, { method: 'POST' }),
  deleteCustomPlan: (planId: string) =>
    apiFetch<{ success: boolean }>(`/billing/custom-plans/${planId}`, { method: 'DELETE' }),
  cloneCustomPlan: (planId: string, newTenantId: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}/clone`, { method: 'POST', body: JSON.stringify({ newTenantId }) }),

  // Usage Metering
  getUsageSummary: (params?: { period?: AggregationPeriod; dateFrom?: string; dateTo?: string }) =>
    apiFetch<UsageSummaryStats>(`/billing/usage/summary?${buildQueryString(params || {})}`),
  getAllTenantsUsage: (params?: { period?: AggregationPeriod; dateFrom?: string; dateTo?: string; limit?: number; offset?: number }) =>
    apiFetch<{ tenants: TenantUsageOverview[]; total: number }>(`/billing/usage/tenants?${buildQueryString(params || {})}`),
  getTenantUsageOverview: (tenantId: string, params?: { period?: AggregationPeriod; dateFrom?: string; dateTo?: string }) =>
    apiFetch<TenantUsageOverview>(`/billing/usage/tenant/${tenantId}?${buildQueryString(params || {})}`),
  getUsageTrends: (params?: { period?: AggregationPeriod; meterType?: MeterType; tenantId?: string; numPeriods?: number }) =>
    apiFetch<UsageTrendPoint[]>(`/billing/usage/trends?${buildQueryString(params || {})}`),
  getTopTenantsByUsage: (meterType: MeterType, params?: { period?: AggregationPeriod; limit?: number; dateFrom?: string; dateTo?: string }) =>
    apiFetch<TopTenantUsage[]>(`/billing/usage/top-tenants?${buildQueryString({ meterType, ...(params || {}) })}`),
};
