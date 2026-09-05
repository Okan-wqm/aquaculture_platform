/**
 * Billing domain types (Plans, Subscriptions, Invoices, Discounts, Module Pricing, Custom Plans)
 */

import type { ApiSchema } from '../contract';

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

/**
 * Generated from the backend contract (CONTRACT-CRITICAL-003): the values are
 * the ones `CreateDiscountCodeDto` accepts, so a member of this object is
 * assignable where the DTO is expected. A TypeScript `enum` was not — its
 * members are nominal, and the drift was invisible until the contract landed.
 */
export type DiscountType = ApiSchema<'CreateDiscountCodeDto'>['discountType'];
export const DiscountType = {
  PERCENTAGE: 'percentage',
  FIXED_AMOUNT: 'fixed_amount',
  FREE_TRIAL_EXTENSION: 'free_trial_extension',
  FREE_MONTHS: 'free_months',
} as const satisfies Record<string, DiscountType>;

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

export enum PricingMetricType {
  BASE_PRICE = 'base_price',
  PER_USER = 'per_user',
  PER_FARM = 'per_farm',
  PER_POND = 'per_pond',
  PER_SENSOR = 'per_sensor',
  PER_DEVICE = 'per_device',
  PER_GB_STORAGE = 'per_gb_storage',
  PER_API_CALL = 'per_api_call',
  PER_ALERT = 'per_alert',
  PER_REPORT = 'per_report',
  PER_SMS = 'per_sms',
  PER_EMAIL = 'per_email',
  PER_INTEGRATION = 'per_integration',
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

export interface PlanDefinition {
  id: string;
  code: string;
  name: string;
  description?: string;
  shortDescription?: string;
  tier: PlanTier;
  visibility: string;
  isActive: boolean;
  isRecommended: boolean;
  sortOrder: number;
  badge?: string;
  limits: PlanLimits;
  pricing: {
    monthly: PlanPricing;
    quarterly: PlanPricing;
    semiAnnual: PlanPricing;
    annual: PlanPricing;
  };
  features: PlanFeatures;
  trialDays?: number;
  gracePeriodDays?: number;
  createdAt: string;
  updatedAt: string;
}

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

export interface DiscountStats {
  totalCodes: number;
  activeCodes: number;
  expiredCodes: number;
  totalRedemptions: number;
  totalDiscountAmount: number;
  topCodes: Array<{
    code: string;
    redemptions: number;
    totalDiscount: number;
  }>;
}

/** Generated from the backend contract (CONTRACT-CRITICAL-003). */
export type CreateDiscountCodeDto = ApiSchema<'CreateDiscountCodeDto'>;

// ============================================================================
// Subscription Types
// ============================================================================

export interface SubscriptionOverview {
  id: string;
  tenantId: string;
  tenantName: string;
  planTier: string;
  planName: string;
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  monthlyPrice: number;
  autoRenew: boolean;
  trialEndDate?: string;
  cancelledAt?: string;
  createdAt: string;
}

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

/** Generated from the backend contract (CONTRACT-CRITICAL-003). */
export type RecordPaymentDto = ApiSchema<'RecordPaymentDto'>;

/** Generated from the backend contract (CONTRACT-CRITICAL-003). */
export type RefundPaymentDto = ApiSchema<'RefundPaymentDto'>;

// ============================================================================
// Module Pricing Types
// ============================================================================

export interface PricingMetric {
  type: PricingMetricType;
  price: number;
  currency: string;
  description?: string;
  minQuantity?: number;
  maxQuantity?: number;
  includedQuantity?: number;
}

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

export interface ModulePricingWithModule extends ModulePricing {
  moduleName?: string;
  moduleDescription?: string;
  moduleIcon?: string;
  isModuleActive?: boolean;
}

/** Generated from the backend contract (CONTRACT-CRITICAL-003). */
export type SetModulePricingDto = ApiSchema<'SetModulePricingDto'>;

export interface ModuleQuantities {
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
}

export interface ModuleSelection {
  moduleId: string;
  moduleCode: string;
  moduleName?: string;
  quantities: ModuleQuantities;
}

/** Generated from the backend contract (CONTRACT-CRITICAL-003). */
export type QuoteRequest = ApiSchema<'QuoteRequest'>;

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
  lineItems: PricingLineItem[];
  subtotal: number;
  tierDiscount: number;
  total: number;
}

export interface PricingCalculation {
  modules: ModulePriceBreakdown[];
  subtotal: number;
  tierDiscount: number;
  discount: {
    code?: string;
    description?: string;
    amount: number;
    percent: number;
  };
  tax: number;
  taxRate: number;
  total: number;
  monthlyTotal: number;
  annualTotal: number;
  billingCycle: BillingCycle;
  billingCycleMultiplier: number;
  currency: string;
  tier: PlanTier;
  calculatedAt: string;
}

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

export interface CustomPlan {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  basePlanId?: string;
  tier: PlanTier;
  billingCycle: BillingCycle;
  modules: CustomPlanModule[];
  monthlySubtotal: number;
  discountPercent: number;
  discountAmount: number;
  discountReason?: string;
  monthlyTotal: number;
  currency: string;
  status: CustomPlanStatus;
  validFrom: string;
  validTo?: string;
  notes?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectionReason?: string;
  subscriptionId?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomPlanFilter {
  tenantId?: string;
  status?: CustomPlanStatus;
  tier?: PlanTier;
  search?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedCustomPlans {
  items: CustomPlan[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Generated from the backend contract (CONTRACT-CRITICAL-003). */
export type CreateCustomPlanDto = ApiSchema<'CreateCustomPlanDto'>;

/** Generated from the backend contract (CONTRACT-CRITICAL-003). */
export type UpdateCustomPlanDto = ApiSchema<'UpdateCustomPlanDto'>;

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

export interface MeterBreakdown {
  meterType: MeterType;
  totalUsage: number;
  avgPerTenant: number;
  maxPerTenant: number;
  unit: string;
  tenantCount: number;
}

export interface UsageSummaryStats {
  totalTenants: number;
  totalEvents: number;
  meterBreakdown: MeterBreakdown[];
  periodCovered: {
    from: string;
    to: string;
  };
}

export interface TenantMeterUsage {
  meterType: MeterType;
  totalUsage: number;
  unit: string;
  eventCount: number;
  peakUsage: number;
  averageUsage: number;
}

export interface TenantUsageOverview {
  tenantId: string;
  tenantName?: string;
  meters: TenantMeterUsage[];
  totalEvents: number;
  lastActivity?: string;
}

export interface UsageTrendPoint {
  periodStart: string;
  periodEnd: string;
  meterType: MeterType;
  totalUsage: number;
  peakUsage: number;
  averageUsage: number;
  eventCount: number;
  unit: string;
}

export interface TopTenantUsage {
  tenantId: string;
  tenantName?: string;
  totalUsage: number;
  meterType: MeterType;
  unit: string;
  eventCount: number;
}
