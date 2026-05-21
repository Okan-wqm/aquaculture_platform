import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BillingCycle } from '../entities/plan-definition.entity';

import { SubscriptionCoreService } from './subscription-core.service';
import {
  SubscriptionOverview,
  ReminderConfig,
} from './subscription-types';

type DbNumeric = number | string | null | undefined;
type SubscriptionPricingPayload = {
  basePrice?: DbNumeric;
};

type SubscriptionOverviewRow = Omit<
  SubscriptionOverview,
  'monthlyPrice' | 'trialEndDate' | 'cancelledAt'
> & {
  monthlyPrice: DbNumeric;
  trialEndDate: Date | null;
  cancelledAt: Date | null;
};

interface DueSubscriptionRow {
  id: string;
  tenantId: string;
  planTier: string;
  planName: string;
  billingCycle: BillingCycle;
  pricing: string | SubscriptionPricingPayload | null;
  currentPeriodEnd: Date;
}

function dbNumber(value: DbNumeric): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePricing(value: DueSubscriptionRow['pricing']): SubscriptionPricingPayload {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return {};
    }

    const basePrice = parsed.basePrice;
    return typeof basePrice === 'number' || typeof basePrice === 'string' || basePrice === null
      ? { basePrice }
      : {};
  }

  return value ?? {};
}

