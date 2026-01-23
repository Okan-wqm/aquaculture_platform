import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { SubscriptionCoreService } from './subscription-core.service';
import { SubscriptionPlanChangeService } from './subscription-plan-change.service';
import { SubscriptionRenewalService } from './subscription-renewal.service';
import { SubscriptionAnalyticsService } from './subscription-analytics.service';
import {
  SubscriptionStatus,
  SubscriptionOverview,
  PlanChangeRequest,
  PlanChangeResult,
  SubscriptionFilters,
  SubscriptionStats,
  CreateSubscriptionDto,
  CreateSubscriptionResult,
} from './subscription-types';

// Re-export types for backward compatibility
export {
  SubscriptionStatus,
  SubscriptionOverview,
  PlanChangeRequest,
  PlanChangeResult,
  SubscriptionFilters,
  SubscriptionStats,
  CreateSubscriptionDto,
  CreateSubscriptionResult,
  ReminderConfig,
  ModuleQuantities,
  ModuleLineItem,
  SubscriptionModuleConfig,
} from './subscription-types';

/**
 * Subscription Management Service - Facade
 *
 * This service acts as a facade for backward compatibility,
 * delegating to specialized services following SRP:
 * - SubscriptionCoreService: Basic CRUD operations
 * - SubscriptionPlanChangeService: Plan upgrades/downgrades
 * - SubscriptionRenewalService: Renewals and reminders
 * - SubscriptionAnalyticsService: Statistics and metrics
 */
@Injectable()
export class SubscriptionManagementService {
  private readonly logger = new Logger(SubscriptionManagementService.name);

  constructor(
    private readonly coreService: SubscriptionCoreService,
    private readonly planChangeService: SubscriptionPlanChangeService,
    private readonly renewalService: SubscriptionRenewalService,
    private readonly analyticsService: SubscriptionAnalyticsService,
  ) {}

  // ==================== Core Operations ====================

  /**
   * Get all subscriptions with filters
   */
  async getSubscriptions(filters: SubscriptionFilters = {}): Promise<{
    subscriptions: SubscriptionOverview[];
    total: number;
  }> {
    return this.coreService.getSubscriptions(filters);
  }

  /**
   * Get subscription by tenant ID
   */
  async getSubscriptionByTenant(tenantId: string): Promise<SubscriptionOverview | null> {
    return this.coreService.getSubscriptionByTenant(tenantId);
  }

  /**
   * Create a new subscription for a tenant
   */
  async createSubscription(dto: CreateSubscriptionDto): Promise<CreateSubscriptionResult> {
    return this.coreService.createSubscription(dto);
  }

  /**
   * Cancel subscription
   */
  async cancelSubscription(
    tenantId: string,
    reason: string,
    cancelledBy: string,
    cancelImmediately = false,
  ): Promise<{ success: boolean; effectiveDate: Date; message: string }> {
    return this.coreService.cancelSubscription(tenantId, reason, cancelledBy, cancelImmediately);
  }

  /**
   * Reactivate a cancelled subscription
   */
  async reactivateSubscription(
    tenantId: string,
    reactivatedBy: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.coreService.reactivateSubscription(tenantId, reactivatedBy);
  }

  /**
   * Extend trial period
   */
  async extendTrial(
    tenantId: string,
    additionalDays: number,
    extendedBy: string,
  ): Promise<{ success: boolean; newTrialEnd: Date }> {
    return this.coreService.extendTrial(tenantId, additionalDays, extendedBy);
  }

  // ==================== Plan Change Operations ====================

  /**
   * Change subscription plan (upgrade/downgrade)
   */
  async changePlan(request: PlanChangeRequest): Promise<PlanChangeResult> {
    return this.planChangeService.changePlan(request);
  }

  /**
   * Preview plan change without executing
   */
  async previewPlanChange(
    tenantId: string,
    currentPlanId: string,
    newPlanId: string,
    newBillingCycle?: import('../entities/plan-definition.entity').BillingCycle,
  ) {
    return this.planChangeService.previewPlanChange(
      tenantId,
      currentPlanId,
      newPlanId,
      newBillingCycle,
    );
  }

  // ==================== Renewal Operations ====================

  /**
   * Get subscriptions requiring payment reminders
   */
  async getSubscriptionsForReminders(): Promise<{
    upcomingDue: SubscriptionOverview[];
    pastDue: SubscriptionOverview[];
    gracePeriodEnding: SubscriptionOverview[];
  }> {
    return this.renewalService.getSubscriptionsForReminders();
  }

  /**
   * Process subscription renewals
   */
  async processRenewals(): Promise<{
    processed: number;
    failed: number;
    errors: string[];
  }> {
    return this.renewalService.processRenewals();
  }

  /**
   * Get expiring subscriptions
   */
  async getExpiringSubscriptions(withinDays: number): Promise<SubscriptionOverview[]> {
    return this.renewalService.getExpiringSubscriptions(withinDays);
  }

  // ==================== Analytics Operations ====================

  /**
   * Get subscription statistics
   */
  async getStats(): Promise<SubscriptionStats> {
    return this.analyticsService.getStats();
  }

  /**
   * Get MRR trend over time
   */
  async getMrrTrend(months: number = 12) {
    return this.analyticsService.getMrrTrend(months);
  }

  /**
   * Get churn analysis
   */
  async getChurnAnalysis(days: number = 90) {
    return this.analyticsService.getChurnAnalysis(days);
  }

  /**
   * Get revenue breakdown by tier
   */
  async getRevenueByTier() {
    return this.analyticsService.getRevenueByTier();
  }

  /**
   * Get growth metrics
   */
  async getGrowthMetrics(months: number = 3) {
    return this.analyticsService.getGrowthMetrics(months);
  }
}
