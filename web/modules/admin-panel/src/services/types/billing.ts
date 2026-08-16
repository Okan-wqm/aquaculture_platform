/**
 * Billing domain types (Plans, Subscriptions, Invoices, Discounts, Module Pricing, Custom Plans)
 */

import type { AdminApiRouteResponse } from './generated/admin-route-contracts';
import {
  PricingMetricType,
  type PricingModuleQuantities,
} from '@platform/pricing-metric-vocabulary';

export { PricingMetricType } from '@platform/pricing-metric-vocabulary';

// ============================================================================
// Billing Enums
// ============================================================================

// Mirror of the canonical `BillingPlanTier` SSoT
// (libs/event-contracts/src/billing/billing-plan-tier.ts). Web modules cannot
// import a backend `@platform/*` library, so this literal is PINNED member-for-
// member to the SSoT by `tests/invariants/tier-enum-ssot.spec.ts` (Faz D, D8) —
// adding/removing a value here without mirroring the SSoT fails that invariant.
export enum PlanTier {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
  CUSTOM = 'custom',
}

export enum BillingCycle {
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  SEMI_ANNUAL = 'semi_annual',
  ANNUAL = 'annual',
}

export enum SubscriptionStatus {
  TRIAL = 'trial',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELLED = 'cancelled',
  SUSPENDED = 'suspended',
  EXPIRED = 'expired',
}

export enum DiscountType {
  PERCENTAGE = 'percentage',
  FIXED_AMOUNT = 'fixed_amount',
  FREE_TRIAL_EXTENSION = 'free_trial_extension',
  FREE_MONTHS = 'free_months',
}

export enum DiscountAppliesTo {
  ALL_PLANS = 'all_plans',
  SPECIFIC_PLANS = 'specific_plans',
  UPGRADES_ONLY = 'upgrades_only',
  NEW_SUBSCRIPTIONS_ONLY = 'new_subscriptions_only',
}

export enum DiscountDuration {
  ONCE = 'once',
  FOREVER = 'forever',
  REPEATING = 'repeating',
}

export enum CustomPlanStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  ACTIVE = 'active',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

// ============================================================================
// Plan Types
// ============================================================================

export interface PlanPricing {
  basePrice: number;
  perUserPrice: number;
  perFarmPrice: number;
  perModulePrice: number;
  discountPercent?: number;
}

export interface PlanLimits {
  maxUsers: number;
  maxFarms: number;
  maxSensors: number;
  maxPonds: number;
  storageGB: number;
  apiCallsPerMonth: number;
  dataRetentionDays: number;
  customReports: boolean;
  advancedAnalytics: boolean;
  apiAccess: boolean;
  whiteLabeling: boolean;
  ssoEnabled: boolean;
  prioritySupport: boolean;
  [key: string]: number | boolean;
}

export interface PlanFeatures {
  coreFeatures: string[];
  advancedFeatures: string[];
  premiumFeatures: string[];
}

export type PlanDefinition = AdminApiRouteResponse<'GET /billing/plans'>[number];

// ============================================================================
// Discount Types
// ============================================================================

