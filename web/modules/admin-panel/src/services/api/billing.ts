/**
 * Billing API (Plans, Subscriptions, Invoices, Discounts, Module Pricing, Custom Plans, Payments)
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PlanDefinition,
  PlanTier,
  DiscountCode,
  DiscountStats,
  PaymentOverview,
  RecordPaymentDto,
  RefundPaymentDto,
  SubscriptionOverview,
  SubscriptionStatus,
  SubscriptionStats,
  InvoiceOverview,
  InvoiceStats,
  ModulePricing,
  ModulePricingWithModule,
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
  createPlan: (data: Partial<PlanDefinition>) =>
    apiFetch<PlanDefinition>('/billing/plans', { method: 'POST', body: JSON.stringify(data) }),
  updatePlan: (id: string, data: Partial<PlanDefinition>) =>
    apiFetch<PlanDefinition>(`/billing/plans/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deprecatePlan: (id: string, _updatedBy?: string) =>
    apiFetch<PlanDefinition>(`/billing/plans/${id}/deprecate`, { method: 'POST' }),
  comparePlans: (currentPlanId: string, newPlanId: string) =>
    apiFetch<Record<string, unknown>>('/billing/plans/compare', { method: 'POST', body: JSON.stringify({ currentPlanId, newPlanId }) }),
  seedPlans: (_createdBy?: string) =>
    apiFetch<{ success: boolean }>('/billing/plans/seed', { method: 'POST' }),
  getPlanByTier: (tier: string) =>
    apiFetch<PlanDefinition>(`/billing/plans/tier/${tier}`),
  getDefaultLimitsForTier: (tier: string) =>
    apiFetch<{ users: number; farms: number; sensors: number; storage: number; apiCallsPerDay: number }>(`/billing/plans/defaults/${tier}`),

  // Discount Codes
  getDiscountCodes: (options?: { isActive?: boolean; includeExpired?: boolean }) =>
    apiFetch<DiscountCode[]>(`/billing/discounts?${buildQueryString(options || {})}`),
  getDiscountStats: () => apiFetch<DiscountStats>('/billing/discounts/stats'),
  getDiscountById: (id: string) => apiFetch<DiscountCode>(`/billing/discounts/${id}`),
  getDiscountByCode: (code: string) => apiFetch<{ found: boolean; discount?: DiscountCode }>(`/billing/discounts/code/${code}`),
  createDiscountCode: (data: Partial<DiscountCode>) => {
    const { createdBy: _createdBy, ...payload } = data;
    return apiFetch<DiscountCode>('/billing/discounts', { method: 'POST', body: JSON.stringify(payload) });
  },
  updateDiscountCode: (id: string, data: Partial<DiscountCode>) =>
    apiFetch<DiscountCode>(`/billing/discounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deactivateDiscountCode: (id: string, _updatedBy?: string) =>
    apiFetch<DiscountCode>(`/billing/discounts/${id}/deactivate`, { method: 'POST' }),
  validateDiscountCode: (code: string, tenantId: string, planId?: string, orderAmount?: number) =>
    apiFetch<{ valid: boolean; discountCode?: DiscountCode; discountAmount?: number }>('/billing/discounts/validate', {
      method: 'POST',
      body: JSON.stringify({ code, tenantId, planId, orderAmount }),
    }),
  generateUniqueCode: (prefix?: string, length?: number) =>
    apiFetch<{ code: string }>('/billing/discounts/generate-code', { method: 'POST', body: JSON.stringify({ prefix, length }) }),
  applyDiscount: (code: string, tenantId: string, originalAmount: number, options?: { subscriptionId?: string; invoiceId?: string; planId?: string; redeemedBy?: string }) =>
    apiFetch<{ success: boolean; originalAmount: number; discountAmount: number; finalAmount: number; redemptionId?: string }>('/billing/discounts/apply', {
      method: 'POST',
      body: JSON.stringify({ code, tenantId, originalAmount, ...options }),
    }),
  bulkCreateDiscounts: (count: number, template: Omit<Partial<DiscountCode>, 'code'>, codePrefix?: string) =>
    apiFetch<{ success: boolean; count: number; codes: DiscountCode[] }>('/billing/discounts/bulk-create', {
      method: 'POST',
      body: JSON.stringify({ count, template, codePrefix }),
    }),
  getDiscountRedemptions: (discountId: string) =>
    apiFetch<Array<{ id: string; tenantId: string; tenantName: string; redeemedAt: string; amount: number }>>(`/billing/discounts/${discountId}/redemptions`),
  getTenantRedemptions: (tenantId: string) =>
    apiFetch<Array<{ id: string; discountCode: string; redeemedAt: string; amount: number }>>(`/billing/tenant/${tenantId}/redemptions`),

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
  getModulePricings: () =>
    apiFetch<ModulePricing[]>('/billing/module-pricing'),
  getModulePricingByCode: (moduleCode: string) =>
    apiFetch<ModulePricing | null>(`/billing/module-pricing/code/${moduleCode}`),
  getModulePricingWithModules: () =>
    apiFetch<ModulePricingWithModule[]>('/billing/module-pricing/with-modules'),
  setModulePricing: (data: SetModulePricingDto) =>
    apiFetch<ModulePricing>('/billing/module-pricing', { method: 'POST', body: JSON.stringify(data) }),
  updateModulePricing: (pricingId: string, data: Partial<SetModulePricingDto>) =>
    apiFetch<ModulePricing>(`/billing/module-pricing/${pricingId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deactivateModulePricing: (pricingId: string) =>
    apiFetch<{ success: boolean }>(`/billing/module-pricing/${pricingId}/deactivate`, { method: 'POST' }),
  seedModulePricing: (moduleIdMap: Record<string, string>) =>
    apiFetch<{ success: boolean; seededCount: number }>('/billing/module-pricing/seed', {
      method: 'POST',
      body: JSON.stringify({ moduleIdMap }),
    }),

  // Pricing Calculator
  calculatePricing: (request: QuoteRequest) =>
    apiFetch<PricingCalculation>('/billing/pricing/calculate', { method: 'POST', body: JSON.stringify(request) }),
  getQuickEstimate: (moduleCodes: string[], tier: PlanTier, quantities?: ModuleQuantities) =>
    apiFetch<{ monthlyTotal: number; annualTotal: number }>('/billing/pricing/quick-estimate', {
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
  createCustomPlan: (data: CreateCustomPlanDto) => {
    const { createdBy: _createdBy, ...payload } = data;
    return apiFetch<CustomPlan>('/billing/custom-plans', { method: 'POST', body: JSON.stringify(payload) });
  },
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
