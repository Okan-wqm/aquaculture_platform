import {
  Injectable,
  Logger,
} from '@nestjs/common';

import { SubscriptionAnalyticsService } from './subscription-analytics.service';
import { SubscriptionCoreService } from './subscription-core.service';
import { SubscriptionPlanChangeService } from './subscription-plan-change.service';
import { SubscriptionRenewalService } from './subscription-renewal.service';
import {
  SubscriptionStatus,
  SubscriptionOverview,
  SubscriptionFilters,
  SubscriptionStats,
} from './subscription-types';

// Re-export types for backward compatibility. SubscriptionStatus is an
// enum (runtime value); the rest are interfaces (compile-time only).
// Split under isolatedModules so type-only re-exports drop at compile.
export { SubscriptionStatus } from './subscription-types';
export type {
  SubscriptionOverview,
  PlanChangeRequest,
  PlanChangeResult,
  SubscriptionFilters,
  SubscriptionStats,
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

  // ==================== Plan Change Operations ====================

  /**
   * Preview plan change without executing
   */
  async previewPlanChange(
    tenantId: string,
    currentPlanId: string,
    newPlanId: string,
    newBillingCycle?: import('@platform/event-contracts').BillingCycle,
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
  async getMrrTrend(months = 12) {
    return this.analyticsService.getMrrTrend(months);
  }

  /**
   * Get churn analysis
   */
  async getChurnAnalysis(days = 90) {
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
  async getGrowthMetrics(months = 3) {
    return this.analyticsService.getGrowthMetrics(months);
  }
}
