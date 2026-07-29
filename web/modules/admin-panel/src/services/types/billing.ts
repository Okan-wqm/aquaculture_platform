/**
 * Billing domain types (Plans, Subscriptions, Invoices, Discounts, Module Pricing, Custom Plans)
 */

// The vocabularies are const objects, so `DiscountType.PERCENTAGE` still
// resolves while the entity remains their only author.
// Vocabularies are const objects, so `DiscountType.PERCENTAGE` still resolves
// while the backend enum stays their only author. Imported as well as
// re-exported so the shapes declared below can reference them.
import {
  PlanTier,
  SubscriptionStatus,
  MeterType,
  DiscountType,
  DiscountAppliesTo,
  DiscountDuration,
  PricingMetricType,
} from './generated/admin-contracts';

export {
  PlanTier,
  SubscriptionStatus,
  MeterType,
  DiscountType,
  DiscountAppliesTo,
  DiscountDuration,
  PricingMetricType,
};

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
import type {
  PlanFeatures,
  PlanLimits,
  PlanDefinition,
  PricingMetric,
  TierMultipliers,
  ModulePricing,
  CustomPlanModule,
  CustomPlanLineItem,
  CustomPlan,
  DiscountCode,
  ModuleQuantities,
  ModuleLineItem,
  SubscriptionModuleConfig,
  SubscriptionOverview,
  SubscriptionStats,
  ModuleSelection,
  ModulePriceBreakdown,
  PricingLineItem,
  PricingCalculation,
  QuoteRequest,
  InvoiceOverview,
  InvoiceStats,
  PaymentOverview,
  TenantUsageOverview,
  TopTenantUsage,
  UsageSummaryStats,
  UsageTrendPoint,
  DiscountStats,
} from './generated/admin-contracts';

export type {
  PlanFeatures,
  PlanLimits,
  PlanDefinition,
  PricingMetric,
  TierMultipliers,
  ModulePricing,
  CustomPlanModule,
  CustomPlanLineItem,
  CustomPlan,
  DiscountCode,
  ModuleQuantities,
  ModuleLineItem,
  SubscriptionModuleConfig,
  SubscriptionOverview,
  SubscriptionStats,
  ModuleSelection,
  ModulePriceBreakdown,
  PricingLineItem,
  PricingCalculation,
  QuoteRequest,
  InvoiceOverview,
  InvoiceStats,
  PaymentOverview,
  TenantUsageOverview,
  TopTenantUsage,
  UsageSummaryStats,
  UsageTrendPoint,
  DiscountStats,
};

// ============================================================================
// Billing Enums
// ============================================================================

export enum BillingCycle {
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  SEMI_ANNUAL = 'semi_annual',
  ANNUAL = 'annual',
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

// `PlanPricing` used to be re-declared here as a FLAT shape — basePrice,
// perUserPrice, perFarmPrice, perModulePrice — against a backend type that is
// nested per billing cycle (monthly / quarterly / semiAnnual / annual, each with
// its own prices and discount). Nothing imported it, which is the only reason
// the contradiction never surfaced; the page that renders plan pricing reaches
// it through the generated `PlanDefinition` and reads `pricing.monthly.*`.
// Generated above, from the entity.

// ============================================================================
// Discount Types
// ============================================================================

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

// ============================================================================
// Invoice Types
// ============================================================================

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

export interface ModulePricingWithModule extends ModulePricing {
  moduleName?: string;
  moduleDescription?: string;
  moduleIcon?: string;
  isModuleActive?: boolean;
}

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

export interface CustomPlanFilter {
  tenantId?: string;
  status?: CustomPlanStatus;
  tier?: PlanTier;
  search?: string;
  page?: number;
  limit?: number;
}

// RC-1: custom-plans now emits the canonical paginated envelope, so the rows
// arrive under .data (like every other admin-panel PaginatedResult) — not .items.
export interface PaginatedCustomPlans {
  data: CustomPlan[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

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

export interface MeterBreakdown {
  meterType: MeterType;
  totalUsage: number;
  avgPerTenant: number;
  maxPerTenant: number;
  unit: string;
  tenantCount: number;
}

export interface TenantMeterUsage {
  meterType: MeterType;
  totalUsage: number;
  unit: string;
  eventCount: number;
  peakUsage: number;
  averageUsage: number;
}
