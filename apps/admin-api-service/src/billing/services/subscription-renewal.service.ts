import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SubscriptionCoreService } from './subscription-core.service';
import { BillingCycle } from '../entities/plan-definition.entity';
import {
  SubscriptionOverview,
  ReminderConfig,
} from './subscription-types';

/**
 * Subscription Renewal Service
 * Handles subscription renewals and payment reminders
 * SRP: Only responsible for renewal and reminder operations
 */
@Injectable()
export class SubscriptionRenewalService {
  private readonly logger = new Logger(SubscriptionRenewalService.name);

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
    private readonly subscriptionCore: SubscriptionCoreService,
  ) {}

  /**
   * Get subscriptions requiring payment reminders
   */
  async getSubscriptionsForReminders(): Promise<{
    upcomingDue: SubscriptionOverview[];
    pastDue: SubscriptionOverview[];
    gracePeriodEnding: SubscriptionOverview[];
  }> {
    const config = this.defaultReminderConfig;

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
    const gracePeriodWarningDays = config.gracePeriodDays - 3;
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
        AND s."currentPeriodEnd" < NOW() - ($1::integer * INTERVAL '1 day')
      ORDER BY s."currentPeriodEnd" ASC
    `,
      [gracePeriodWarningDays],
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
        const newPeriodEnd = this.subscriptionCore.calculateNextPeriodEnd(
          newPeriodStart,
          sub.billingCycle as BillingCycle,
        );

        // Create renewal invoice
        const invoiceNumber = `INV-${Date.now()}-${sub.tenantId.substring(0, 8)}`;
        const pricing = sub.pricing
          ? (typeof sub.pricing === 'string' ? JSON.parse(sub.pricing) : sub.pricing)
          : { basePrice: 0 };
        const amount = pricing?.basePrice || 0;

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
   * Get expiring subscriptions within days
   */
  async getExpiringSubscriptions(withinDays: number): Promise<SubscriptionOverview[]> {
    return this.dataSource.query(
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
        s."autoRenew" as "autoRenew"
      FROM public.subscriptions s
      LEFT JOIN public.tenants t ON t.id::text = s."tenantId"
      WHERE s.status IN ('active', 'trial')
        AND s."autoRenew" = false
        AND s."currentPeriodEnd" <= NOW() + ($1::integer * INTERVAL '1 day')
      ORDER BY s."currentPeriodEnd" ASC
    `,
      [withinDays],
    );
  }

  /**
   * Mark subscription as past due
   */
  async markAsPastDue(subscriptionId: string): Promise<void> {
    await this.dataSource.query(
      `
      UPDATE public.subscriptions SET
        status = 'past_due',
        "updatedAt" = NOW()
      WHERE id = $1
    `,
      [subscriptionId],
    );

    this.logger.log(`Subscription ${subscriptionId} marked as past due`);
  }

  /**
   * Suspend subscription for non-payment
   */
  async suspendForNonPayment(subscriptionId: string): Promise<void> {
    await this.dataSource.query(
      `
      UPDATE public.subscriptions SET
        status = 'suspended',
        "suspendedAt" = NOW(),
        "suspensionReason" = 'Non-payment after grace period',
        "updatedAt" = NOW()
      WHERE id = $1
    `,
      [subscriptionId],
    );

    this.logger.log(`Subscription ${subscriptionId} suspended for non-payment`);
  }

  /**
   * Get reminder configuration
   */
  getReminderConfig(): ReminderConfig {
    return { ...this.defaultReminderConfig };
  }

  /**
   * Update reminder configuration
   */
  setReminderConfig(config: Partial<ReminderConfig>): void {
    Object.assign(this.defaultReminderConfig, config);
  }
}
