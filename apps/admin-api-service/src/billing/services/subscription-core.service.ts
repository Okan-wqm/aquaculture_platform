import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DiscountCodeService } from './discount-code.service';
import { BillingCycle, PlanTier } from '../entities/plan-definition.entity';
import {
  SubscriptionStatus,
  SubscriptionOverview,
  SubscriptionFilters,
  ModuleQuantities,
  ModuleLineItem,
  SubscriptionModuleConfig,
  CreateSubscriptionDto,
  CreateSubscriptionResult,
} from './subscription-types';

/**
 * Subscription Core Service
 * Handles basic subscription CRUD operations
 * SRP: Only responsible for subscription lifecycle management
 */
@Injectable()
export class SubscriptionCoreService {
  private readonly logger = new Logger(SubscriptionCoreService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
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
      query += ` AND s."currentPeriodEnd" <= NOW() + ($${paramIndex}::integer * INTERVAL '1 day')`;
      params.push(filters.expiringWithinDays);
      paramIndex++;
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

  /**
   * Calculate next period end date based on billing cycle
   */
  calculateNextPeriodEnd(start: Date, cycle: BillingCycle): Date {
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

  /**
   * Get DataSource for use by other services
   */
  getDataSource(): DataSource {
    return this.dataSource;
  }
}
