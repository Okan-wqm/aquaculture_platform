import { BillingCycle, PlanTier } from '../entities/plan-definition.entity';

/**
 * Subscription status enum - matches billing-service
 */
export enum SubscriptionStatus {
  TRIAL = 'trial',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELLED = 'cancelled',
  SUSPENDED = 'suspended',
  EXPIRED = 'expired',
}

/**
 * Subscription overview for admin
 */
export interface SubscriptionOverview {
  id: string;
  tenantId: string;
  tenantName: string;
  planTier: string;
  planName: string;
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  monthlyPrice: number;
  autoRenew: boolean;
  trialEndDate?: Date;
  cancelledAt?: Date;
  createdAt: Date;
}

/**
 * Plan change request
 */
export interface PlanChangeRequest {
  tenantId: string;
  currentPlanId: string;
  newPlanId: string;
  newBillingCycle?: BillingCycle;
  discountCode?: string;
  effectiveImmediately?: boolean;
  changedBy: string;
}

/**
 * Plan change result
 */
export interface PlanChangeResult {
  success: boolean;
  isUpgrade: boolean;
  isDowngrade: boolean;
  proratedAmount: number;
  newMonthlyPrice: number;
  effectiveDate: Date;
  invoice?: {
    id: string;
    amount: number;
    dueDate: Date;
  };
  warnings: string[];
  message: string;
}

/**
 * Payment reminder configuration
 */
export interface ReminderConfig {
  daysBeforeDue: number[];
  daysAfterDue: number[];
  gracePeriodDays: number;
  suspendAfterDays: number;
  cancelAfterDays: number;
}

/**
 * Subscription list filters
 */
export interface SubscriptionFilters {
  status?: SubscriptionStatus[];
  planTier?: PlanTier[];
  billingCycle?: BillingCycle[];
  autoRenew?: boolean;
  search?: string;
  expiringWithinDays?: number;
  pastDueOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Subscription stats for dashboard
 */
export interface SubscriptionStats {
  totalSubscriptions: number;
  byStatus: Record<SubscriptionStatus, number>;
  byPlanTier: Record<string, number>;
  byBillingCycle: Record<string, number>;
  mrr: number; // Monthly Recurring Revenue
  arr: number; // Annual Recurring Revenue
  churnRate: number;
  averageRevenuePerUser: number;
  trialConversionRate: number;
  expiringThisMonth: number;
  pastDueCount: number;
  totalRevenue: number;
}

/**
 * Module quantities for subscription
 */
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

/**
 * Line item for module pricing
 */
export interface ModuleLineItem {
  metric: string;
  quantity: number;
  unitPrice: number;
  total: number;
  description?: string;
}

/**
 * Module configuration for subscription creation
 */
export interface SubscriptionModuleConfig {
  moduleId: string;
  moduleCode: string;
  moduleName?: string;
  quantities: ModuleQuantities;
  lineItems?: ModuleLineItem[];
  subtotal: number;
}

/**
 * Create subscription request DTO
 */
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

/**
 * Create subscription result
 */
export interface CreateSubscriptionResult {
  success: boolean;
  subscription: {
    id: string;
    tenantId: string;
    status: SubscriptionStatus;
    planTier: PlanTier;
    billingCycle: BillingCycle;
    monthlyPrice: number;
    trialEndDate?: Date;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
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
