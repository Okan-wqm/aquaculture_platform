/**
 * Billing domain types (Plans, Subscriptions, Invoices, Discounts, Module Pricing, Custom Plans)
 */

// ============================================================================
// Billing Enums
// ============================================================================

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
  createdBy: string;
}

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
