import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  SubscriptionStatus,
  SubscriptionStats,
} from './subscription-types';

/**
 * Subscription Analytics Service
 * Handles subscription statistics and metrics calculation
 * SRP: Only responsible for analytics and reporting
 */
@Injectable()
export class SubscriptionAnalyticsService {
  private readonly logger = new Logger(SubscriptionAnalyticsService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

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
   * Get MRR trend over time
   */
  async getMrrTrend(months: number = 12): Promise<Array<{
    month: string;
    mrr: number;
    activeCount: number;
  }>> {
    const result = await this.dataSource.query(`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', NOW() - ($1::integer * INTERVAL '1 month')),
          date_trunc('month', NOW()),
          '1 month'::interval
        ) as month
      )
      SELECT
        to_char(m.month, 'YYYY-MM') as month,
        COALESCE(SUM(
          CASE s."billingCycle"
            WHEN 'monthly' THEN (s.pricing->>'basePrice')::decimal
            WHEN 'quarterly' THEN (s.pricing->>'basePrice')::decimal / 3
            WHEN 'semi_annual' THEN (s.pricing->>'basePrice')::decimal / 6
            WHEN 'annual' THEN (s.pricing->>'basePrice')::decimal / 12
            ELSE 0
          END
        ), 0)::decimal as mrr,
        COUNT(DISTINCT s.id)::integer as "activeCount"
      FROM months m
      LEFT JOIN public.subscriptions s ON
        s.status IN ('active', 'trial')
        AND s."createdAt" <= m.month + INTERVAL '1 month'
        AND (s."cancelledAt" IS NULL OR s."cancelledAt" > m.month)
      GROUP BY m.month
      ORDER BY m.month ASC
    `, [months]);

    return result;
  }

  /**
   * Get churn analysis
   */
  async getChurnAnalysis(days: number = 90): Promise<{
    churned: number;
    churnRate: number;
    reasonBreakdown: Record<string, number>;
    tierBreakdown: Record<string, number>;
    avgLifetimeMonths: number;
  }> {
    // Get churned subscriptions
    const churnedResult = await this.dataSource.query(`
      SELECT COUNT(*) as count
      FROM public.subscriptions
      WHERE status = 'cancelled'
        AND "cancelledAt" >= NOW() - ($1::integer * INTERVAL '1 day')
    `, [days]);
    const churned = parseInt(churnedResult[0]?.count || '0', 10);

    // Get total at start of period
    const totalAtStartResult = await this.dataSource.query(`
      SELECT COUNT(*) as count
      FROM public.subscriptions
      WHERE "createdAt" < NOW() - ($1::integer * INTERVAL '1 day')
        AND status != 'cancelled'
    `, [days]);
    const totalAtStart = parseInt(totalAtStartResult[0]?.count || '1', 10);
    const churnRate = (churned / totalAtStart) * 100;

    // Reason breakdown
    const reasonResult = await this.dataSource.query(`
      SELECT
        COALESCE("cancellationReason", 'Unknown') as reason,
        COUNT(*) as count
      FROM public.subscriptions
      WHERE status = 'cancelled'
        AND "cancelledAt" >= NOW() - ($1::integer * INTERVAL '1 day')
      GROUP BY "cancellationReason"
    `, [days]);
    const reasonBreakdown: Record<string, number> = {};
    for (const row of reasonResult) {
      reasonBreakdown[row.reason] = parseInt(row.count, 10);
    }

    // Tier breakdown
    const tierResult = await this.dataSource.query(`
      SELECT
        "planTier" as tier,
        COUNT(*) as count
      FROM public.subscriptions
      WHERE status = 'cancelled'
        AND "cancelledAt" >= NOW() - ($1::integer * INTERVAL '1 day')
      GROUP BY "planTier"
    `, [days]);
    const tierBreakdown: Record<string, number> = {};
    for (const row of tierResult) {
      tierBreakdown[row.tier] = parseInt(row.count, 10);
    }

    // Average lifetime
    const lifetimeResult = await this.dataSource.query(`
      SELECT AVG(
        EXTRACT(EPOCH FROM ("cancelledAt" - "createdAt")) / (30 * 24 * 60 * 60)
      ) as avg_months
      FROM public.subscriptions
      WHERE status = 'cancelled'
        AND "cancelledAt" IS NOT NULL
    `);
    const avgLifetimeMonths = parseFloat(lifetimeResult[0]?.avg_months || '0');

    return {
      churned,
      churnRate,
      reasonBreakdown,
      tierBreakdown,
      avgLifetimeMonths,
    };
  }

  /**
   * Get revenue breakdown by tier
   */
  async getRevenueByTier(): Promise<Record<string, {
    mrr: number;
    subscriptionCount: number;
    percentage: number;
  }>> {
    const result = await this.dataSource.query(`
      SELECT
        "planTier",
        SUM(
          CASE "billingCycle"
            WHEN 'monthly' THEN (pricing->>'basePrice')::decimal
            WHEN 'quarterly' THEN (pricing->>'basePrice')::decimal / 3
            WHEN 'semi_annual' THEN (pricing->>'basePrice')::decimal / 6
            WHEN 'annual' THEN (pricing->>'basePrice')::decimal / 12
            ELSE 0
          END
        ) as mrr,
        COUNT(*) as count
      FROM public.subscriptions
      WHERE status IN ('active', 'trial')
      GROUP BY "planTier"
    `);

    const totalMrr = result.reduce(
      (sum: number, r: { mrr: string }) => sum + parseFloat(r.mrr || '0'),
      0,
    );

    const breakdown: Record<string, { mrr: number; subscriptionCount: number; percentage: number }> = {};
    for (const row of result) {
      const mrr = parseFloat(row.mrr || '0');
      breakdown[row.planTier] = {
        mrr,
        subscriptionCount: parseInt(row.count, 10),
        percentage: totalMrr > 0 ? (mrr / totalMrr) * 100 : 0,
      };
    }

    return breakdown;
  }

  /**
   * Get growth metrics
   */
  async getGrowthMetrics(months: number = 3): Promise<{
    newSubscriptions: number;
    netGrowth: number;
    growthRate: number;
    avgNewMrr: number;
  }> {
    // New subscriptions in period
    const newResult = await this.dataSource.query(`
      SELECT COUNT(*) as count
      FROM public.subscriptions
      WHERE "createdAt" >= NOW() - ($1::integer * INTERVAL '1 month')
    `, [months]);
    const newSubscriptions = parseInt(newResult[0]?.count || '0', 10);

    // Cancelled in period
    const cancelledResult = await this.dataSource.query(`
      SELECT COUNT(*) as count
      FROM public.subscriptions
      WHERE "cancelledAt" >= NOW() - ($1::integer * INTERVAL '1 month')
    `, [months]);
    const cancelled = parseInt(cancelledResult[0]?.count || '0', 10);

    const netGrowth = newSubscriptions - cancelled;

    // Growth rate
    const previousResult = await this.dataSource.query(`
      SELECT COUNT(*) as count
      FROM public.subscriptions
      WHERE "createdAt" < NOW() - ($1::integer * INTERVAL '1 month')
        AND status != 'cancelled'
    `, [months]);
    const previousCount = parseInt(previousResult[0]?.count || '1', 10);
    const growthRate = previousCount > 0 ? (netGrowth / previousCount) * 100 : 0;

    // Average new MRR
    const avgMrrResult = await this.dataSource.query(`
      SELECT AVG(
        CASE "billingCycle"
          WHEN 'monthly' THEN (pricing->>'basePrice')::decimal
          WHEN 'quarterly' THEN (pricing->>'basePrice')::decimal / 3
          WHEN 'semi_annual' THEN (pricing->>'basePrice')::decimal / 6
          WHEN 'annual' THEN (pricing->>'basePrice')::decimal / 12
          ELSE 0
        END
      ) as avg_mrr
      FROM public.subscriptions
      WHERE "createdAt" >= NOW() - ($1::integer * INTERVAL '1 month')
    `, [months]);
    const avgNewMrr = parseFloat(avgMrrResult[0]?.avg_mrr || '0');

    return {
      newSubscriptions,
      netGrowth,
      growthRate,
      avgNewMrr,
    };
  }
}