export interface DiscountCode {
  id: string;
  code: string;
  name: string;
  description?: string;
  discountType: DiscountType;
  discountValue: number;
  appliesTo: DiscountAppliesTo;
  duration: DiscountDuration;
  durationInMonths?: number;
  isActive: boolean;
  validFrom?: string;
  validUntil?: string;
  maxRedemptions?: number;
  maxRedemptionsPerTenant?: number;
  currentRedemptions: number;
  campaignId?: string;
  campaignName?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type DiscountStats = AdminApiRouteResponse<'GET /billing/discounts/stats'>;

export interface CreateDiscountCodeDto {
  code: string;
  name: string;
  description?: string;
  discountType: DiscountType;
  discountValue: number;
  appliesTo: DiscountAppliesTo;
  duration: DiscountDuration;
  durationInMonths?: number;
  validFrom?: string;
  validUntil?: string;
  maxRedemptions?: number;
  maxRedemptionsPerTenant?: number;
  campaignId?: string;
  campaignName?: string;
  createdBy?: string;
}

// ============================================================================
// Subscription Types
// ============================================================================

export type SubscriptionOverview =
  AdminApiRouteResponse<'GET /billing/subscriptions'>['subscriptions'][number];

export interface SubscriptionStats {
  totalSubscriptions: number;
  byStatus: Record<string, number>;
  byPlanTier: Record<string, number>;
  byBillingCycle: Record<string, number>;
  mrr: number;
  arr: number;
  churnRate: number;
  averageRevenuePerUser: number;
  trialConversionRate: number;
  expiringThisMonth: number;
  pastDueCount: number;
  totalRevenue: number;
}

// ============================================================================
// Invoice Types
// ============================================================================

export interface InvoiceOverview {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  tenantName: string;
  tenantEmail?: string;
  amount: number;
  amountPaid: number;
  amountDue: number;
  status: string;
  currency: string;
  dueDate: string;
  paidAt?: string | null;
  issueDate: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

export interface InvoiceStats {
  totalInvoices: number;
  totalAmount: number;
  totalPaid: number;
  totalPending: number;
  totalOverdue: number;
  byStatus: Record<string, { count: number; amount: number }>;
  byCurrency: Record<string, number>;
  avgPaymentTime: number;
  overdueRate: number;
  paidThisMonth: number;
  pendingThisMonth: number;
}

// ============================================================================
// Payment Types
// ============================================================================

export enum PaymentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
  PARTIALLY_REFUNDED = 'partially_refunded',
}

export enum PaymentMethod {
  CREDIT_CARD = 'credit_card',
  DEBIT_CARD = 'debit_card',
  BANK_TRANSFER = 'bank_transfer',
  WIRE_TRANSFER = 'wire_transfer',
  ACH = 'ach',
  SEPA = 'sepa',
  PAYPAL = 'paypal',
  CHECK = 'check',
  CASH = 'cash',
  OTHER = 'other',
}

export interface RefundInfo {
  amount: number;
  reason: string;
  refundedAt: string;
  refundId?: string;
}

export interface PaymentOverview {
  id: string;
  tenantId: string;
  transactionId: string;
  invoiceId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  paymentMethod: PaymentMethod;
  paymentDate: string;
  processedAt?: string;
  failureReason?: string;
  refunds?: RefundInfo[];
  refundedAmount: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface RecordPaymentDto {
  invoiceId: string;
  amount: number;
  paymentMethod: PaymentMethod;
  paymentDate?: string;
  currency?: string;
  notes?: string;
}

export interface RefundPaymentDto {
  paymentId: string;
  amount: number;
  reason: string;
}

// ============================================================================
// Module Pricing Types
// ============================================================================

export type PricingMetric =
  AdminApiRouteResponse<'GET /billing/module-pricing/with-modules'>[number]['pricingMetrics'][number];

export interface TierMultipliers {
  [PlanTier.FREE]?: number;
  [PlanTier.STARTER]?: number;
  [PlanTier.PROFESSIONAL]?: number;
  [PlanTier.ENTERPRISE]?: number;
  [PlanTier.CUSTOM]?: number;
}

export interface ModulePricing {
  id: string;
  moduleId: string;
  moduleCode: string;
  pricingMetrics: PricingMetric[];
  tierMultipliers: TierMultipliers;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  notes: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ModulePricingWithModule =
  AdminApiRouteResponse<'GET /billing/module-pricing/with-modules'>[number];

export interface SetModulePricingDto {
  moduleId: string;
  moduleCode: string;
  pricingMetrics: PricingMetric[];
  tierMultipliers?: TierMultipliers;
  currency?: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  notes?: string;
}

export type ModuleQuantities = PricingModuleQuantities;

export interface ModuleSelection {
  moduleId: string;
  moduleCode: string;
  moduleName?: string;
  quantities: ModuleQuantities;
}

export interface QuoteRequest {
  modules: ModuleSelection[];
  tier: PlanTier;
  billingCycle: BillingCycle;
  discountCode?: string;
  taxRate?: number;
}

export interface PricingLineItem {
  metric: PricingMetricType;
  metricLabel: string;
  quantity: number;
  includedQuantity: number;
  billableQuantity: number;
  unitPrice: number;
  total: number;
  tierMultiplier: number;
}

export interface ModulePriceBreakdown {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  lineItems: readonly PricingLineItem[];
  subtotal: number;
  tierDiscount: number;
  total: number;
}

export type PricingCalculation = AdminApiRouteResponse<'POST /billing/pricing/calculate'>;

export interface PricingComparisonResult {
  config1: PricingCalculation;
  config2: PricingCalculation;
  difference: number;
  percentDifference: number;
  recommendation: string;
}

// ============================================================================
// Subscription Creation Types
// ============================================================================

export interface ModuleLineItem {
  metric: string;
  quantity: number;
  unitPrice: number;
  total: number;
  description?: string;
}

export interface SubscriptionModuleConfig {
  moduleId: string;
  moduleCode: string;
  moduleName?: string;
  quantities: ModuleQuantities;
  lineItems?: ModuleLineItem[];
  subtotal: number;
}

export interface CreateSubscriptionDto {
  tenantId: string;
  planTier?: PlanTier;
  billingCycle?: BillingCycle;
  modules: SubscriptionModuleConfig[];
  monthlyTotal: number;
  currency?: string;
  trialDays?: number;
  discountCode?: string;
  createdBy?: string;
}

export interface CreateSubscriptionResult {
  success: boolean;
  subscription: {
    id: string;
    tenantId: string;
    status: SubscriptionStatus;
    planTier: PlanTier;
    billingCycle: BillingCycle;
    monthlyPrice: number;
    trialEndDate?: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
  };
  moduleItems: Array<{
    id: string;
    moduleId: string;
    moduleCode: string;
    quantities: ModuleQuantities;
    monthlyPrice: number;
  }>;
  message: string;
}

// ============================================================================
// Custom Plan Types
// ============================================================================

export interface CustomPlanLineItem {
  metric: string;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface CustomPlanModule {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  quantities: ModuleQuantities;
  lineItems: CustomPlanLineItem[];
  subtotal: number;
}

export type CustomPlan = AdminApiRouteResponse<'GET /billing/custom-plans'>['items'][number];

export interface CustomPlanFilter {
  tenantId?: string;
  status?: CustomPlanStatus;
  tier?: PlanTier;
  search?: string;
  page?: number;
  limit?: number;
}

export type PaginatedCustomPlans = AdminApiRouteResponse<'GET /billing/custom-plans'>;

export interface CreateCustomPlanDto {
  tenantId: string;
  name: string;
  description?: string;
  basePlanId?: string;
  tier?: PlanTier;
  billingCycle?: BillingCycle;
  modules: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    quantities: ModuleQuantities;
  }>;
  discountPercent?: number;
  discountAmount?: number;
  discountReason?: string;
  validFrom: string;
  validTo?: string;
  notes?: string;
  createdBy?: string;
}

export interface UpdateCustomPlanDto {
  name?: string;
  description?: string;
  modules?: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    quantities: ModuleQuantities;
  }>;
  discountPercent?: number;
  discountAmount?: number;
  discountReason?: string;
  validFrom?: string;
  validTo?: string;
  notes?: string;
  updatedBy?: string;
}

// ============================================================================
// Usage Metering Types
// ============================================================================

export enum AggregationPeriod {
  HOURLY = 'hourly',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  YEARLY = 'yearly',
}

export enum MeterType {
  API_CALLS = 'api_calls',
  DATA_STORAGE = 'data_storage',
  SENSOR_READINGS = 'sensor_readings',
  ALERTS_SENT = 'alerts_sent',
  REPORTS_GENERATED = 'reports_generated',
  USERS_ACTIVE = 'users_active',
  FARMS_ACTIVE = 'farms_active',
  PONDS_ACTIVE = 'ponds_active',
  SENSORS_ACTIVE = 'sensors_active',
  DATA_EXPORT = 'data_export',
  INTEGRATIONS = 'integrations',
  CUSTOM = 'custom',
}

export type UsageSummaryStats = AdminApiRouteResponse<'GET /billing/usage/summary'>;
export type MeterBreakdown = UsageSummaryStats['meterBreakdown'][number];
export type TenantUsagePage = AdminApiRouteResponse<'GET /billing/usage/tenants'>;
export type TenantUsageOverview = TenantUsagePage['tenants'][number];
export type TenantMeterUsage = TenantUsageOverview['meters'][number];
export type UsageTrendPoint = AdminApiRouteResponse<'GET /billing/usage/trends'>[number];
export type TopTenantUsage = AdminApiRouteResponse<'GET /billing/usage/top-tenants'>[number];
