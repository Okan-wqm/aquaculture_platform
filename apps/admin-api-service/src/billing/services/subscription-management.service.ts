import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PlanDefinitionService } from './plan-definition.service';
import { DiscountCodeService } from './discount-code.service';
import { PlanDefinition, BillingCycle, PlanTier } from '../entities/plan-definition.entity';

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

/**
 * Subscription Management Service
 * Handles subscription operations for admin panel
 */
@Injectable()
export class SubscriptionManagementService {
  private readonly logger = new Logger(SubscriptionManagementService.name);

  // Default reminder configuration
  private readonly defaultReminderConfig: ReminderConfig = {
    daysBeforeDue: [7, 3, 1],
    daysAfterDue: [1, 3, 7, 14],
    gracePeriodDays: 14,
    suspendAfterDays: 21,
    cancelAfterDays: 30,
  };

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly planService: PlanDefinitionService,
    private readonly discountService: DiscountCodeService,
  ) {}

  /**
   * Get all subscriptions with filters
   */
  async getSubscriptions(filters: SubscriptionFilters = {}): Promise<{
    subscriptions: SubscriptionOverview[];
    total: number;
  }> {
    let query = `
      SELECT
        s.id,
        s."tenantId" as "tenantId",
        t.name as "tenantName",
        s."planTier" as "planTier",
        s."planName" as "planName",
        s.status,
        s."billingCycle" as "billingCycle",
        s."currentPeriodStart" as "currentPeriodStart",
        s."currentPeriodEnd" as "currentPeriodEnd",
        (s.pricing->>'basePrice')::decimal as "monthlyPrice",
        s."autoRenew" as "autoRenew",
        s."trialEndDate" as "trialEndDate",
        s."cancelledAt" as "cancelledAt",
        s."createdAt" as "createdAt"
      FROM public.subscriptions s
      LEFT JOIN public.tenants t ON t.id::text = s."tenantId"
      WHERE 1=1
    `;

    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.status && filters.status.length > 0) {
      query += ` AND s.status = ANY($${paramIndex})`;
      params.push(filters.status);
      paramIndex++;
    }

    if (filters.planTier && filters.planTier.length > 0) {
      query += ` AND s."planTier" = ANY($${paramIndex})`;
      params.push(filters.planTier);
      paramIndex++;
    }

    if (filters.billingCycle && filters.billingCycle.length > 0) {
      query += ` AND s."billingCycle" = ANY($${paramIndex})`;
      params.push(filters.billingCycle);
      paramIndex++;
    }

    if (filters.autoRenew !== undefined) {
      query += ` AND s."autoRenew" = $${paramIndex}`;
      params.push(filters.autoRenew);
      paramIndex++;
    }

    if (filters.search) {
      query += ` AND (t.name ILIKE $${paramIndex} OR s."planName" ILIKE $${paramIndex})`;
      params.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (filters.expiringWithinDays) {
      query += ` AND s."currentPeriodEnd" <= NOW() + INTERVAL '${filters.expiringWithinDays} days'`;
    }

    if (filters.pastDueOnly) {
      query += ` AND s.status = 'past_due'`;
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM (${query}) as subq`;
    const countResult = await this.dataSource.query(countQuery, params);
    const total = parseInt(countResult[0]?.count || '0', 10);

    // Add pagination
    query += ` ORDER BY s."createdAt" DESC`;
    if (filters.limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(filters.limit);
      paramIndex++;
    }
    if (filters.offset) {
      query += ` OFFSET $${paramIndex}`;
      params.push(filters.offset);
    }

    const subscriptions = await this.dataSource.query(query, params);

    return { subscriptions, total };
  }

  /**
   * Get subscription by tenant ID
   */
  async getSubscriptionByTenant(tenantId: string): Promise<SubscriptionOverview | null> {
    const result = await this.dataSource.query(
      `
      SELECT
        s.id,
        s."tenantId" as "tenantId",
        t.name as "tenantName",
        s."planTier" as "planTier",
        s."planName" as "planName",
        s.status,
        s."billingCycle" as "billingCycle",
        s."currentPeriodStart" as "currentPeriodStart",
        s."currentPeriodEnd" as "currentPeriodEnd",
        (s.pricing->>'basePrice')::decimal as "monthlyPrice",
        s."autoRenew" as "autoRenew",
        s."trialEndDate" as "trialEndDate",
        s."cancelledAt" as "cancelledAt",
        s."createdAt" as "createdAt"
      FROM public.subscriptions s
      LEFT JOIN public.tenants t ON t.id::text = s."tenantId"
      WHERE s."tenantId" = $1
    `,
      [tenantId],
    );

    return result[0] || null;
  }

  /**
   * Change subscription plan (upgrade/downgrade)
   */
  async changePlan(request: PlanChangeRequest): Promise<PlanChangeResult> {
    const {
      tenantId,
      currentPlanId,
      newPlanId,
      newBillingCycle,
      discountCode,
      effectiveImmediately,
      changedBy,
    } = request;

    // Get current subscription
    const subscription = await this.getSubscriptionByTenant(tenantId);
    if (!subscription) {
      throw new NotFoundException(`No subscription found for tenant ${tenantId}`);
    }

    // Get plans
    const [currentPlan, newPlan] = await Promise.all([
      this.planService.findById(currentPlanId),
      this.planService.findById(newPlanId),
    ]);

    // Compare plans
    const comparison = await this.planService.comparePlans(currentPlanId, newPlanId);
    const billingCycle = newBillingCycle || (subscription.billingCycle as BillingCycle);

    // Calculate prorated pricing
    const proration = this.planService.calculateProratedPricing(
      currentPlan,
      newPlan,
      new Date(subscription.currentPeriodEnd),
      billingCycle,
    );

    // Apply discount if provided
    let discountAmount = 0;
    if (discountCode && proration.proratedAmount > 0) {
      const discountResult = await this.discountService.validateCode(
        discountCode,
        tenantId,
        newPlanId,
        proration.proratedAmount,
      );

      if (discountResult.valid && discountResult.discountAmount) {
        discountAmount = discountResult.discountAmount;
      }
    }

    const finalAmount = Math.max(0, proration.proratedAmount - discountAmount);
    const effectiveDate = effectiveImmediately
      ? new Date()
      : new Date(subscription.currentPeriodEnd);

    // Execute plan change in transaction
    await this.dataSource.transaction(async (manager) => {
      // Update subscription
      await manager.query(
        `
        UPDATE public.subscriptions SET
          "planTier" = $1,
          "planName" = $2,
          "billingCycle" = $3,
          limits = $4,
          pricing = $5,
          "updatedAt" = NOW(),
          "updatedBy" = $6
        WHERE "tenantId" = $7
      `,
        [
          newPlan.tier,
          newPlan.name,
          billingCycle,
          JSON.stringify(newPlan.limits),
          JSON.stringify(newPlan.pricing),
          changedBy,
          tenantId,
        ],
      );

      // Update tenant limits
      await manager.query(
        `
        UPDATE public.tenants SET
          tier = $1,
          limits = $2,
          "updatedAt" = NOW()
        WHERE id = $3::uuid
      `,
        [newPlan.tier, JSON.stringify(newPlan.limits), tenantId],
      );

      // Create invoice for prorated amount if positive
      if (finalAmount > 0 && effectiveImmediately) {
        const invoiceNumber = `INV-${Date.now()}-${tenantId.substring(0, 8)}`;
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 7);

        await manager.query(
          `
          INSERT INTO public.invoices (
            id, "tenantId", "subscriptionId", "invoiceNumber", status,
            "lineItems", subtotal, discount, "discountCode", total, "amountDue",
            currency, "issueDate", "dueDate", "periodStart", "periodEnd",
            notes, "createdAt", "updatedAt", "createdBy"
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, 'pending',
            $4, $5, $6, $7, $8, $8,
            'USD', NOW(), $9, $10, $11,
            $12, NOW(), NOW(), $13
          )
        `,
          [
            tenantId,
            subscription.id,
            invoiceNumber,
            JSON.stringify([
              {
                description: `Plan change: ${currentPlan.name} to ${newPlan.name} (prorated)`,
                quantity: 1,
                unitPrice: proration.proratedAmount,
                amount: proration.proratedAmount,
              },
            ]),
            proration.proratedAmount,
            discountAmount,
            discountCode,
            finalAmount,
            dueDate,
            new Date(),
            subscription.currentPeriodEnd,
            `Prorated plan change from ${currentPlan.name} to ${newPlan.name}`,
            changedBy,
          ],
        );
      }

      // Log the plan change
      await manager.query(
        `
        INSERT INTO public.audit_logs (
          id, action, "entityType", "entityId", "tenantId",
          "userId", changes, "createdAt"
        ) VALUES (
          gen_random_uuid(), 'PLAN_CHANGE', 'subscription', $1, $2,
          $3, $4, NOW()
        )
      `,
        [
          subscription.id,
          tenantId,
          changedBy,
          JSON.stringify({
            fromPlan: currentPlan.code,
            toPlan: newPlan.code,
            fromTier: currentPlan.tier,
            toTier: newPlan.tier,
            proratedAmount: finalAmount,
            effectiveDate,
            isUpgrade: comparison.isUpgrade,
            isDowngrade: comparison.isDowngrade,
          }),
        ],
      );
    });

    this.logger.log(
      `Plan changed for tenant ${tenantId}: ${currentPlan.name} -> ${newPlan.name} (${comparison.isUpgrade ? 'upgrade' : 'downgrade'})`,
    );

    return {
      success: true,
      isUpgrade: comparison.isUpgrade,
      isDowngrade: comparison.isDowngrade,
      proratedAmount: finalAmount,
      newMonthlyPrice: newPlan.pricing.monthly.basePrice,
      effectiveDate,
      invoice: finalAmount > 0
        ? {
            id: 'generated',
            amount: finalAmount,
            dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          }
        : undefined,
      warnings: comparison.warnings,
      message: comparison.isUpgrade
        ? `Successfully upgraded to ${newPlan.name}`
        : `Successfully downgraded to ${newPlan.name}`,
    };
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
    const subscription = await this.getSubscriptionByTenant(tenantId);
    if (!subscription) {
      throw new NotFoundException(`No subscription found for tenant ${tenantId}`);
    }

    const effectiveDate = cancelImmediately
      ? new Date()
      : new Date(subscription.currentPeriodEnd);

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `
        UPDATE public.subscriptions SET
          status = $1,
          "cancelledAt" = NOW(),
          "cancellationReason" = $2,
          "autoRenew" = false,
          "endDate" = $3,
          "updatedAt" = NOW(),
          "updatedBy" = $4
        WHERE "tenantId" = $5
      `,
        [
          cancelImmediately ? SubscriptionStatus.CANCELLED : subscription.status,
          reason,
          effectiveDate,
          cancelledBy,
          tenantId,
        ],
      );

      // Log cancellation
      await manager.query(
        `
        INSERT INTO public.audit_logs (
          id, action, "entityType", "entityId", "tenantId",
          "userId", changes, "createdAt"
        ) VALUES (
          gen_random_uuid(), 'SUBSCRIPTION_CANCELLED', 'subscription', $1, $2,
          $3, $4, NOW()
        )
      `,
        [
          subscription.id,
          tenantId,
          cancelledBy,
          JSON.stringify({
            reason,
            effectiveDate,
            cancelledImmediately: cancelImmediately,
          }),
        ],
      );
    });

    this.logger.log(`Subscription cancelled for tenant ${tenantId}: ${reason}`);

    return {
      success: true,
      effectiveDate,
      message: cancelImmediately
        ? 'Subscription cancelled immediately'
        : `Subscription will be cancelled on ${effectiveDate.toLocaleDateString()}`,
    };
  }

  /**
   * Reactivate a cancelled subscription
   */
  async reactivateSubscription(
    tenantId: string,
    reactivatedBy: string,
  ): Promise<{ success: boolean; message: string }> {
    const subscription = await this.getSubscriptionByTenant(tenantId);
    if (!subscription) {
      throw new NotFoundException(`No subscription found for tenant ${tenantId}`);
    }

    if (subscription.status !== SubscriptionStatus.CANCELLED) {
      throw new BadRequestException('Can only reactivate cancelled subscriptions');
    }

    await this.dataSource.query(
      `
      UPDATE public.subscriptions SET
        status = 'active',
        "cancelledAt" = NULL,
        "cancellationReason" = NULL,
        "autoRenew" = true,
        "endDate" = NULL,
        "updatedAt" = NOW(),
        "updatedBy" = $1
      WHERE "tenantId" = $2
    `,
      [reactivatedBy, tenantId],
    );

    this.logger.log(`Subscription reactivated for tenant ${tenantId}`);

    return {
      success: true,
      message: 'Subscription reactivated successfully',
    };
  }

  /**
   * Get subscriptions requiring payment reminders
   */
  async getSubscriptionsForReminders(): Promise<{
    upcomingDue: SubscriptionOverview[];
    pastDue: SubscriptionOverview[];
    gracePeriodEnding: SubscriptionOverview[];
  }> {
    const config = this.defaultReminderConfig;
    const now = new Date();

    // Upcoming due (before period end)
    const upcomingDue = await this.dataSource.query(
      `
      SELECT
        s.id,
        s."tenantId" as "tenantId",
        t.name as "tenantName",
        s."planName" as "planName",
        s.status,
        s."currentPeriodEnd" as "currentPeriodEnd"
      FROM public.subscriptions s
      LEFT JOIN public.tenants t ON t.id::text = s."tenantId"
      WHERE s.status = 'active'
        AND s."autoRenew" = true
        AND s."currentPeriodEnd" BETWEEN NOW() AND NOW() + INTERVAL '7 days'
      ORDER BY s."currentPeriodEnd" ASC
    `,
    );

    // Past due
    const pastDue = await this.dataSource.query(
      `
      SELECT
        s.id,
        s."tenantId" as "tenantId",
        t.name as "tenantName",
        s."planName" as "planName",
        s.status,
        s."currentPeriodEnd" as "currentPeriodEnd"
      FROM public.subscriptions s
      LEFT JOIN public.tenants t ON t.id::text = s."tenantId"
      WHERE s.status = 'past_due'
      ORDER BY s."currentPeriodEnd" ASC
    `,
    );

    // Grace period ending
    const gracePeriodEnding = await this.dataSource.query(
      `
      SELECT
        s.id,
        s."tenantId" as "tenantId",
        t.name as "tenantName",
        s."planName" as "planName",
        s.status,
        s."currentPeriodEnd" as "currentPeriodEnd"
      FROM public.subscriptions s
      LEFT JOIN public.tenants t ON t.id::text = s."tenantId"
      WHERE s.status = 'past_due'
        AND s."currentPeriodEnd" < NOW() - INTERVAL '${config.gracePeriodDays - 3} days'
      ORDER BY s."currentPeriodEnd" ASC
    `,
    );

    return { upcomingDue, pastDue, gracePeriodEnding };
  }

  /**
   * Process subscription renewals
   */
  async processRenewals(): Promise<{
    processed: number;
    failed: number;
    errors: string[];
  }> {
    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    // Get subscriptions due for renewal
    const dueSubs = await this.dataSource.query(
      `
      SELECT
        s.id,
        s."tenantId" as "tenantId",
        s."planTier" as "planTier",
        s."planName" as "planName",
        s."billingCycle" as "billingCycle",
        s.pricing,
        s."currentPeriodEnd" as "currentPeriodEnd"
      FROM public.subscriptions s
      WHERE s.status = 'active'
        AND s."autoRenew" = true
        AND s."currentPeriodEnd" <= NOW()
    `,
    );

    for (const sub of dueSubs) {
      try {
        const newPeriodStart = new Date(sub.currentPeriodEnd);
        const newPeriodEnd = this.calculateNextPeriodEnd(
          newPeriodStart,
          sub.billingCycle as BillingCycle,
        );

        // Create renewal invoice
        const invoiceNumber = `INV-${Date.now()}-${sub.tenantId.substring(0, 8)}`;
        const pricing = typeof sub.pricing === 'string' ? JSON.parse(sub.pricing) : sub.pricing;
        const amount = pricing.basePrice || 0;

        await this.dataSource.transaction(async (manager) => {
          // Update subscription period
          await manager.query(
            `
            UPDATE public.subscriptions SET
              "currentPeriodStart" = $1,
              "currentPeriodEnd" = $2,
              "updatedAt" = NOW()
            WHERE id = $3
          `,
            [newPeriodStart, newPeriodEnd, sub.id],
          );

          // Create invoice
          await manager.query(
            `
            INSERT INTO public.invoices (
              id, "tenantId", "subscriptionId", "invoiceNumber", status,
              "lineItems", subtotal, total, "amountDue",
              currency, "issueDate", "dueDate", "periodStart", "periodEnd",
              "createdAt", "updatedAt"
            ) VALUES (
              gen_random_uuid(), $1, $2, $3, 'pending',
              $4, $5, $5, $5,
              'USD', NOW(), NOW() + INTERVAL '7 days', $6, $7,
              NOW(), NOW()
            )
          `,
            [
              sub.tenantId,
              sub.id,
              invoiceNumber,
              JSON.stringify([
                {
                  description: `${sub.planName} - ${sub.billingCycle} subscription`,
                  quantity: 1,
                  unitPrice: amount,
                  amount,
                },
              ]),
              amount,
              newPeriodStart,
              newPeriodEnd,
            ],
          );
        });

        processed++;
        this.logger.log(`Processed renewal for tenant ${sub.tenantId}`);
      } catch (error) {
        failed++;
        errors.push(`Failed to process renewal for ${sub.tenantId}: ${(error as Error).message}`);
        this.logger.error(`Renewal failed for tenant ${sub.tenantId}`, (error as Error).stack);
      }
    }

    return { processed, failed, errors };
  }

  /**
   * Get subscription statistics
   */
  async getStats(): Promise<SubscriptionStats> {
    // Total subscriptions
    const totalResult = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM public.subscriptions`,
    );
    const totalSubscriptions = parseInt(totalResult[0]?.count || '0', 10);

    // By status
    const statusResult = await this.dataSource.query(`
      SELECT status, COUNT(*) as count
      FROM public.subscriptions
      GROUP BY status
    `);
    const byStatus: Record<SubscriptionStatus, number> = {
      [SubscriptionStatus.TRIAL]: 0,
      [SubscriptionStatus.ACTIVE]: 0,
      [SubscriptionStatus.PAST_DUE]: 0,
      [SubscriptionStatus.CANCELLED]: 0,
      [SubscriptionStatus.SUSPENDED]: 0,
      [SubscriptionStatus.EXPIRED]: 0,
    };
    for (const row of statusResult) {
      byStatus[row.status as SubscriptionStatus] = parseInt(row.count, 10);
    }

    // By plan tier
    const tierResult = await this.dataSource.query(`
      SELECT "planTier", COUNT(*) as count
      FROM public.subscriptions
      GROUP BY "planTier"
    `);
    const byPlanTier: Record<string, number> = {};
    for (const row of tierResult) {
      byPlanTier[row.planTier] = parseInt(row.count, 10);
    }

    // By billing cycle
    const cycleResult = await this.dataSource.query(`
      SELECT "billingCycle", COUNT(*) as count
      FROM public.subscriptions
      GROUP BY "billingCycle"
    `);
    const byBillingCycle: Record<string, number> = {};
    for (const row of cycleResult) {
      byBillingCycle[row.billingCycle] = parseInt(row.count, 10);
    }

    // MRR calculation
    const mrrResult = await this.dataSource.query(`
      SELECT COALESCE(SUM(
        CASE "billingCycle"
          WHEN 'monthly' THEN (pricing->>'basePrice')::decimal
          WHEN 'quarterly' THEN (pricing->>'basePrice')::decimal / 3
          WHEN 'semi_annual' THEN (pricing->>'basePrice')::decimal / 6
          WHEN 'annual' THEN (pricing->>'basePrice')::decimal / 12
          ELSE 0
        END
      ), 0) as mrr
      FROM public.subscriptions
      WHERE status IN ('active', 'trial')
    `);
    const mrr = parseFloat(mrrResult[0]?.mrr || '0');
    const arr = mrr * 12;

    // Expiring this month
    const expiringResult = await this.dataSource.query(`
      SELECT COUNT(*) as count
      FROM public.subscriptions
      WHERE status = 'active'
        AND "autoRenew" = false
        AND "currentPeriodEnd" <= NOW() + INTERVAL '30 days'
    `);
    const expiringThisMonth = parseInt(expiringResult[0]?.count || '0', 10);

    // Past due count
    const pastDueCount = byStatus[SubscriptionStatus.PAST_DUE] || 0;

    // Total revenue from paid invoices
    const revenueResult = await this.dataSource.query(`
      SELECT COALESCE(SUM("amountPaid"), 0) as total
      FROM public.invoices
      WHERE status = 'paid'
    `);
    const totalRevenue = parseFloat(revenueResult[0]?.total || '0');

    // Average revenue per user
    const activeCount = byStatus[SubscriptionStatus.ACTIVE] || 1;
    const averageRevenuePerUser = mrr / activeCount;

    // Churn rate (cancelled in last 30 days / active at start)
    const churnResult = await this.dataSource.query(`
      SELECT COUNT(*) as count
      FROM public.subscriptions
      WHERE status = 'cancelled'
        AND "cancelledAt" >= NOW() - INTERVAL '30 days'
    `);
    const churnedCount = parseInt(churnResult[0]?.count || '0', 10);
    const churnRate = totalSubscriptions > 0
      ? (churnedCount / totalSubscriptions) * 100
      : 0;

    // Trial conversion rate
    const trialConversionResult = await this.dataSource.query(`
      SELECT
        COUNT(CASE WHEN "trialEndDate" IS NOT NULL THEN 1 END) as total_trials,
        COUNT(CASE WHEN "trialEndDate" IS NOT NULL AND status = 'active' THEN 1 END) as converted
      FROM public.subscriptions
    `);
    const totalTrials = parseInt(trialConversionResult[0]?.total_trials || '0', 10);
    const convertedTrials = parseInt(trialConversionResult[0]?.converted || '0', 10);
    const trialConversionRate = totalTrials > 0
      ? (convertedTrials / totalTrials) * 100
      : 0;

    return {
      totalSubscriptions,
      byStatus,
      byPlanTier,
      byBillingCycle,
      mrr,
      arr,
      churnRate,
      averageRevenuePerUser,
      trialConversionRate,
      expiringThisMonth,
      pastDueCount,
      totalRevenue,
    };
  }

  /**
   * Extend trial period
   */
  async extendTrial(
    tenantId: string,
    additionalDays: number,
    extendedBy: string,
  ): Promise<{ success: boolean; newTrialEnd: Date }> {
    const subscription = await this.getSubscriptionByTenant(tenantId);
    if (!subscription) {
      throw new NotFoundException(`No subscription found for tenant ${tenantId}`);
    }

    if (subscription.status !== SubscriptionStatus.TRIAL) {
      throw new BadRequestException('Can only extend trial period for trial subscriptions');
    }

    const currentTrialEnd = subscription.trialEndDate
      ? new Date(subscription.trialEndDate)
      : new Date();
    const newTrialEnd = new Date(currentTrialEnd);
    newTrialEnd.setDate(newTrialEnd.getDate() + additionalDays);

    await this.dataSource.query(
      `
      UPDATE public.subscriptions SET
        "trialEndDate" = $1,
        "currentPeriodEnd" = $1,
        "updatedAt" = NOW(),
        "updatedBy" = $2
      WHERE "tenantId" = $3
    `,
      [newTrialEnd, extendedBy, tenantId],
    );

    this.logger.log(
      `Extended trial for tenant ${tenantId} by ${additionalDays} days until ${newTrialEnd.toISOString()}`,
    );

    return { success: true, newTrialEnd };
  }

  private calculateNextPeriodEnd(start: Date, cycle: BillingCycle): Date {
    const end = new Date(start);
    switch (cycle) {
      case BillingCycle.MONTHLY:
        end.setMonth(end.getMonth() + 1);
        break;
      case BillingCycle.QUARTERLY:
        end.setMonth(end.getMonth() + 3);
        break;
      case BillingCycle.SEMI_ANNUAL:
        end.setMonth(end.getMonth() + 6);
        break;
      case BillingCycle.ANNUAL:
        end.setFullYear(end.getFullYear() + 1);
        break;
    }
    return end;
  }

  /**
   * Create a new subscription for a tenant
   * This is called during tenant creation to set up billing
   */
  async createSubscription(dto: CreateSubscriptionDto): Promise<CreateSubscriptionResult> {
    const {
      tenantId,
      planTier = PlanTier.STARTER,
      billingCycle = BillingCycle.MONTHLY,
      modules,
      monthlyTotal,
      currency = 'USD',
      trialDays = 0,
      discountCode,
      createdBy,
    } = dto;

    // Validate tenant exists
    const tenantResult = await this.dataSource.query(
      `SELECT id, name FROM public.tenants WHERE id = $1`,
      [tenantId],
    );

    if (!tenantResult[0]) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    // Check if subscription already exists
    const existingSubscription = await this.dataSource.query(
      `SELECT id FROM public.subscriptions WHERE "tenantId" = $1`,
      [tenantId],
    );

    if (existingSubscription[0]) {
      throw new BadRequestException(`Subscription already exists for tenant ${tenantId}`);
    }

    // Calculate dates
    const now = new Date();
    const currentPeriodStart = now;
    const currentPeriodEnd = this.calculateNextPeriodEnd(now, billingCycle);
    const trialEndDate = trialDays > 0 ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000) : null;
    const status = trialDays > 0 ? SubscriptionStatus.TRIAL : SubscriptionStatus.ACTIVE;

    // Apply discount if provided
    let discountAmount = 0;
    if (discountCode && monthlyTotal > 0) {
      try {
        const discountResult = await this.discountService.validateCode(
          discountCode,
          tenantId,
          undefined,
          monthlyTotal,
        );
        if (discountResult.valid && discountResult.discountAmount) {
          discountAmount = discountResult.discountAmount;
        }
      } catch (err) {
        this.logger.warn(`Discount code ${discountCode} validation failed: ${(err as Error).message}`);
      }
    }

    const finalMonthlyPrice = Math.max(0, monthlyTotal - discountAmount);

    // Build pricing object
    const pricing = {
      basePrice: finalMonthlyPrice,
      moduleBreakdown: modules.map((m) => ({
        moduleId: m.moduleId,
        moduleCode: m.moduleCode,
        subtotal: m.subtotal,
        quantities: m.quantities,
      })),
      discount: discountAmount > 0 ? { code: discountCode, amount: discountAmount } : undefined,
      originalTotal: monthlyTotal,
    };

    // Build limits from modules
    const limits = {
      maxUsers: modules.reduce((sum, m) => sum + (m.quantities.users || 0), 0) || 5,
      maxFarms: modules.reduce((sum, m) => sum + (m.quantities.farms || 0), 0) || 1,
      maxPonds: modules.reduce((sum, m) => sum + (m.quantities.ponds || 0), 0) || 10,
      maxSensors: modules.reduce((sum, m) => sum + (m.quantities.sensors || 0), 0) || 10,
      storageGB: modules.reduce((sum, m) => sum + (m.quantities.storageGb || 0), 0) || 5,
    };

    const moduleItems: Array<{
      id: string;
      moduleId: string;
      moduleCode: string;
      quantities: ModuleQuantities;
      monthlyPrice: number;
    }> = [];

    // Execute in transaction
    const subscriptionId = await this.dataSource.transaction(async (manager) => {
      // Create subscription record
      const subscriptionResult = await manager.query(
        `
        INSERT INTO public.subscriptions (
          id, "tenantId", "planTier", "planName", status, "billingCycle",
          "currentPeriodStart", "currentPeriodEnd", "trialEndDate",
          limits, pricing, "autoRenew", currency,
          "createdAt", "updatedAt", "createdBy"
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, $10, true, $11,
          NOW(), NOW(), $12
        )
        RETURNING id
      `,
        [
          tenantId,
          planTier,
          `${planTier.charAt(0).toUpperCase() + planTier.slice(1)} Plan`,
          status,
          billingCycle,
          currentPeriodStart,
          currentPeriodEnd,
          trialEndDate,
          JSON.stringify(limits),
          JSON.stringify(pricing),
          currency,
          createdBy || tenantId,
        ],
      );

      const newSubscriptionId = subscriptionResult[0].id;

      // Create subscription_module_items for each module
      for (const moduleConfig of modules) {
        const itemResult = await manager.query(
          `
          INSERT INTO public.subscription_module_items (
            id, "subscriptionId", "moduleId", "moduleCode",
            quantities, "monthlyPrice", "lineItems",
            "isActive", "createdAt", "updatedAt"
          ) VALUES (
            gen_random_uuid(), $1, $2, $3,
            $4, $5, $6,
            true, NOW(), NOW()
          )
          RETURNING id
        `,
          [
            newSubscriptionId,
            moduleConfig.moduleId,
            moduleConfig.moduleCode,
            JSON.stringify(moduleConfig.quantities),
            moduleConfig.subtotal,
            JSON.stringify(moduleConfig.lineItems || []),
          ],
        );

        moduleItems.push({
          id: itemResult[0].id,
          moduleId: moduleConfig.moduleId,
          moduleCode: moduleConfig.moduleCode,
          quantities: moduleConfig.quantities,
          monthlyPrice: moduleConfig.subtotal,
        });
      }

      // Update tenant with subscription info
      await manager.query(
        `
        UPDATE public.tenants SET
          tier = $1,
          limits = $2,
          "updatedAt" = NOW()
        WHERE id = $3
      `,
        [planTier, JSON.stringify(limits), tenantId],
      );

      // Log creation in audit
      await manager.query(
        `
        INSERT INTO public.audit_logs (
          id, action, "entityType", "entityId", "tenantId",
          "userId", changes, "createdAt"
        ) VALUES (
          gen_random_uuid(), 'SUBSCRIPTION_CREATED', 'subscription', $1, $2,
          $3, $4, NOW()
        )
      `,
        [
          newSubscriptionId,
          tenantId,
          createdBy || 'system',
          JSON.stringify({
            planTier,
            billingCycle,
            monthlyPrice: finalMonthlyPrice,
            modulesCount: modules.length,
            trialDays,
            status,
          }),
        ],
      );

      return newSubscriptionId;
    });

    this.logger.log(
      `Created subscription ${subscriptionId} for tenant ${tenantId} with ${modules.length} modules, monthly price: ${finalMonthlyPrice} ${currency}`,
    );

    return {
      success: true,
      subscription: {
        id: subscriptionId,
        tenantId,
        status,
        planTier,
        billingCycle,
        monthlyPrice: finalMonthlyPrice,
        trialEndDate: trialEndDate || undefined,
        currentPeriodStart,
        currentPeriodEnd,
      },
      moduleItems,
      message: trialDays > 0
        ? `Subscription created with ${trialDays}-day trial period`
        : 'Subscription created successfully',
    };
  }
}
