/**
 * Billing API (Plans, Subscriptions, Invoices, Discounts, Module Pricing, Custom Plans, Payments)
 */

import { apiFetch } from '../http-client';
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
import {
  ADMIN_API_ROUTES,
  type AdminApiRouteBody,
  type AdminApiRoutePath,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';

type CreatePlanInput = AdminApiRouteBody<'POST /billing/plans'>;
type UpdatePlanInput = AdminApiRouteBody<'PUT /billing/plans/:id'>;
type PlanTierPath = AdminApiRoutePath<'GET /billing/plans/tier/:tier'>;
type CreateDiscountInput = AdminApiRouteBody<'POST /billing/discounts'>;
type UpdateDiscountInput = AdminApiRouteBody<'PUT /billing/discounts/:id'>;
type BulkCreateDiscountInput = AdminApiRouteBody<'POST /billing/discounts/bulk-create'>;
type ChangePlanInput = AdminApiRouteBody<'POST /billing/subscriptions/change-plan'>;
type InvoiceQuery = AdminApiRouteQuery<'GET /billing/invoices'>;
type PaymentQuery = AdminApiRouteQuery<'GET /billing/payments'>;

export const billingApi = {
  // Plans
  getPlans: (includeInactive = false) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/plans'], {
      query: { includeInactive: includeInactive },
    }),
  getPublicPlans: () => apiFetch(ADMIN_API_ROUTES['GET /billing/plans/public']),
  getPlanById: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/plans/:id'], { path: { id: id } }),
  getPlanByCode: (code: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/plans/code/:code'], { path: { code: code } }),
  createPlan: (data: CreatePlanInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/plans'], { body: data }),
  updatePlan: (id: string, data: UpdatePlanInput) =>
    apiFetch(ADMIN_API_ROUTES['PUT /billing/plans/:id'], { path: { id: id }, body: data }),
  deprecatePlan: (id: string, _updatedBy?: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/plans/:id/deprecate'], { path: { id: id } }),
  comparePlans: (currentPlanId: string, newPlanId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/plans/compare'], {
      body: { currentPlanId, newPlanId },
    }),
  seedPlans: (_createdBy?: string) => apiFetch(ADMIN_API_ROUTES['POST /billing/plans/seed']),
  getPlanByTier: (tier: PlanTierPath['tier']) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/plans/tier/:tier'], { path: { tier: tier } }),
  getDefaultLimitsForTier: (tier: PlanTierPath['tier']) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/plans/defaults/:tier'], { path: { tier: tier } }),

  // Discount Codes
  getDiscountCodes: (options?: { isActive?: boolean; includeExpired?: boolean }) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/discounts'], { query: options || {} }),
  getDiscountStats: () => apiFetch(ADMIN_API_ROUTES['GET /billing/discounts/stats']),
  getDiscountById: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/discounts/:id'], { path: { id: id } }),
  getDiscountByCode: (code: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/discounts/lookup/code/:code'], {
      path: { code: code },
    }),
  createDiscountCode: (data: CreateDiscountInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/discounts'], { body: data }),
  updateDiscountCode: (id: string, data: UpdateDiscountInput) =>
    apiFetch(ADMIN_API_ROUTES['PUT /billing/discounts/:id'], { path: { id: id }, body: data }),
  deactivateDiscountCode: (id: string, _updatedBy?: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/discounts/:id/deactivate'], { path: { id: id } }),
  validateDiscountCode: (code: string, tenantId: string, planId?: string, orderAmount?: number) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/discounts/validate'], {
      body: { code, tenantId, planId, orderAmount },
    }),
  generateUniqueCode: (prefix?: string, length?: number) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/discounts/generate-code'], {
      body: { prefix, length },
    }),
  applyDiscount: (
    code: string,
    tenantId: string,
    originalAmount: number,
    options?: { subscriptionId?: string; invoiceId?: string; planId?: string; redeemedBy?: string },
  ) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/discounts/apply'], {
      body: { code, tenantId, originalAmount, ...options },
    }),
  bulkCreateDiscounts: ({ count, template, codePrefix }: BulkCreateDiscountInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/discounts/bulk-create'], {
      body: { count, template, codePrefix },
    }),
  getDiscountRedemptions: (discountId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/discounts/:id/redemptions'], {
      path: { id: discountId },
      query: {  },
    }),
  getTenantRedemptions: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/tenant/:tenantId/redemptions'], {
      path: { tenantId: tenantId },
      query: {  },
    }),

  // Subscriptions
  getSubscriptions: (filters?: {
    status?: SubscriptionStatus[];
    planTier?: PlanTier[];
    search?: string;
    limit?: number;
    offset?: number;
  }) => apiFetch(ADMIN_API_ROUTES['GET /billing/subscriptions'], { query: filters || {} }),
  getSubscriptionStats: () => apiFetch(ADMIN_API_ROUTES['GET /billing/subscriptions/stats']),
  getSubscriptionReminders: () =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/subscriptions/reminders']),
  getSubscriptionByTenant: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/subscriptions/tenant/:tenantId'], {
      path: { tenantId: tenantId },
    }),
  changePlan: (request: ChangePlanInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/subscriptions/change-plan'], { body: request }),
  cancelSubscription: (tenantId: string, reason: string, _cancelledBy?: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/subscriptions/tenant/:tenantId/cancel'], {
      path: { tenantId: tenantId },
      body: { reason },
    }),
  reactivateSubscription: (tenantId: string, _reactivatedBy?: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/subscriptions/tenant/:tenantId/reactivate'], {
      path: { tenantId: tenantId },
    }),
  extendTrial: (tenantId: string, additionalDays: number, _extendedBy?: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/subscriptions/tenant/:tenantId/extend-trial'], {
      path: { tenantId: tenantId },
      body: { additionalDays },
    }),
  // Invoices
  getInvoices: (params: InvoiceQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/invoices'], { query: params }),
  getInvoiceStats: () => apiFetch(ADMIN_API_ROUTES['GET /billing/invoices/stats']),
  getInvoiceById: (invoiceId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/invoices/:invoiceId'], {
      path: { invoiceId: invoiceId },
    }),
  markInvoicePaid: (invoiceId: string, amount: number) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/invoices/:invoiceId/mark-paid'], {
      path: { invoiceId: invoiceId },
      body: { amount },
    }),
  voidInvoice: (invoiceId: string, reason: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/invoices/:invoiceId/void'], {
      path: { invoiceId: invoiceId },
      body: { reason },
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
  }) => apiFetch(ADMIN_API_ROUTES['POST /billing/invoices'], { body: data }),

  // Payments
  getPayments: (params: PaymentQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/payments'], { query: params }),
  recordPayment: (data: RecordPaymentDto) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/payments'], { body: data }),
  refundPayment: (data: RefundPaymentDto) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/payments/refund'], { body: data }),

  // Module Pricing
  getModulePricings: () => apiFetch(ADMIN_API_ROUTES['GET /billing/module-pricing']),
  getModulePricingByCode: (moduleCode: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/module-pricing/lookup/code/:moduleCode'], {
      path: { moduleCode: moduleCode },
    }),
  getModulePricingWithModules: () =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/module-pricing/with-modules']),
  setModulePricing: (data: SetModulePricingDto) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/module-pricing'], { body: data }),
  updateModulePricing: (pricingId: string, data: Partial<SetModulePricingDto>) =>
    apiFetch(ADMIN_API_ROUTES['PUT /billing/module-pricing/:pricingId'], {
      path: { pricingId: pricingId },
      body: data,
    }),
  deactivateModulePricing: (pricingId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/module-pricing/:pricingId/deactivate'], {
      path: { pricingId: pricingId },
    }),
  seedModulePricing: (moduleIdMap: Record<string, string>) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/module-pricing/seed'], { body: { moduleIdMap } }),

  // Pricing Calculator
  calculatePricing: (request: QuoteRequest) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/pricing/calculate'], { body: request }),
  getQuickEstimate: (moduleCodes: string[], tier: PlanTier, quantities?: ModuleQuantities) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/pricing/quick-estimate'], {
      body: { moduleCodes, tier, quantities },
    }),
  comparePricing: (config1: QuoteRequest, config2: QuoteRequest) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/pricing/compare'], { body: { config1, config2 } }),

  // Custom Plans
  getCustomPlans: (filter?: CustomPlanFilter) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/custom-plans'], {
      query: (filter || {}) as Record<string, unknown>,
    }),
  getCustomPlan: (planId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/custom-plans/:planId'], { path: { planId: planId } }),
  getCustomPlanByTenant: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/custom-plans/tenant/:tenantId'], {
      path: { tenantId: tenantId },
    }),
  createCustomPlan: (data: CreateCustomPlanDto) => {
    const { createdBy: _createdBy, ...payload } = data;
    return apiFetch(ADMIN_API_ROUTES['POST /billing/custom-plans'], { body: payload });
  },
  updateCustomPlan: (planId: string, data: UpdateCustomPlanDto) =>
    apiFetch(ADMIN_API_ROUTES['PUT /billing/custom-plans/:planId'], {
      path: { planId: planId },
      body: data,
    }),
  submitCustomPlanForApproval: (planId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/custom-plans/:planId/submit'], {
      path: { planId: planId },
    }),
  approveCustomPlan: (planId: string, _approverId?: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/custom-plans/:planId/approve'], {
      path: { planId: planId },
    }),
  rejectCustomPlan: (planId: string, reason: string, _rejectedBy?: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/custom-plans/:planId/reject'], {
      path: { planId: planId },
      body: { reason },
    }),
  activateCustomPlan: (planId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/custom-plans/:planId/activate'], {
      path: { planId: planId },
    }),
  deleteCustomPlan: (planId: string) =>
    apiFetch(ADMIN_API_ROUTES['DELETE /billing/custom-plans/:planId'], {
      path: { planId: planId },
    }),
  cloneCustomPlan: (planId: string, newTenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /billing/custom-plans/:planId/clone'], {
      path: { planId: planId },
      body: { newTenantId },
    }),

  // Usage Metering
  getUsageSummary: (params?: { period?: AggregationPeriod; dateFrom?: string; dateTo?: string }) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/usage/summary'], { query: params || {} }),
  getAllTenantsUsage: (params?: {
    period?: AggregationPeriod;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  }) => apiFetch(ADMIN_API_ROUTES['GET /billing/usage/tenants'], { query: params || {} }),
  getTenantUsageOverview: (
    tenantId: string,
    params?: { period?: AggregationPeriod; dateFrom?: string; dateTo?: string },
  ) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/usage/tenant/:tenantId'], {
      path: { tenantId: tenantId },
      query: params || {},
    }),
  getUsageTrends: (params?: {
    period?: AggregationPeriod;
    meterType?: MeterType;
    tenantId?: string;
    numPeriods?: number;
  }) => apiFetch(ADMIN_API_ROUTES['GET /billing/usage/trends'], { query: params || {} }),
  getTopTenantsByUsage: (
    meterType: MeterType,
    params?: { period?: AggregationPeriod; limit?: number; dateFrom?: string; dateTo?: string },
  ) =>
    apiFetch(ADMIN_API_ROUTES['GET /billing/usage/top-tenants'], {
      query: { meterType, ...(params || {}) },
    }),
};