function mapSubscriptionOverview(row: SubscriptionOverviewRow): SubscriptionOverview {
  return {
    ...row,
    monthlyPrice: dbNumber(row.monthlyPrice),
    trialEndDate: row.trialEndDate ?? undefined,
    cancelledAt: row.cancelledAt ?? undefined,
  };
}

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
    const upcomingDue = await this.dataSource.query<SubscriptionOverviewRow[]>(
      `
      SELECT
        s.id,
        s.tenant_id as "tenantId",
        t.name as "tenantName",
        s.plan_tier as "planTier",
        s.plan_name as "planName",
        s.status,
        s.billing_cycle as "billingCycle",
        s.current_period_start as "currentPeriodStart",
        s.current_period_end as "currentPeriodEnd",
        (s.pricing->>'basePrice')::decimal as "monthlyPrice",
        s.auto_renew as "autoRenew",
        s.trial_end_date as "trialEndDate",
        s.cancelled_at as "cancelledAt",
        s."createdAt" as "createdAt"
      FROM billing.subscriptions s
      LEFT JOIN auth.tenants t ON t.id = s.tenant_id
      WHERE s.status = 'active'
        AND s.auto_renew = true
        AND s.current_period_end BETWEEN NOW() AND NOW() + INTERVAL '7 days'
      ORDER BY s.current_period_end ASC
    `,
    );

    // Past due
    const pastDue = await this.dataSource.query<SubscriptionOverviewRow[]>(
      `
      SELECT
        s.id,
        s.tenant_id as "tenantId",
        t.name as "tenantName",
        s.plan_tier as "planTier",
        s.plan_name as "planName",
        s.status,
        s.billing_cycle as "billingCycle",
        s.current_period_start as "currentPeriodStart",
        s.current_period_end as "currentPeriodEnd",
        (s.pricing->>'basePrice')::decimal as "monthlyPrice",
        s.auto_renew as "autoRenew",
        s.trial_end_date as "trialEndDate",
        s.cancelled_at as "cancelledAt",
        s."createdAt" as "createdAt"
      FROM billing.subscriptions s
      LEFT JOIN auth.tenants t ON t.id = s.tenant_id
      WHERE s.status = 'past_due'
      ORDER BY s.current_period_end ASC
    `,
    );

    // Grace period ending
    const gracePeriodWarningDays = config.gracePeriodDays - 3;
    const gracePeriodEnding = await this.dataSource.query<SubscriptionOverviewRow[]>(
      `
      SELECT
        s.id,
        s.tenant_id as "tenantId",
        t.name as "tenantName",
        s.plan_tier as "planTier",
        s.plan_name as "planName",
        s.status,
        s.billing_cycle as "billingCycle",
        s.current_period_start as "currentPeriodStart",
        s.current_period_end as "currentPeriodEnd",
        (s.pricing->>'basePrice')::decimal as "monthlyPrice",
        s.auto_renew as "autoRenew",
        s.trial_end_date as "trialEndDate",
        s.cancelled_at as "cancelledAt",
        s."createdAt" as "createdAt"
      FROM billing.subscriptions s
      LEFT JOIN auth.tenants t ON t.id = s.tenant_id
      WHERE s.status = 'past_due'
        AND s.current_period_end < NOW() - ($1::integer * INTERVAL '1 day')
      ORDER BY s.current_period_end ASC
    `,
      [gracePeriodWarningDays],
    );

    return {
      upcomingDue: upcomingDue.map(mapSubscriptionOverview),
      pastDue: pastDue.map(mapSubscriptionOverview),
      gracePeriodEnding: gracePeriodEnding.map(mapSubscriptionOverview),
    };
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
    const dueSubs = await this.dataSource.query<DueSubscriptionRow[]>(
      `
      SELECT
        s.id,
        s.tenant_id as "tenantId",
        s.plan_tier as "planTier",
        s.plan_name as "planName",
        s.billing_cycle as "billingCycle",
        s.pricing,
        s.current_period_end as "currentPeriodEnd"
      FROM billing.subscriptions s
      WHERE s.status = 'active'
        AND s.auto_renew = true
        AND s.current_period_end <= NOW()
    `,
    );

    for (const sub of dueSubs) {
      try {
        const newPeriodStart = new Date(sub.currentPeriodEnd);
        const newPeriodEnd = this.subscriptionCore.calculateNextPeriodEnd(newPeriodStart, sub.billingCycle);

        // Create renewal invoice
        const invoiceNumber = `INV-${Date.now()}-${sub.tenantId.substring(0, 8)}`;
        const pricing = parsePricing(sub.pricing);
        const amount = dbNumber(pricing.basePrice);

        await this.dataSource.transaction(async (manager) => {
          // Update subscription period (billing.subscriptions uses snake_case)
          await manager.query(
            `
            UPDATE billing.subscriptions SET
              current_period_start = $1,
              current_period_end = $2,
              "updatedAt" = NOW()
            WHERE id = $3
          `,
            [newPeriodStart, newPeriodEnd, sub.id],
          );

          // Create invoice (billing.invoices uses snake_case)
          await manager.query(
            `
            INSERT INTO billing.invoices (
              id, tenant_id, subscription_id, invoice_number, status,
              line_items, subtotal, total, amount_due, billing_address,
              currency, issue_date, due_date, period_start, period_end,
              "createdAt", "updatedAt", version
            ) VALUES (
              gen_random_uuid(), $1, $2, $3, 'pending',
              $4, $5, $5, $5, '{}',
              'USD', NOW(), NOW() + INTERVAL '7 days', $6, $7,
              NOW(), NOW(), 1
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
    const rows = await this.dataSource.query<SubscriptionOverviewRow[]>(
      `
      SELECT
        s.id,
        s.tenant_id as "tenantId",
        t.name as "tenantName",
        s.plan_tier as "planTier",
        s.plan_name as "planName",
        s.status,
        s.billing_cycle as "billingCycle",
        s.current_period_start as "currentPeriodStart",
        s.current_period_end as "currentPeriodEnd",
        (s.pricing->>'basePrice')::decimal as "monthlyPrice",
        s.auto_renew as "autoRenew",
        s.trial_end_date as "trialEndDate",
        s.cancelled_at as "cancelledAt",
        s."createdAt" as "createdAt"
      FROM billing.subscriptions s
      LEFT JOIN auth.tenants t ON t.id = s.tenant_id
      WHERE s.status IN ('active', 'trial')
        AND s.auto_renew = false
        AND s.current_period_end <= NOW() + ($1::integer * INTERVAL '1 day')
      ORDER BY s.current_period_end ASC
    `,
      [withinDays],
    );

    return rows.map(mapSubscriptionOverview);
  }

  /**
   * Mark subscription as past due
   */
  async markAsPastDue(subscriptionId: string): Promise<void> {
    await this.dataSource.query(
      `
      UPDATE billing.subscriptions SET
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
      UPDATE billing.subscriptions SET
        status = 'suspended',
        cancellation_reason = 'Non-payment after grace period',
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
