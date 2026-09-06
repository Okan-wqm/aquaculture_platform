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

/**
 * ADR-0013: the same reason `DiscountType` stopped being a TypeScript `enum`.
 * These were nominal enums whose members were not assignable to the strings
 * the API exchanges, so the request the panel sent and the type it claimed
 * could differ without the compiler noticing.
 */
export type DiscountAppliesTo = NonNullable<ApiSchema<'CreateDiscountCodeDto'>['appliesTo']>;
export const DiscountAppliesTo = {
  ALL_PLANS: 'all_plans',
  SPECIFIC_PLANS: 'specific_plans',
  UPGRADES_ONLY: 'upgrades_only',
  NEW_SUBSCRIPTIONS_ONLY: 'new_subscriptions_only',
} as const satisfies Record<string, DiscountAppliesTo>;

export type DiscountDuration = NonNullable<ApiSchema<'CreateDiscountCodeDto'>['duration']>;
export const DiscountDuration = {
  ONCE: 'once',
  FOREVER: 'forever',
  REPEATING: 'repeating',
} as const satisfies Record<string, DiscountDuration>;

/** What a redemption is for — decides an upgrades-only / new-subscriptions-only code. */
export type DiscountSubscriptionChange = NonNullable<
  ApiSchema<'ApplyDiscountCodeDto'>['subscriptionChange']
>;

/**
 * ADR-0013: derived from the contract, not re-declared. The hand-written enum
 * was missing `per_gb_transfer` and `per_workflow` entirely, so a sheet that
 * priced either rendered its raw key — and being a nominal TypeScript enum its
 * members were not assignable to the strings the API exchanges.
 */
export type PricingMetricType = ApiSchema<'PricingMetricDto'>['metricType'];
export const PricingMetricType = {
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
} as const satisfies Record<string, PricingMetricType>;

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

/**
 * ADR-0013 / CONTRACT-CRITICAL-003: `billing.plans` is the sole catalogue and
 * these are the backend contract's shapes, generated from it.
 *
 * The hand-written versions carried `pricing` as a fixed four-cycle object of
 * IEEE-754 `number`s. billing now prices per cycle in `numeric(19,4)` and puts
 * exact decimal STRINGS on the wire, so a plan sold only monthly no longer
 * publishes three zeroed cycles, and $19.99 stays $19.99 in the browser.
 */
export type PlanDefinition = ApiSchema<'PlanResponseDto'>;
export type PlanCyclePrice = ApiSchema<'PlanCyclePriceResponseDto'>;
export type PlanAddOn = ApiSchema<'PlanAddOnResponseDto'>;
export type PlanLimits = ApiSchema<'PlanLimitsResponseDto'>;
export type PlanFeatures = ApiSchema<'PlanFeaturesResponseDto'>;
export type PlanComparison = ApiSchema<'PlanComparisonResponseDto'>;
export type CreatePlanDto = ApiSchema<'CreatePlanDto'>;
export type UpdatePlanDto = ApiSchema<'UpdatePlanDto'>;

// ============================================================================
// Discount Types
// ============================================================================

/**
 * ADR-0013: billing owns the discount catalogue, and these are its shapes as
 * the contract declares them. The hand-written version carried a single
 * `discountValue: number` — a percentage for one code and an amount of money
 * for the next, which is exactly the ambiguity the backend removed. Each kind
 * now names its own field, and money is an exact decimal string.
 */
export type DiscountCode = ApiSchema<'DiscountCodeResponseDto'>;
export type DiscountCodePage = ApiSchema<'DiscountCodePageDto'>;
export type DiscountRedemption = ApiSchema<'DiscountRedemptionResponseDto'>;
export type DiscountRedemptionPage = ApiSchema<'DiscountRedemptionPageDto'>;
export type DiscountStats = ApiSchema<'DiscountStatsDto'>;
export type DiscountValidation = ApiSchema<'DiscountValidationResponseDto'>;
export type DiscountApplication = ApiSchema<'DiscountApplicationResponseDto'>;
export type DiscountCodeLookup = ApiSchema<'DiscountCodeLookupDto'>;
export type UpdateDiscountCodeDto = ApiSchema<'UpdateDiscountCodeDto'>;
export type BulkCreateDiscountCodesDto = ApiSchema<'BulkCreateDiscountCodesDto'>;
export type DiscountCodeTemplate = ApiSchema<'DiscountCodeTemplateDto'>;

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

/**
 * ADR-0013: billing owns the module price sheet, and these are its shapes as
 * the contract declares them. Every price is an exact decimal STRING; the
 * hand-written versions used `number`, which is how a sheet a customer is
 * quoted from and the invoice they receive drift apart.
 */
export type PricingMetric = ApiSchema<'ModulePriceMetricDto'>;
export type TierMultiplier = ApiSchema<'ModulePriceTierMultiplierDto'>;
export type ModulePricing = ApiSchema<'ModulePriceResponseDto'>;
export type ModulePricingPage = ApiSchema<'ModulePricePageDto'>;
/** The sheet joined to its module (name, icon) — the same response shape. */
export type ModulePricingWithModule = ModulePricing;
export type SetModulePricingDto = ApiSchema<'SetModulePricingDto'>;
export type UpdateModulePricingDto = ApiSchema<'UpdateModulePricingDto'>;
export type SeedModulePricingDto = ApiSchema<'SeedModulePricingDto'>;
export type SeedModulePricesResult = ApiSchema<'SeedModulePricesResultDto'>;

/** The write-side multiplier block, keyed by tier. */
export type TierMultipliers = NonNullable<SetModulePricingDto['tierMultipliers']>;

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

/**
 * ADR-0013: the quote comes from billing, and these are its shapes as the
 * contract declares them. Every amount is an exact decimal STRING — the
 * hand-written `number` versions were the reason a quote could render a cent
 * away from what the invoice would charge.
 */
export type PricingLineItem = ApiSchema<'ModuleQuoteLineItemDto'>;
export type ModulePriceBreakdown = ApiSchema<'ModuleQuoteBreakdownDto'>;
export type PricingCalculation = ApiSchema<'ModuleQuoteResponseDto'>;
export type PricingComparisonResult = ApiSchema<'ModuleQuoteComparisonDto'>;
export type QuickEstimateResult = ApiSchema<'QuickEstimateResponseDto'>;

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
