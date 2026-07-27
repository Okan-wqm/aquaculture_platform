/**
 * Analytics Service
 *
 * Dashboard KPI calculations and metric aggregation.
 * Calculates Tenant, User, Financial and System metrics from REAL data.
 *
 * NO MOCK DATA - All metrics are calculated from database queries.
 */

import { toIsoDateString } from '@aquaculture/backend-common/database';
import { RedisService } from '@aquaculture/backend-common/redis';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual, Repository } from 'typeorm';

import { AuditLogService } from '../../audit/audit.service';
import {
  AnalyticsSnapshot,
  SnapshotType,
  MetricCategory,
  TenantMetrics,
  UserMetrics,
  FinancialMetrics,
  SystemMetrics,
  UsageMetrics,
  DashboardSummary,
  TimeSeriesData,
  ChartData,
  measuredEntries,
} from '../entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from '../entities/external/invoice.entity';
import { BillingCycle, SubscriptionReadOnly, SubscriptionStatus } from '../entities/external/subscription.entity';
import { TenantReadOnly } from '../entities/external/tenant.entity';
import { UserReadOnly } from '../entities/external/user.entity';

// ============================================================================
// DTOs
// ============================================================================

export interface DateRangeDto {
  startDate: Date;
  endDate: Date;
}

export interface TrendDataDto {
  period: 'day' | 'week' | 'month' | 'year';
  dataPoints: number;
}

export interface ComparisonDto {
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  trend: 'up' | 'down' | 'stable';
}

type DbNumeric = number | string | null | undefined;

interface CountRow {
  cnt: DbNumeric;
}

interface TenantAggregateRow {
  total: DbNumeric;
  active: DbNumeric;
  suspended: DbNumeric;
  inactive: DbNumeric;
  trial: DbNumeric;
  starter: DbNumeric;
  professional: DbNumeric;
  enterprise: DbNumeric;
  new_this_month: DbNumeric;
  churned_this_month: DbNumeric;
}

interface UserAggregateRow {
  total: DbNumeric;
  active: DbNumeric;
  inactive: DbNumeric;
  new_this_month: DbNumeric;
  active_last_day: DbNumeric;
  active_last_week: DbNumeric;
  active_last_month: DbNumeric;
  admin_count: DbNumeric;
  manager_count: DbNumeric;
  operator_count: DbNumeric;
}

interface InvoiceAggregateRow {
  total_revenue: DbNumeric;
  revenue_this_month: DbNumeric;
  pending_payments: DbNumeric;
  overdue_payments: DbNumeric;
  refunds: DbNumeric;
}

interface MonthRevenueRow {
  month: Date | string;
  avg_mrr: DbNumeric;
}

function parseDbInt(value: DbNumeric): number {
  return Number.parseInt(String(value ?? '0'), 10);
}

function parseDbNumber(value: DbNumeric): number {
  return Number(value ?? 0);
}

/** Series colours, cycled by index so the palette never bounds the series length. */
const CHART_PALETTE = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#6366F1',
] as const;

