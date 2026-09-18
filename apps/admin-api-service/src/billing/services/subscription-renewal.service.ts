import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SubscriptionCoreService } from './subscription-core.service';
import {
  SubscriptionOverview,
  ReminderConfig,
} from './subscription-types';

type DbNumeric = number | string | null | undefined;
type SubscriptionOverviewRow = Omit<
  SubscriptionOverview,
  'monthlyPrice' | 'trialEndDate' | 'cancelledAt'
> & {
  monthlyPrice: DbNumeric;
  trialEndDate: Date | null;
  cancelledAt: Date | null;
};

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
