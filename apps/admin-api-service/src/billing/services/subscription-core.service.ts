import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BillingCycle } from '../entities/plan-definition.entity';

import { DiscountCodeService } from './discount-code.service';
import {
  SubscriptionOverview,
  SubscriptionFilters,
} from './subscription-types';

type DbNumeric = number | string | null | undefined;

interface CountRow {
  count: DbNumeric;
}

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
    // billing.subscriptions uses snake_case column names (owned by billing-service)
    let query = `
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
      query += ` AND s.plan_tier = ANY($${paramIndex})`;
      params.push(filters.planTier);
      paramIndex++;
    }

    if (filters.billingCycle && filters.billingCycle.length > 0) {
      query += ` AND s.billing_cycle = ANY($${paramIndex})`;
      params.push(filters.billingCycle);
      paramIndex++;
    }

    if (filters.autoRenew !== undefined) {
      query += ` AND s.auto_renew = $${paramIndex}`;
      params.push(filters.autoRenew);
      paramIndex++;
    }

    if (filters.search) {
      query += ` AND (t.name ILIKE $${paramIndex} OR s.plan_name ILIKE $${paramIndex})`;
      params.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (filters.expiringWithinDays) {
      query += ` AND s.current_period_end <= NOW() + ($${paramIndex}::integer * INTERVAL '1 day')`;
      params.push(filters.expiringWithinDays);
      paramIndex++;
    }

    if (filters.pastDueOnly) {
      query += ` AND s.status = 'past_due'`;
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM (${query}) as subq`;
    const countResult = await this.dataSource.query<CountRow[]>(countQuery, params);
    const total = dbNumber(countResult[0]?.count);

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

    const subscriptions = await this.dataSource.query<SubscriptionOverviewRow[]>(query, params);

    return { subscriptions: subscriptions.map(mapSubscriptionOverview), total };
  }

  /**
   * Get subscription by tenant ID
   */
  async getSubscriptionByTenant(tenantId: string): Promise<SubscriptionOverview | null> {
    const result = await this.dataSource.query<SubscriptionOverviewRow[]>(
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
      WHERE s.tenant_id = $1::uuid
    `,
      [tenantId],
    );

    const subscription = result[0];
    return subscription ? mapSubscriptionOverview(subscription) : null;
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
   * Get DataSource for use by other services
   */
  getDataSource(): DataSource {
    return this.dataSource;
  }
}