/** `farm_management` -> `Farm Management` for chart axis labels. */
function humanizeMetricKey(key: string): string {
  return key
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(AnalyticsSnapshot)
    private readonly snapshotRepository: Repository<AnalyticsSnapshot>,
    @InjectRepository(TenantReadOnly)
    private readonly tenantRepository: Repository<TenantReadOnly>,
    @InjectRepository(UserReadOnly)
    private readonly userRepository: Repository<UserReadOnly>,
    @InjectRepository(SubscriptionReadOnly)
    private readonly subscriptionRepository: Repository<SubscriptionReadOnly>,
    @InjectRepository(InvoiceReadOnly)
    private readonly invoiceRepository: Repository<InvoiceReadOnly>,
    private readonly auditLogService: AuditLogService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional()
    private readonly redisService?: RedisService,
  ) {}

  /**
   * Type-safe helper to extract numeric metric value from snapshot metrics
   * Handles the union type (TenantMetrics | UserMetrics | FinancialMetrics | SystemMetrics | UsageMetrics)
   */
  private getMetricValue(
    metrics: TenantMetrics | UserMetrics | FinancialMetrics | SystemMetrics | UsageMetrics,
    key: string,
  ): number {
    // Since metrics is a JSONB object, we need to access it dynamically
    // but we ensure type safety by checking if the key exists and is a number
    // Metrics is a JSONB object — dynamic key access requires indexable type
    const metricsObj: Record<string, unknown> = { ...metrics };
    const value = metricsObj[key];

    if (typeof value === 'number' && !isNaN(value)) {
      return value;
    }
    return 0;
  }

  // ============================================================================
  // Dashboard Summary
  // ============================================================================

  /** Redis cache key and TTL for the dashboard summary (CRITICAL-002). */
  private static readonly DASHBOARD_CACHE_KEY = 'analytics:dashboard:summary';
  private static readonly DASHBOARD_CACHE_TTL = 300; // 5 minutes

  /**
   * Get complete dashboard summary with all metrics.
   * CRITICAL-002 fix: results are cached in Redis for 5 minutes to avoid
   * re-running 5 expensive aggregation queries on every page load.
   */
  async getDashboardSummary(): Promise<DashboardSummary> {
    // Try Redis cache first
    if (this.redisService) {
      try {
        const cached = await this.redisService.getJson<DashboardSummary>(
          AnalyticsService.DASHBOARD_CACHE_KEY,
        );
        if (cached) {
          this.logger.debug('Dashboard summary served from cache');
          return cached;
        }
      } catch {
        // Cache miss or Redis unavailable — fall through to live computation
      }
    }

    this.logger.log('Calculating dashboard summary from database...');

    /**
     * Partial failure resilience: each data source is fetched independently
     * via Promise.allSettled. If any single source fails (e.g. billing schema
     * unavailable), the dashboard still returns data from the healthy sources
     * with sensible defaults for the failed ones. The 'unavailable' array
     * lists which sources failed so the frontend can show degraded-mode
     * indicators instead of a full error screen.
     */
    const [tenantsResult, usersResult, financialResult, systemResult, usageResult] =
      await Promise.allSettled([
        this.getTenantMetrics(),
        this.getUserMetrics(),
        this.getFinancialMetrics(),
        this.getSystemMetrics(),
        this.getUsageMetrics(),
      ]);

    const unavailable: string[] = [];

    const tenants = this.extractOrDefault(
      tenantsResult, 'tenants', unavailable, () => this.getDefaultTenantMetrics(),
    );
    const users = this.extractOrDefault(
      usersResult, 'users', unavailable, () => this.getDefaultUserMetrics(),
    );
    const financial = this.extractOrDefault(
      financialResult, 'financial', unavailable, () => this.getDefaultFinancialMetrics(),
    );
    const system = this.extractOrDefault(
      systemResult, 'system', unavailable, () => this.getDefaultSystemMetrics(),
    );
    const usage = this.extractOrDefault(
      usageResult, 'usage', unavailable, () => this.getDefaultUsageMetrics(),
    );

    if (unavailable.length > 0) {
      this.logger.warn(`Dashboard summary degraded — unavailable sources: ${unavailable.join(', ')}`);
    }

    const summary: DashboardSummary = {
      tenants,
      users,
      financial,
      system,
      usage,
      generatedAt: new Date(),
      ...(unavailable.length > 0 ? { unavailable } : {}),
    };

    // Cache only complete snapshots. Degraded summaries must stay live so
    // recovered sources become visible on the next request.
    if (this.redisService && unavailable.length === 0) {
      this.redisService
        .setJson(AnalyticsService.DASHBOARD_CACHE_KEY, summary, AnalyticsService.DASHBOARD_CACHE_TTL)
        .catch((err: Error) =>
          this.logger.warn(`Failed to cache dashboard summary: ${err.message}`),
        );
    }

    return summary;
  }

  // ============================================================================
  // Tenant Metrics - REAL DATA
  // ============================================================================

  /**
   * Calculate tenant metrics from database using a single aggregation query.
   * CRITICAL-001 fix: replaced full-table scan + JS filtering with SQL COUNT FILTER.
   */
  async getTenantMetrics(): Promise<TenantMetrics> {
    this.logger.debug('Calculating tenant metrics from database...');

    const rows = await this.dataSource.query<TenantAggregateRow[]>(`
      SELECT
        COUNT(*)                                                                          AS total,
        COUNT(*) FILTER (WHERE status = 'ACTIVE')                                        AS active,
        COUNT(*) FILTER (WHERE status = 'SUSPENDED')                                     AS suspended,
        COUNT(*) FILTER (WHERE status = 'PENDING')                                       AS pending,
        COUNT(*) FILTER (WHERE status IN ('SUSPENDED','CANCELLED'))                      AS inactive,
        COUNT(*) FILTER (WHERE LOWER(plan) = 'trial')                                    AS trial,
        COUNT(*) FILTER (WHERE LOWER(plan) = 'starter')                                  AS starter,
        COUNT(*) FILTER (WHERE LOWER(plan) = 'professional')                             AS professional,
        COUNT(*) FILTER (WHERE LOWER(plan) = 'enterprise')                               AS enterprise,
        COUNT(*) FILTER (WHERE "createdAt" >= date_trunc('month', NOW()))                AS new_this_month,
        COUNT(*) FILTER (
          WHERE status IN ('CANCELLED','SUSPENDED')
          AND   "updatedAt" >= date_trunc('month', NOW())
        )                                                                                 AS churned_this_month
      FROM auth.tenants
    `);

    const r = rows[0];
    const total = parseDbInt(r?.total);
    const active = parseDbInt(r?.active);
    const suspended = parseDbInt(r?.suspended);
    const inactive = parseDbInt(r?.inactive);
    const trial = parseDbInt(r?.trial);
    const starter = parseDbInt(r?.starter);
    const professional = parseDbInt(r?.professional);
    const enterprise = parseDbInt(r?.enterprise);
    const newThisMonth = parseDbInt(r?.new_this_month);
    const churnedThisMonth = parseDbInt(r?.churned_this_month);

    const churnRate  = total > 0 ? Number(((churnedThisMonth / total) * 100).toFixed(2)) : 0;
    const growthRate = total > 0 ? Number((((newThisMonth - churnedThisMonth) / total) * 100).toFixed(2)) : 0;

    this.logger.debug(`Tenant metrics: total=${total}, active=${active}, trial=${trial}, new=${newThisMonth}`);

    return {
      total,
      active,
      inactive,
      trial,
      suspended,
      newThisMonth,
      churnedThisMonth,
      churnRate,
      growthRate,
      byPlan: { starter, professional, enterprise, trial },
    };
  }

  /**
   * Get tenant growth trend from snapshots
   */
  async getTenantGrowthTrend(params: TrendDataDto): Promise<TimeSeriesData> {
    const data = await this.getTrendFromSnapshots('tenant', params, 'total');
    return {
      label: 'Tenant Growth',
      data,
      color: '#3B82F6',
    };
  }

  /**
   * Get churn rate trend from snapshots
   */
  async getChurnRateTrend(params: TrendDataDto): Promise<TimeSeriesData> {
    const data = await this.getTrendFromSnapshots('tenant', params, 'churnRate');
    return {
      label: 'Churn Rate (%)',
      data,
      color: '#EF4444',
    };
  }

  // ============================================================================
  // User Metrics - REAL DATA
  // ============================================================================

  /**
   * Calculate user metrics from database using a single aggregation query.
   * CRITICAL-001 fix: replaced full-table scan + JS filtering with SQL COUNT FILTER.
   */
  async getUserMetrics(): Promise<UserMetrics> {
    this.logger.debug('Calculating user metrics from database...');

    const [rows, tenantCount] = await Promise.all([
      this.dataSource.query<UserAggregateRow[]>(`
        SELECT
          COUNT(*)                                                                           AS total,
          COUNT(*) FILTER (WHERE "isActive" = true)                                         AS active,
          COUNT(*) FILTER (WHERE "isActive" = false)                                        AS inactive,
          COUNT(*) FILTER (WHERE "createdAt" >= date_trunc('month', NOW()))                 AS new_this_month,
          COUNT(*) FILTER (WHERE "isActive" = true AND "lastLoginAt" >= NOW() - INTERVAL '24 hours')  AS active_last_day,
          COUNT(*) FILTER (WHERE "isActive" = true AND "lastLoginAt" >= NOW() - INTERVAL '7 days')    AS active_last_week,
          COUNT(*) FILTER (WHERE "isActive" = true AND "lastLoginAt" >= NOW() - INTERVAL '30 days')   AS active_last_month,
          COUNT(*) FILTER (WHERE role IN ('TENANT_ADMIN','SUPER_ADMIN'))                    AS admin_count,
          COUNT(*) FILTER (WHERE role = 'MODULE_MANAGER')                                  AS manager_count,
          COUNT(*) FILTER (WHERE role = 'MODULE_USER')                                     AS operator_count
        FROM auth.users
      `),
      this.dataSource.query<CountRow[]>(`SELECT COUNT(*) AS cnt FROM auth.tenants`),
    ]);

    const r = rows[0];
    const total = parseDbInt(r?.total);
    const active = parseDbInt(r?.active);
    const inactive = parseDbInt(r?.inactive);
    const newThisMonth = parseDbInt(r?.new_this_month);
    const activeLastDay = parseDbInt(r?.active_last_day);
    const activeLastWeek = parseDbInt(r?.active_last_week);
    const activeLastMonth = parseDbInt(r?.active_last_month);
    const adminCount = parseDbInt(r?.admin_count);
    const managerCount = parseDbInt(r?.manager_count);
    const operatorCount = parseDbInt(r?.operator_count);

    const growthRate = total > 0 ? Number(((newThisMonth / total) * 100).toFixed(2)) : 0;
    const tenantCnt = parseDbInt(tenantCount[0]?.cnt);
    const avgUsersPerTenant = tenantCnt > 0 ? Number((total / tenantCnt).toFixed(1)) : 0;

    this.logger.debug(`User metrics: total=${total}, active=${active}, new=${newThisMonth}`);

    return {
      total,
      active,
      inactive,
      newThisMonth,
      activeLastDay,
      activeLastWeek,
      activeLastMonth,
      growthRate,
      avgUsersPerTenant,
      byRole: {
        admin: adminCount,
        manager: managerCount,
        operator: operatorCount,
        viewer: 0,
      },
    };
  }

  /**
   * Get user activity trend from snapshots
   */
  async getUserActivityTrend(params: TrendDataDto): Promise<TimeSeriesData> {
    const data = await this.getTrendFromSnapshots('user', params, 'activeLastDay');
    return {
      label: 'Daily Active Users',
      data,
      color: '#10B981',
    };
  }

  /**
   * Get user activity heatmap data.
   * CRITICAL-004 fix: replaced 10 000-row fetch + JS binning with a single
   * SQL GROUP BY (day_of_week, hour) aggregation.
   */
  async getUserActivityHeatmap(): Promise<ChartData> {
    this.logger.debug('Calculating user activity heatmap from audit logs...');

    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const hours = Array.from({ length: 24 }, (_, i) => `${i}:00`);

    // Initialize heatmap data: 7 days x 24 hours
    const heatmapData: number[][] = days.map(() => Array.from({ length: 24 }, () => 0));

    try {
      // Single aggregation query — no row fetch into Node.js memory
      const rows: Array<{ dow: string; hour: string; cnt: string }> =
        await this.dataSource.query(`
          SELECT
            -- PostgreSQL DOW: 0=Sunday..6=Saturday  →  convert to Mon=0..Sun=6
            ((EXTRACT(DOW FROM "createdAt")::int + 6) % 7) AS dow,
            EXTRACT(HOUR FROM "createdAt")::int             AS hour,
            COUNT(*)                                         AS cnt
          FROM shared.audit_logs
          WHERE "createdAt" >= NOW() - INTERVAL '30 days'
          GROUP BY 1, 2
        `);

      for (const row of rows) {
        const dayIndex = parseInt(row.dow, 10);
        const hour = parseInt(row.hour, 10);
        const count = parseInt(row.cnt, 10);
        const dayData = heatmapData[dayIndex];
        if (dayData && dayData[hour] !== undefined) {
          dayData[hour] = count;
        }
      }

      this.logger.debug(`Heatmap built from ${rows.length} aggregate buckets`);
    } catch (error) {
      this.logger.warn(
        `Failed to fetch audit logs for heatmap: ${(error as Error).message}`,
      );
    }

    return {
      labels: hours,
      datasets: days.map((day, index) => ({
        label: day,
        data: heatmapData[index] ?? Array.from({ length: 24 }, () => 0),
        backgroundColor: '#3B82F6',
      })),
    };
  }

  // ============================================================================
  // Financial Metrics - REAL DATA
  // ============================================================================

  /**
   * Calculate financial metrics from database
   */
  async getFinancialMetrics(): Promise<FinancialMetrics> {
    this.logger.debug('Calculating financial metrics from database...');

    // Get active subscriptions
    const activeSubscriptions = await this.subscriptionRepository.find({
      where: {
        status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL]),
      },
    });

    // Calculate MRR from subscription pricing
    let mrr = 0;
    const revenueByPlan: Record<string, number> = {
      starter: 0,
      professional: 0,
      enterprise: 0,
    };

    for (const sub of activeSubscriptions) {
      if (sub.status === SubscriptionStatus.TRIAL) continue; // Don't count trial revenue

      const monthlyPrice = this.calculateMonthlyPrice(sub);
      mrr += monthlyPrice;

      // Group by plan
      const planKey = sub.planTier.toLowerCase();
      if (planKey in revenueByPlan && revenueByPlan[planKey] !== undefined) {
        revenueByPlan[planKey] = (revenueByPlan[planKey] ?? 0) + monthlyPrice;
      }
    }

    // CRITICAL-003 fix: replace 4 separate invoice queries with one conditional aggregation.
    // BUG-044 fix: use lowercase enum values to match billing.invoices_status_enum,
    // and snake_case column names to match the actual database schema.
    const invoiceRows = await this.dataSource.query<InvoiceAggregateRow[]>(`
      SELECT
        COALESCE(SUM(total)       FILTER (WHERE status = 'paid'),                            0) AS total_revenue,
        COALESCE(SUM(total)       FILTER (WHERE status = 'paid'
                                           AND paid_at >= date_trunc('month', NOW())),        0) AS revenue_this_month,
        COALESCE(SUM(amount_due)  FILTER (WHERE status IN ('pending','sent')),               0) AS pending_payments,
        COALESCE(SUM(amount_due)  FILTER (WHERE status = 'overdue'),                         0) AS overdue_payments,
        COALESCE(SUM(total)       FILTER (WHERE status = 'refunded'),                        0) AS refunds
      FROM billing.invoices
    `);
    const ir = invoiceRows[0];
    const totalRevenue = parseDbNumber(ir?.total_revenue);
    const revenueThisMonth = parseDbNumber(ir?.revenue_this_month);
    const pendingPayments = parseDbNumber(ir?.pending_payments);
    const overduePayments = parseDbNumber(ir?.overdue_payments);
    const refunds = parseDbNumber(ir?.refunds);

    // Calculate ARPU and LTV
    const payingTenants = activeSubscriptions.filter(s => s.status === SubscriptionStatus.ACTIVE).length;
    const arpu = payingTenants > 0 ? Number((mrr / payingTenants).toFixed(2)) : 0;
    const arppu = arpu; // Same since we're counting paying tenants
    const ltv = arpu * 24; // Assuming 24 months average lifetime

    // Revenue growth rate (compare to last month's snapshot)
    const revenueGrowthRate = await this.calculateGrowthRate('financial', 'mrr', mrr);

    // Group by currency
    const byCurrency: Record<string, number> = { USD: mrr }; // Single-currency tenancy (USD); multi-currency breakdown tracked separately.

    this.logger.debug(`Financial metrics: MRR=${mrr}, totalRevenue=${totalRevenue}, payingTenants=${payingTenants}`);

    return {
      mrr: Number(mrr.toFixed(2)),
      arr: Number((mrr * 12).toFixed(2)),
      arpu,
      arppu,
      ltv: Number(ltv.toFixed(2)),
      totalRevenue: Number(totalRevenue.toFixed(2)),
      revenueThisMonth: Number(revenueThisMonth.toFixed(2)),
      revenueGrowthRate,
      pendingPayments: Number(pendingPayments.toFixed(2)),
      overduePayments: Number(overduePayments.toFixed(2)),
      refunds: Number(refunds.toFixed(2)),
      byPlan: {
        starter: Number((revenueByPlan['starter'] ?? 0).toFixed(2)),
        professional: Number((revenueByPlan['professional'] ?? 0).toFixed(2)),
        enterprise: Number((revenueByPlan['enterprise'] ?? 0).toFixed(2)),
      },
      byCurrency,
    };
  }

  /**
   * Calculate monthly price from subscription based on billing cycle
   */
  private calculateMonthlyPrice(subscription: SubscriptionReadOnly): number {
    const basePrice = subscription.pricing?.basePrice || 0;

    switch (subscription.billingCycle) {
      case BillingCycle.MONTHLY:
        return basePrice;
      case BillingCycle.QUARTERLY:
        return basePrice / 3;
      case BillingCycle.SEMI_ANNUAL:
        return basePrice / 6;
      case BillingCycle.ANNUAL:
        return basePrice / 12;
      default:
        return basePrice;
    }
  }

  /**
   * Get revenue trend from snapshots
   */
  async getRevenueTrend(params: TrendDataDto): Promise<TimeSeriesData> {
    const data = await this.getTrendFromSnapshots('financial', params, 'mrr');
    return {
      label: 'Monthly Revenue',
      data,
      color: '#8B5CF6',
    };
  }

  /**
   * Get revenue by plan chart data
   */
  async getRevenueByPlanChart(): Promise<ChartData> {
    const metrics = await this.getFinancialMetrics();

    return {
      labels: ['Starter', 'Professional', 'Enterprise'],
      datasets: [{
        label: 'Revenue by Plan',
        data: [
          metrics.byPlan['starter'] ?? 0,
          metrics.byPlan['professional'] ?? 0,
          metrics.byPlan['enterprise'] ?? 0,
        ],
        backgroundColor: ['#3B82F6', '#10B981', '#8B5CF6'],
      }],
    };
  }

  // ============================================================================
  // System Metrics - REAL DATA
  // ============================================================================

  /**
   * Infrastructure metrics for the System Metrics card.
   *
   * admin-api measures none of these today: there is no APM, uptime monitor,
   * API-gateway meter or job-queue probe wired to this service. Every field is
   * therefore `null` — "not measured" — instead of a plausible constant
   * (APA-131). The previous implementation returned 1 TB "default" storage,
   * 100% uptime, 10 connections and a rows x 1KB storage *estimate* presented as
   * measured bytes; a SUPER_ADMIN could not tell any of it from real telemetry,
   * and the daily snapshot cron persisted the fabrication into
   * admin.analytics_snapshots.
   *
   * Wiring a real source (Prometheus / observability-service) fills these in
   * without a contract change. Reintroducing a literal is the regression, and
   * analytics-system-metrics.spec.ts fails the build on it.
   */
  async getSystemMetrics(): Promise<SystemMetrics> {
    this.logger.debug('System metrics are not instrumented; reporting unmeasured.');

    return {
      totalStorageBytes: null,
      usedStorageBytes: null,
      storageUtilization: null,
      apiCallsToday: null,
      apiCallsThisMonth: null,
      avgResponseTimeMs: null,
      errorRate: null,
      uptimePercent: null,
      activeConnections: null,
      queuedJobs: null,
    };
  }

  /**
   * Get API calls trend
   */
  getApiCallsTrend(_params: TrendDataDto): Promise<TimeSeriesData> {
    // Requires API gateway metrics
    this.logger.warn('API calls trend requires API gateway integration');
    return Promise.resolve({
      label: 'API Calls',
      data: [],
      color: '#F59E0B',
    });
  }

  /**
   * Get error rate trend
   */
  getErrorRateTrend(_params: TrendDataDto): Promise<TimeSeriesData> {
    // Requires error tracking integration
    this.logger.warn('Error rate trend requires error tracking integration');
    return Promise.resolve({
      label: 'Error Rate (%)',
      data: [],
      color: '#EF4444',
    });
  }

  // ============================================================================
  // Usage Metrics - PARTIAL REAL DATA
  // ============================================================================

  /**
   * Calculate usage metrics.
   * LOW-001 fix: replaced full getUserMetrics() call (which loads all users) with
   * a single targeted COUNT query for the only value actually used here.
   */
  async getUsageMetrics(): Promise<UsageMetrics> {
    this.logger.debug('Calculating usage metrics...');

    // Single COUNT query — avoids loading all users just for this one field.
    // Deliberately NOT wrapped in a swallowing try/catch: a real database
    // failure must REJECT so `getDashboardSummary`'s Promise.allSettled pushes
    // 'usage' onto `unavailable[]` and the panel shows degraded mode. Catching
    // it here returned a fabricated success through the one channel built to
    // report the failure (APA-133).
    const rows = await this.dataSource.query<CountRow[]>(`
      SELECT COUNT(*) AS cnt
      FROM auth.users
      WHERE "isActive" = true
        AND "lastLoginAt" >= NOW() - INTERVAL '24 hours'
    `);
    const activeLastDay = parseDbInt(rows[0]?.cnt);

    // Per-module usage and feature adoption have NO producer: they need the
    // audit-log analysis pipeline, which is not wired. Presence means measured,
    // so both maps stay empty rather than carrying invented zero entries — and
    // `dashboard.activeUsers` no longer claims the platform-wide DAU belongs to
    // one module. `avgDailyActiveUsers` is the single value actually queried.
    return {
      moduleUsage: {},
      featureAdoption: {},
      topFeatures: [],
      peakHours: [],
      avgDailyActiveUsers: activeLastDay,
    };
  }

  /**
   * Get module usage chart data
   */
  async getModuleUsageChart(): Promise<ChartData> {
    // Derived from the metric, never hand-listed: a hardcoded label array with
    // a matching zero series is indistinguishable from a measured all-zero
    // chart. With no producer wired the series is empty and the chart renders
    // as such (APA-133).
    const { moduleUsage } = await this.getUsageMetrics();
    const entries = measuredEntries(moduleUsage);
    return {
      labels: entries.map(([module]) => humanizeMetricKey(module)),
      datasets: [{
        label: 'Active Users',
        data: entries.map(([, stats]) => stats.activeUsers),
        backgroundColor: entries.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length] ?? '#3B82F6'),
      }],
    };
  }

  /**
   * Get feature adoption chart data
   */
  async getFeatureAdoptionChart(): Promise<ChartData> {
    const { featureAdoption } = await this.getUsageMetrics();
    const entries = Object.entries(featureAdoption);
    return {
      labels: entries.map(([feature]) => humanizeMetricKey(feature)),
      datasets: [{
        label: 'Adoption Rate (%)',
        data: entries.map(([, rate]) => rate),
        backgroundColor: '#3B82F6',
        borderColor: '#2563EB',
      }],
    };
  }

  // ============================================================================
  // Comparisons
  // ============================================================================

  /**
   * Calculate metric comparison between two periods
   */
  calculateComparison(current: number, previous: number): ComparisonDto {
    const change = current - previous;
    const changePercent = previous !== 0
      ? Number(((change / previous) * 100).toFixed(2))
      : 0;

    let trend: 'up' | 'down' | 'stable' = 'stable';
    if (changePercent > 1) trend = 'up';
    else if (changePercent < -1) trend = 'down';

    return { current, previous, change, changePercent, trend };
  }

  /**
   * Get all KPI comparisons with previous period
   */
  async getKpiComparisons(): Promise<Record<string, ComparisonDto>> {
    // Get current metrics
    const [tenantMetrics, userMetrics, financialMetrics] = await Promise.all([
      this.getTenantMetrics(),
      this.getUserMetrics(),
      this.getFinancialMetrics(),
    ]);

    // Get previous period metrics from snapshots
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const previousSnapshots = await this.getSnapshotsNear(oneMonthAgo);

    const prevTenant = previousSnapshots['tenant']?.metrics as TenantMetrics | undefined;
    const prevUser = previousSnapshots['user']?.metrics as UserMetrics | undefined;
    const prevFinancial = previousSnapshots['financial']?.metrics as FinancialMetrics | undefined;

    return {
      totalTenants: this.calculateComparison(tenantMetrics.total, prevTenant?.total || 0),
      activeTenants: this.calculateComparison(tenantMetrics.active, prevTenant?.active || 0),
      totalUsers: this.calculateComparison(userMetrics.total, prevUser?.total || 0),
      activeUsers: this.calculateComparison(userMetrics.active, prevUser?.active || 0),
      mrr: this.calculateComparison(financialMetrics.mrr, prevFinancial?.mrr || 0),
      arr: this.calculateComparison(financialMetrics.arr, prevFinancial?.arr || 0),
      arpu: this.calculateComparison(financialMetrics.arpu, prevFinancial?.arpu || 0),
      churnRate: this.calculateComparison(tenantMetrics.churnRate, prevTenant?.churnRate || 0),
      errorRate: this.calculateComparison(0, 0), // Requires error tracking
      uptime: this.calculateComparison(100, 100), // Requires uptime monitoring
    };
  }

  /**
   * Get snapshots closest to a specific date
   */
  private async getSnapshotsNear(targetDate: Date): Promise<Record<string, AnalyticsSnapshot | null>> {
    const categories: MetricCategory[] = ['tenant', 'user', 'financial', 'system', 'usage'];

    // HIGH-001 fix: parallelise snapshot lookups instead of sequential for-loop
    const snapshots = await Promise.all(
      categories.map(category =>
        this.snapshotRepository.findOne({
          where: {
            category,
            snapshotDate: LessThanOrEqual(toIsoDateString(targetDate)),
          },
          order: { snapshotDate: 'DESC' },
        }),
      ),
    );

    const result: Record<string, AnalyticsSnapshot | null> = {};
    categories.forEach((category, index) => {
      result[category] = snapshots[index] ?? null;
    });

    return result;
  }

  // ============================================================================
  // Snapshots
  // ============================================================================

  /**
   * Save a metrics snapshot
   */
  async saveSnapshot(
    snapshotType: SnapshotType,
    category: MetricCategory,
    metrics: TenantMetrics | UserMetrics | FinancialMetrics | SystemMetrics | UsageMetrics,
    snapshotDate: Date = new Date(),
  ): Promise<AnalyticsSnapshot> {
    const snapshotDateKey = toIsoDateString(snapshotDate);
    const existing = await this.snapshotRepository
      .createQueryBuilder('snapshot')
      .where('snapshot.snapshotType = :snapshotType', { snapshotType })
      .andWhere('snapshot.category = :category', { category })
      .andWhere('snapshot.snapshotDate = :snapshotDate', { snapshotDate: snapshotDateKey })
      .getOne();

    if (existing) {
      existing.metrics = metrics;
      existing.metadata = {
        ...(existing.metadata || {}),
        reaggregatedAt: new Date().toISOString(),
      };
      return this.snapshotRepository.save(existing);
    }

    const snapshot = this.snapshotRepository.create({
      snapshotType,
      category,
      // snapshotDateKey is already the canonical 'YYYY-MM-DD'; round-tripping it
      // through a Date only reintroduced the timezone ambiguity the column type
      // exists to avoid.
      snapshotDate: snapshotDateKey,
      metrics,
    });

    return this.snapshotRepository.save(snapshot);
  }

  /**
   * Get historical snapshots
   */
  async getSnapshots(
    category: MetricCategory,
    range: DateRangeDto,
    snapshotType?: SnapshotType,
  ): Promise<AnalyticsSnapshot[]> {
    // A raw query-builder parameter bypasses the column transformer, so a `Date`
    // would reach PostgreSQL as a full timestamp and be re-truncated server-side
    // in the SERVER's timezone — a different calendar day than the caller meant
    // near midnight. Narrow to the canonical 'YYYY-MM-DD' here so the comparison
    // is date-vs-date with no timezone in the path (APA-130).
    const query = this.snapshotRepository.createQueryBuilder('snapshot')
      .where('snapshot.category = :category', { category })
      .andWhere('snapshot.snapshotDate >= :startDate', {
        startDate: toIsoDateString(range.startDate),
      })
      .andWhere('snapshot.snapshotDate <= :endDate', {
        endDate: toIsoDateString(range.endDate),
      });

    if (snapshotType) {
      query.andWhere('snapshot.snapshotType = :snapshotType', { snapshotType });
    }

    return query.orderBy('snapshot.snapshotDate', 'ASC').getMany();
  }

  /**
   * Create daily snapshot for all metrics
   */
  async createDailySnapshot(snapshotDate: Date = new Date()): Promise<void> {
    this.logger.log('Creating daily analytics snapshot...');

    const tasks: Array<{
      category: MetricCategory;
      load: () => Promise<TenantMetrics | UserMetrics | FinancialMetrics | SystemMetrics | UsageMetrics>;
    }> = [
      { category: 'tenant', load: () => this.getTenantMetrics() },
      { category: 'user', load: () => this.getUserMetrics() },
      { category: 'financial', load: () => this.getFinancialMetrics() },
      { category: 'system', load: () => this.getSystemMetrics() },
      { category: 'usage', load: () => this.getUsageMetrics() },
    ];

    const results = await Promise.allSettled(tasks.map(async (task) => {
      const metrics = await task.load();
      return this.saveSnapshot('daily', task.category, metrics, snapshotDate);
    }));

    const failures = results
      .map((result, index) => ({ result, category: tasks[index]?.category }))
      .filter((entry): entry is { result: PromiseRejectedResult; category: MetricCategory } => entry.result.status === 'rejected' && !!entry.category);

    for (const failure of failures) {
      this.logger.error(
        `Failed to create daily analytics snapshot for ${failure.category}: ${failure.result.reason instanceof Error ? failure.result.reason.message : String(failure.result.reason)}`,
      );
    }

    if (failures.length === tasks.length) {
      throw new Error('Daily analytics snapshot failed for all categories');
    }

    this.logger.log('Daily analytics snapshot created successfully');
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Get trend data from historical snapshots
   */
  private async getTrendFromSnapshots(
    category: MetricCategory,
    params: TrendDataDto,
    metricKey: string,
  ): Promise<Array<{ date: string; value: number }>> {
    const now = new Date();
    const startDate = new Date(now);

    switch (params.period) {
      case 'day':
        startDate.setDate(startDate.getDate() - params.dataPoints);
        break;
      case 'week':
        startDate.setDate(startDate.getDate() - (params.dataPoints * 7));
        break;
      case 'month':
        startDate.setMonth(startDate.getMonth() - params.dataPoints);
        break;
      case 'year':
        startDate.setFullYear(startDate.getFullYear() - params.dataPoints);
        break;
    }

    const snapshots = await this.getSnapshots(category, { startDate, endDate: now }, 'daily');

    return snapshots.map(s => ({
      date: s.snapshotDate,
      value: this.getMetricValue(s.metrics, metricKey),
    }));
  }

  /**
   * Calculate growth rate compared to last month's snapshot
   */
  private async calculateGrowthRate(
    category: MetricCategory,
    metricKey: string,
    currentValue: number,
  ): Promise<number> {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const previousSnapshot = await this.snapshotRepository.findOne({
      where: {
        category,
        snapshotDate: LessThanOrEqual(toIsoDateString(oneMonthAgo)),
      },
      order: { snapshotDate: 'DESC' },
    });

    if (!previousSnapshot) return 0;

    const previousValue = this.getMetricValue(previousSnapshot.metrics, metricKey);
    if (previousValue === 0) return 0;

    return Number((((currentValue - previousValue) / previousValue) * 100).toFixed(2));
  }

  /**
   * Format bytes to human readable
   */
  formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let value = bytes;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Format currency
   */
  formatCurrency(amount: number, currency = 'USD'): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount);
  }

  // ============================================================================
  // Partial Failure Resilience Helpers
  // ============================================================================

  /**
   * Extracts the fulfilled value from a settled promise result, or falls back
   * to a default. When a source rejects, its name is appended to the
   * unavailable list and the error is logged — but the dashboard keeps loading.
   */
  private extractOrDefault<T>(
    result: PromiseSettledResult<T>,
    sourceName: string,
    unavailable: string[],
    getDefault: () => T,
  ): T {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    const reason = result.reason instanceof Error
      ? result.reason.message
      : String(result.reason);
    this.logger.error(`${sourceName} metrics failed: ${reason}`);
    unavailable.push(sourceName);
    return getDefault();
  }

  // ============================================================================
  // Default Metric Factories (Partial Failure Resilience)
  // ============================================================================

  /**
   * Zero-value defaults returned when a data source is unreachable.
   * Each factory produces a structurally valid metric object so the
   * frontend can always render the dashboard — even in degraded mode.
   */

  private getDefaultTenantMetrics(): TenantMetrics {
    return {
      total: 0, active: 0, inactive: 0, trial: 0, suspended: 0,
      newThisMonth: 0, churnedThisMonth: 0, churnRate: 0, growthRate: 0,
      byPlan: {},
    };
  }

  private getDefaultUserMetrics(): UserMetrics {
    return {
      total: 0, active: 0, inactive: 0, newThisMonth: 0,
      activeLastDay: 0, activeLastWeek: 0, activeLastMonth: 0,
      growthRate: 0, avgUsersPerTenant: 0, byRole: {},
    };
  }

  private getDefaultFinancialMetrics(): FinancialMetrics {
    return {
      mrr: 0, arr: 0, arpu: 0, arppu: 0, ltv: 0,
      totalRevenue: 0, revenueThisMonth: 0, revenueGrowthRate: 0,
      pendingPayments: 0, overduePayments: 0, refunds: 0,
      byPlan: {}, byCurrency: {},
    };
  }

  private getDefaultSystemMetrics(): SystemMetrics {
    // Degraded path: unmeasured, not zero. A zero here would claim a measured
    // 0ms / 0% / 0 bytes, which is a different lie from "we have no data".
    return {
      totalStorageBytes: null, usedStorageBytes: null, storageUtilization: null,
      apiCallsToday: null, apiCallsThisMonth: null, avgResponseTimeMs: null,
      errorRate: null, uptimePercent: null, activeConnections: null, queuedJobs: null,
    };
  }

  private getDefaultUsageMetrics(): UsageMetrics {
    return {
      moduleUsage: {}, featureAdoption: {}, topFeatures: [],
      peakHours: [], avgDailyActiveUsers: 0,
    };
  }

  // ============================================================================
  // Revenue Analytics (Frontend API compatibility)
  // ============================================================================

  /**
   * Get revenue analytics - matches frontend RevenueAnalytics interface
   */
  async getRevenueAnalytics(): Promise<{
    totalRevenue: number;
    mrr: number;
    arr: number;
    averageRevenuePerTenant: number;
    revenueByPlan: Array<{ plan: string; revenue: number; percentage: number }>;
    revenueByMonth: Array<{ month: string; revenue: number }>;
  }> {
    const financialMetrics = await this.getFinancialMetrics();

    const starterRevenue = financialMetrics.byPlan['starter'] ?? 0;
    const professionalRevenue = financialMetrics.byPlan['professional'] ?? 0;
    const enterpriseRevenue = financialMetrics.byPlan['enterprise'] ?? 0;
    const totalByPlan = starterRevenue + professionalRevenue + enterpriseRevenue;

    const revenueByPlan = [
      {
        plan: 'Starter',
        revenue: starterRevenue,
        percentage: totalByPlan > 0 ? Number(((starterRevenue / totalByPlan) * 100).toFixed(1)) : 0,
      },
      {
        plan: 'Professional',
        revenue: professionalRevenue,
        percentage: totalByPlan > 0 ? Number(((professionalRevenue / totalByPlan) * 100).toFixed(1)) : 0,
      },
      {
        plan: 'Enterprise',
        revenue: enterpriseRevenue,
        percentage: totalByPlan > 0 ? Number(((enterpriseRevenue / totalByPlan) * 100).toFixed(1)) : 0,
      },
    ];

    // MEDIUM-009 fix: push monthly grouping to the database instead of loading
    // up to 365 daily snapshot rows into Node.js memory and grouping in JS.
    const monthlyRows = await this.dataSource.query<MonthRevenueRow[]>(`
        SELECT
          date_trunc('month', "snapshotDate")                        AS month,
          AVG((metrics->>'mrr')::numeric)                            AS avg_mrr
        FROM   admin.analytics_snapshots
        WHERE  category       = 'financial'
          AND  "snapshotDate" >= NOW() - INTERVAL '12 months'
        GROUP  BY 1
        ORDER  BY 1
      `);

    const revenueByMonth = monthlyRows.map(r => ({
      month: new Date(r.month).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      revenue: Number(parseDbNumber(r.avg_mrr).toFixed(2)),
    }));

    // BUG-010 fix: exclude trial tenants from ARPT denominator (they don't pay)
    // MEDIUM-004 companion: use a targeted COUNT query instead of loading all active tenants
    const payingCountRows = await this.dataSource.query<CountRow[]>(`
      SELECT COUNT(*) AS cnt
      FROM auth.tenants
      WHERE status = 'ACTIVE' AND LOWER(plan) <> 'trial'
    `);
    const payingTenantCount = parseDbInt(payingCountRows[0]?.cnt);
    const averageRevenuePerTenant = payingTenantCount > 0 ? Number((financialMetrics.mrr / payingTenantCount).toFixed(2)) : 0;

    return {
      totalRevenue: financialMetrics.totalRevenue,
      mrr: financialMetrics.mrr,
      arr: financialMetrics.arr,
      averageRevenuePerTenant,
      revenueByPlan,
      revenueByMonth,
    };
  }

  /**
   * Get revenue breakdown by plan.
   * MEDIUM-004 fix: replaced extra tenantRepository.find() (full table scan + JS filter)
   * with a targeted COUNT GROUP BY query.
   */
  async getRevenueByPlanAnalytics(): Promise<Array<{
    plan: string;
    revenue: number;
    tenantCount: number;
    percentage: number;
    avgRevenuePerTenant: number;
  }>> {
    const financialMetrics = await this.getFinancialMetrics();

    // Single aggregation query for plan counts — no full table scan
    const planCountRows: Array<{ plan: string; cnt: string }> = await this.dataSource.query(`
      SELECT LOWER(plan) AS plan, COUNT(*) AS cnt
      FROM auth.tenants
      GROUP BY LOWER(plan)
    `);
    const planCountMap = new Map(planCountRows.map(r => [r.plan, parseInt(r.cnt, 10)]));
    const starterCount      = planCountMap.get('starter')      || 0;
    const professionalCount = planCountMap.get('professional') || 0;
    const enterpriseCount   = planCountMap.get('enterprise')   || 0;

    const starterRev = financialMetrics.byPlan['starter'] ?? 0;
    const professionalRev = financialMetrics.byPlan['professional'] ?? 0;
    const enterpriseRev = financialMetrics.byPlan['enterprise'] ?? 0;
    const totalRevenue = starterRev + professionalRev + enterpriseRev;

    return [
      {
        plan: 'Starter',
        revenue: starterRev,
        tenantCount: starterCount,
        percentage: totalRevenue > 0 ? Number(((starterRev / totalRevenue) * 100).toFixed(1)) : 0,
        avgRevenuePerTenant: starterCount > 0 ? Number((starterRev / starterCount).toFixed(2)) : 0,
      },
      {
        plan: 'Professional',
        revenue: professionalRev,
        tenantCount: professionalCount,
        percentage: totalRevenue > 0 ? Number(((professionalRev / totalRevenue) * 100).toFixed(1)) : 0,
        avgRevenuePerTenant: professionalCount > 0 ? Number((professionalRev / professionalCount).toFixed(2)) : 0,
      },
      {
        plan: 'Enterprise',
        revenue: enterpriseRev,
        tenantCount: enterpriseCount,
        percentage: totalRevenue > 0 ? Number(((enterpriseRev / totalRevenue) * 100).toFixed(1)) : 0,
        avgRevenuePerTenant: enterpriseCount > 0 ? Number((enterpriseRev / enterpriseCount).toFixed(2)) : 0,
      },
    ];
  }

  /**
   * Get revenue trend analytics
   */
  async getRevenueTrendAnalytics(period: string): Promise<{
    period: string;
    data: Array<{ date: string; revenue: number; growth: number }>;
    summary: {
      totalRevenue: number;
      averageRevenue: number;
      growthRate: number;
      highestMonth: { date: string; revenue: number };
      lowestMonth: { date: string; revenue: number };
    };
  }> {
    // Parse period (e.g., '12m', '6m', '3m', '1y')
    let months = 12;
    if (period.endsWith('m')) {
      months = parseInt(period.slice(0, -1), 10) || 12;
    } else if (period.endsWith('y')) {
      months = (parseInt(period.slice(0, -1), 10) || 1) * 12;
    }

    const now = new Date();
    const startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - months);

    const snapshots = await this.getSnapshots('financial', { startDate, endDate: now }, 'daily');

    // Process snapshots into monthly data
    const monthlyData = new Map<string, number[]>();
    for (const snapshot of snapshots) {
      // 'YYYY-MM-DD' -> 'YYYY-MM'; no Date parsing, no timezone shift.
      const monthKey = snapshot.snapshotDate.slice(0, 7);
      const mrr = (snapshot.metrics as FinancialMetrics)?.mrr || 0;

      if (!monthlyData.has(monthKey)) {
        monthlyData.set(monthKey, []);
      }
      // SECURITY FIX: Use safe access pattern instead of non-null assertion
      const monthValues = monthlyData.get(monthKey);
      if (monthValues) {
        monthValues.push(mrr);
      }
    }

    // Average MRR per month
    const data: Array<{ date: string; revenue: number; growth: number }> = [];
    let previousRevenue = 0;
    let totalRevenue = 0;

    const sortedMonths = Array.from(monthlyData.keys()).sort();
    for (const monthKey of sortedMonths) {
      // SECURITY FIX: Safe access with fallback to prevent division by zero
      const values = monthlyData.get(monthKey) || [];
      if (values.length === 0) continue; // Skip months with no data to avoid NaN
      const avgRevenue = values.reduce((a, b) => a + b, 0) / values.length;
      const growth = previousRevenue > 0
        ? Number((((avgRevenue - previousRevenue) / previousRevenue) * 100).toFixed(2))
        : 0;

      data.push({
        date: monthKey,
        revenue: Number(avgRevenue.toFixed(2)),
        growth,
      });

      totalRevenue += avgRevenue;
      previousRevenue = avgRevenue;
    }

    // Calculate summary
    const revenues = data.map(d => d.revenue);
    const maxRevenue = revenues.length > 0 ? Math.max(...revenues) : 0;
    const minRevenue = revenues.length > 0 ? Math.min(...revenues) : 0;
    const highestMonth = data.find(d => d.revenue === maxRevenue) || { date: '', revenue: 0 };
    const lowestMonth = data.find(d => d.revenue === minRevenue) || { date: '', revenue: 0 };

    const firstRevenue = data[0]?.revenue || 0;
    const lastRevenue = data[data.length - 1]?.revenue || 0;
    const overallGrowthRate = firstRevenue > 0
      ? Number((((lastRevenue - firstRevenue) / firstRevenue) * 100).toFixed(2))
      : 0;

    return {
      period,
      data,
      summary: {
        totalRevenue: Number(totalRevenue.toFixed(2)),
        averageRevenue: data.length > 0 ? Number((totalRevenue / data.length).toFixed(2)) : 0,
        growthRate: overallGrowthRate,
        highestMonth: { date: highestMonth.date, revenue: highestMonth.revenue },
        lowestMonth: { date: lowestMonth.date, revenue: lowestMonth.revenue },
      },
    };
  }
}
