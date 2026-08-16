/**
 * Analytics Service
 *
 * Dashboard KPI calculations and metric aggregation.
 * Calculates Tenant, User, Financial and System metrics from REAL data.
 *
 * NO MOCK DATA - All metrics are calculated from database queries.
 */

import { RedisService } from '@aquaculture/backend-common/redis';
import {
  ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256,
  analyticsMetricSectionProjectionHasValidEvidenceV1,
  canonicalWireJsonSha256V1,
  createAnalyticsMetricSectionProjectionV1,
  createUnavailableAnalyticsMetricSectionProjectionV1,
  type AnalyticsMetricSection,
  type AnalyticsMetricSectionProjectionV1,
  type AnalyticsMetricSectionValuesV1,
  type CanonicalJsonValue,
} from '@aquaculture/shared-contracts';
import {
  ConflictException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual, Repository } from 'typeorm';

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
} from '../entities/analytics-snapshot.entity';
import {
  BillingCycle,
  SubscriptionReadOnly,
  SubscriptionStatus,
} from '../entities/external/subscription.entity';

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
  changePercent: number | null;
  trend: 'up' | 'down' | 'stable' | 'unavailable';
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

interface SystemAggregateRow {
  used_storage_bytes: DbNumeric;
  active_connections: DbNumeric;
}

function parseDbNumber(value: DbNumeric, field: string): number {
  if (value === null || value === undefined || value === '') {
    throw new ServiceUnavailableException(`Analytics source omitted ${field}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ServiceUnavailableException(`Analytics source returned invalid ${field}`);
  }
  return parsed;
}

function parseDbInt(value: DbNumeric, field: string): number {
  const parsed = parseDbNumber(value, field);
  if (!Number.isSafeInteger(parsed)) {
    throw new ServiceUnavailableException(`Analytics source returned non-integer ${field}`);
  }
  return parsed;
}

type AnyAnalyticsMetrics =
  | TenantMetrics
  | UserMetrics
  | FinancialMetrics
  | SystemMetrics
  | UsageMetrics;

const METRIC_SECTION_BY_CATEGORY: Readonly<Record<MetricCategory, AnalyticsMetricSection>> =
  Object.freeze({
    tenant: 'tenants',
    user: 'users',
    financial: 'financial',
    system: 'system',
    usage: 'usage',
  });

const ANALYTICS_SNAPSHOT_METRIC_HASH_AUTHORITY_V1 = Object.freeze({
  domain: 'aquaculture.analytics-snapshot-metrics',
  schemaVersion: 'analytics-snapshot-metrics/v1',
});

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(AnalyticsSnapshot)
    private readonly snapshotRepository: Repository<AnalyticsSnapshot>,
    @InjectRepository(SubscriptionReadOnly)
    private readonly subscriptionRepository: Repository<SubscriptionReadOnly>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional()
    private readonly redisService?: RedisService,
  ) {}

  /**
   * Type-safe helper to extract numeric metric value from snapshot metrics
   * Handles the union type (TenantMetrics | UserMetrics | FinancialMetrics | SystemMetrics | UsageMetrics)
   */
  private getMetricValue(metrics: AnyAnalyticsMetrics, key: string): number | null {
    // Since metrics is a JSONB object, we need to access it dynamically
    // but we ensure type safety by checking if the key exists and is a number
    // Metrics is a JSONB object — dynamic key access requires indexable type
    const metricsObj: Record<string, unknown> = { ...metrics };
    const value = metricsObj[key];

    if (typeof value === 'number' && !isNaN(value)) {
      return value;
    }
    return null;
  }

  private finalizeMetricSection<TSection extends AnalyticsMetricSection>(
    section: TSection,
    values: AnalyticsMetricSectionValuesV1<TSection>,
  ): AnalyticsMetricSectionProjectionV1<TSection> {
    return createAnalyticsMetricSectionProjectionV1(section, values, new Date().toISOString());
  }

  private unavailableMetricSection<TSection extends AnalyticsMetricSection>(
    section: TSection,
  ): AnalyticsMetricSectionProjectionV1<TSection> {
    return createUnavailableAnalyticsMetricSectionProjectionV1(section, new Date().toISOString());
  }

  private hasCurrentMetricCatalog(metrics: AnyAnalyticsMetrics | undefined): boolean {
    return metrics?.authority?.metricCatalogSha256 === ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256;
  }

  private requireMeasuredMetric<T>(value: T | null, metricId: string): T {
    if (value === null) {
      throw new ServiceUnavailableException(`Analytics metric unavailable: ${metricId}`);
    }
    return value;
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
        if (
          cached &&
          this.hasCurrentMetricCatalog(cached.tenants) &&
          this.hasCurrentMetricCatalog(cached.users) &&
          this.hasCurrentMetricCatalog(cached.financial) &&
          this.hasCurrentMetricCatalog(cached.system) &&
          this.hasCurrentMetricCatalog(cached.usage)
        ) {
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
     * unavailable), the dashboard still returns data from healthy sources.
     * Rejected sources compile to all-null, per-field evidence projections;
     * they are never represented by fabricated zero values. The 'unavailable'
     * array lists which sources rejected.
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

    const tenants = this.extractOrDefault(tenantsResult, 'tenants', unavailable, () =>
      this.unavailableMetricSection('tenants'),
    );
    const users = this.extractOrDefault(usersResult, 'users', unavailable, () =>
      this.unavailableMetricSection('users'),
    );
    const financial = this.extractOrDefault(financialResult, 'financial', unavailable, () =>
      this.unavailableMetricSection('financial'),
    );
    const system = this.extractOrDefault(systemResult, 'system', unavailable, () =>
      this.unavailableMetricSection('system'),
    );
    const usage = this.extractOrDefault(usageResult, 'usage', unavailable, () =>
      this.unavailableMetricSection('usage'),
    );

    if (unavailable.length > 0) {
      this.logger.warn(
        `Dashboard summary degraded — unavailable sources: ${unavailable.join(', ')}`,
      );
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
        .setJson(
          AnalyticsService.DASHBOARD_CACHE_KEY,
          summary,
          AnalyticsService.DASHBOARD_CACHE_TTL,
        )
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
        COUNT(*) FILTER (WHERE "createdAt" >= date_trunc('month', NOW()))                AS new_this_month
      FROM auth.tenants
    `);

    const r = rows[0];
    const total = parseDbInt(r?.total, 'tenants.total');
    const active = parseDbInt(r?.active, 'tenants.active');
    const suspended = parseDbInt(r?.suspended, 'tenants.suspended');
    const inactive = parseDbInt(r?.inactive, 'tenants.inactive');
    const trial = parseDbInt(r?.trial, 'tenants.trial');
    const starter = parseDbInt(r?.starter, 'tenants.byPlan.starter');
    const professional = parseDbInt(r?.professional, 'tenants.byPlan.professional');
    const enterprise = parseDbInt(r?.enterprise, 'tenants.byPlan.enterprise');
    const newThisMonth = parseDbInt(r?.new_this_month, 'tenants.newThisMonth');

    this.logger.debug(
      `Tenant metrics: total=${total}, active=${active}, trial=${trial}, new=${newThisMonth}`,
    );

    return this.finalizeMetricSection('tenants', {
      total,
      active,
      inactive,
      trial,
      suspended,
      newThisMonth,
      churnedThisMonth: null,
      churnRate: null,
      growthRate: null,
      byPlan: { starter, professional, enterprise, trial },
      byRegion: null,
    });
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
    const total = parseDbInt(r?.total, 'users.total');
    const active = parseDbInt(r?.active, 'users.active');
    const inactive = parseDbInt(r?.inactive, 'users.inactive');
    const newThisMonth = parseDbInt(r?.new_this_month, 'users.newThisMonth');
    const activeLastDay = parseDbInt(r?.active_last_day, 'users.activeLastDay');
    const activeLastWeek = parseDbInt(r?.active_last_week, 'users.activeLastWeek');
    const activeLastMonth = parseDbInt(r?.active_last_month, 'users.activeLastMonth');
    const adminCount = parseDbInt(r?.admin_count, 'users.byRole.admin');
    const managerCount = parseDbInt(r?.manager_count, 'users.byRole.manager');
    const operatorCount = parseDbInt(r?.operator_count, 'users.byRole.operator');

    const tenantCnt = parseDbInt(tenantCount[0]?.cnt, 'users.tenantCount');
    const avgUsersPerTenant = tenantCnt > 0 ? Number((total / tenantCnt).toFixed(1)) : 0;

    this.logger.debug(`User metrics: total=${total}, active=${active}, new=${newThisMonth}`);

    return this.finalizeMetricSection('users', {
      total,
      active,
      inactive,
      newThisMonth,
      activeLastDay,
      activeLastWeek,
      activeLastMonth,
      growthRate: null,
      avgUsersPerTenant,
      byRole: {
        admin: adminCount,
        manager: managerCount,
        operator: operatorCount,
      },
    });
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

    // Single aggregation query — no row fetch into Node.js memory. Query
    // rejection propagates; an unavailable source is never projected as a
    // successfully measured all-zero heatmap.
    const rows: Array<{ dow: string; hour: string; cnt: string }> = await this.dataSource.query(`
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
      const dayIndex = parseDbInt(row.dow, 'users.heatmap.day');
      const hour = parseDbInt(row.hour, 'users.heatmap.hour');
      const count = parseDbInt(row.cnt, 'users.heatmap.count');
      const dayData = heatmapData[dayIndex];
      if (dayData && dayData[hour] !== undefined) {
        dayData[hour] = count;
      }
    }

    this.logger.debug(`Heatmap built from ${rows.length} aggregate buckets`);

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
    const totalRevenue = parseDbNumber(ir?.total_revenue, 'financial.totalRevenue');
    const revenueThisMonth = parseDbNumber(ir?.revenue_this_month, 'financial.revenueThisMonth');
    const pendingPayments = parseDbNumber(ir?.pending_payments, 'financial.pendingPayments');
    const overduePayments = parseDbNumber(ir?.overdue_payments, 'financial.overduePayments');
    const refunds = parseDbNumber(ir?.refunds, 'financial.refunds');

    // Calculate revenue-per-paying-tenant from the authoritative subscription set.
    const payingTenants = activeSubscriptions.filter(
      (s) => s.status === SubscriptionStatus.ACTIVE,
    ).length;
    const arpu = payingTenants > 0 ? Number((mrr / payingTenants).toFixed(2)) : 0;
    const arppu = arpu; // Same since we're counting paying tenants

    this.logger.debug(
      `Financial metrics: MRR=${mrr}, totalRevenue=${totalRevenue}, payingTenants=${payingTenants}`,
    );

    return this.finalizeMetricSection('financial', {
      mrr: Number(mrr.toFixed(2)),
      arr: Number((mrr * 12).toFixed(2)),
      arpu,
      arppu,
      ltv: null,
      totalRevenue: Number(totalRevenue.toFixed(2)),
      revenueThisMonth: Number(revenueThisMonth.toFixed(2)),
      revenueGrowthRate: null,
      pendingPayments: Number(pendingPayments.toFixed(2)),
      overduePayments: Number(overduePayments.toFixed(2)),
      refunds: Number(refunds.toFixed(2)),
      byPlan: {
        starter: Number((revenueByPlan['starter'] ?? 0).toFixed(2)),
        professional: Number((revenueByPlan['professional'] ?? 0).toFixed(2)),
        enterprise: Number((revenueByPlan['enterprise'] ?? 0).toFixed(2)),
      },
      byCurrency: null,
    });
  }

  /**
   * Calculate monthly price from subscription based on billing cycle
   */
  private calculateMonthlyPrice(subscription: SubscriptionReadOnly): number {
    const basePrice = parseDbNumber(
      subscription.pricing?.basePrice,
      `financial.subscription.${subscription.id}.basePrice`,
    );

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
    const byPlan = this.requireMeasuredMetric(metrics.byPlan, 'financial.byPlan');

    return {
      labels: ['Starter', 'Professional', 'Enterprise'],
      datasets: [
        {
          label: 'Revenue by Plan',
          data: [
            this.requireMeasuredMetric(byPlan['starter'] ?? null, 'financial.byPlan.starter'),
            this.requireMeasuredMetric(
              byPlan['professional'] ?? null,
              'financial.byPlan.professional',
            ),
            this.requireMeasuredMetric(byPlan['enterprise'] ?? null, 'financial.byPlan.enterprise'),
          ],
          backgroundColor: ['#3B82F6', '#10B981', '#8B5CF6'],
        },
      ],
    };
  }

  // ============================================================================
  // System Metrics - REAL DATA
  // ============================================================================

  /**
   * Calculate system metrics
   * Note: Some metrics require infrastructure monitoring integration
   */
  async getSystemMetrics(): Promise<SystemMetrics> {
    this.logger.debug('Calculating system metrics...');

    const rows = await this.dataSource.query<SystemAggregateRow[]>(`
      SELECT
        pg_database_size(current_database()) AS used_storage_bytes,
        (
          SELECT COUNT(*)
          FROM pg_stat_activity
          WHERE datname = current_database()
        ) AS active_connections
    `);
    const usedStorageBytes = parseDbInt(rows[0]?.used_storage_bytes, 'system.usedStorageBytes');
    const activeConnections = parseDbInt(rows[0]?.active_connections, 'system.activeConnections');

    return this.finalizeMetricSection('system', {
      totalStorageBytes: null,
      usedStorageBytes,
      storageUtilization: null,
      apiCallsToday: null,
      apiCallsThisMonth: null,
      avgResponseTimeMs: null,
      errorRate: null,
      uptimePercent: null,
      activeConnections,
      queuedJobs: null,
    });
  }

  /**
   * Get API calls trend
   */
  async getApiCallsTrend(_params: TrendDataDto): Promise<TimeSeriesData> {
    throw new ServiceUnavailableException(
      'API call trend authority gateway-request-metrics-v1 is not integrated',
    );
  }

  /**
   * Get error rate trend
   */
  async getErrorRateTrend(_params: TrendDataDto): Promise<TimeSeriesData> {
    throw new ServiceUnavailableException(
      'Error-rate trend authority gateway-request-metrics-v1 is not integrated',
    );
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

    const rows = await this.dataSource.query<CountRow[]>(`
      SELECT COUNT(*) AS cnt
      FROM auth.users
      WHERE "isActive" = true
        AND "lastLoginAt" >= NOW() - INTERVAL '24 hours'
    `);
    const activeLastDay = parseDbInt(rows[0]?.cnt, 'usage.avgDailyActiveUsers');

    return this.finalizeMetricSection('usage', {
      moduleUsage: null,
      featureAdoption: null,
      topFeatures: null,
      peakHours: null,
      avgDailyActiveUsers: activeLastDay,
    });
  }

  /**
   * Get module usage chart data
   */
  async getModuleUsageChart(): Promise<ChartData> {
    throw new ServiceUnavailableException(
      'Module-usage authority qualified-audit-usage-projection-v1 is not integrated',
    );
  }

  /**
   * Get feature adoption chart data
   */
  async getFeatureAdoptionChart(): Promise<ChartData> {
    throw new ServiceUnavailableException(
      'Feature-adoption authority qualified-audit-usage-projection-v1 is not integrated',
    );
  }

  // ============================================================================
  // Comparisons
  // ============================================================================

  /**
   * Calculate metric comparison between two periods
   */
  calculateComparison(current: number, previous: number): ComparisonDto {
    const change = current - previous;
    if (previous === 0) {
      return {
        current,
        previous,
        change,
        changePercent: null,
        trend: 'unavailable',
      };
    }
    const changePercent = Number(((change / previous) * 100).toFixed(2));

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
    const comparisons: Record<string, ComparisonDto> = {};

    const addComparison = (key: string, current: number | null, previous: number | null): void => {
      if (current !== null && previous !== null) {
        comparisons[key] = this.calculateComparison(current, previous);
      }
    };

    if (this.hasCurrentMetricCatalog(prevTenant)) {
      addComparison('totalTenants', tenantMetrics.total, prevTenant?.total ?? null);
      addComparison('activeTenants', tenantMetrics.active, prevTenant?.active ?? null);
    }
    if (this.hasCurrentMetricCatalog(prevUser)) {
      addComparison('totalUsers', userMetrics.total, prevUser?.total ?? null);
      addComparison('activeUsers', userMetrics.active, prevUser?.active ?? null);
    }
    if (this.hasCurrentMetricCatalog(prevFinancial)) {
      addComparison('mrr', financialMetrics.mrr, prevFinancial?.mrr ?? null);
      addComparison('arr', financialMetrics.arr, prevFinancial?.arr ?? null);
      addComparison('arpu', financialMetrics.arpu, prevFinancial?.arpu ?? null);
    }

    return comparisons;
  }

  /**
   * Get snapshots closest to a specific date
   */
  private async getSnapshotsNear(
    targetDate: Date,
  ): Promise<Record<string, AnalyticsSnapshot | null>> {
    const categories: MetricCategory[] = ['tenant', 'user', 'financial', 'system', 'usage'];

    // HIGH-001 fix: parallelise snapshot lookups instead of sequential for-loop
    const snapshots = await Promise.all(
      categories.map((category) =>
        this.snapshotRepository.findOne({
          where: {
            category,
            snapshotDate: LessThanOrEqual(targetDate),
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
    const section = METRIC_SECTION_BY_CATEGORY[category];
    if (
      !analyticsMetricSectionProjectionHasValidEvidenceV1(
        section,
        metrics as unknown as Readonly<Record<string, unknown>>,
      )
    ) {
      throw new ServiceUnavailableException(
        `Analytics ${category} snapshot rejected: metric evidence does not match the active catalog`,
      );
    }
    const metricsSha256 = canonicalWireJsonSha256V1(
      ANALYTICS_SNAPSHOT_METRIC_HASH_AUTHORITY_V1,
      metrics as unknown as CanonicalJsonValue,
    );
    const snapshotDateKey = snapshotDate.toISOString().slice(0, 10);
    const existing = await this.snapshotRepository
      .createQueryBuilder('snapshot')
      .where('snapshot.snapshotType = :snapshotType', { snapshotType })
      .andWhere('snapshot.category = :category', { category })
      .andWhere('snapshot.snapshotDate = :snapshotDate', { snapshotDate: snapshotDateKey })
      .getOne();

    if (existing) {
      const existingSha256 = canonicalWireJsonSha256V1(
        ANALYTICS_SNAPSHOT_METRIC_HASH_AUTHORITY_V1,
        existing.metrics as unknown as CanonicalJsonValue,
      );
      if (existingSha256 !== metricsSha256) {
        throw new ConflictException(
          `Analytics ${category} ${snapshotType} snapshot for ${snapshotDateKey} is immutable`,
        );
      }
      return existing;
    }

    const snapshot = this.snapshotRepository.create({
      snapshotType,
      category,
      snapshotDate: new Date(`${snapshotDateKey}T00:00:00.000Z`),
      metrics,
      metadata: {
        schemaVersion: 'analytics-snapshot-metadata.v1',
        metricsSha256,
      },
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
    const query = this.snapshotRepository
      .createQueryBuilder('snapshot')
      .where('snapshot.category = :category', { category })
      .andWhere('snapshot.snapshotDate >= :startDate', { startDate: range.startDate })
      .andWhere('snapshot.snapshotDate <= :endDate', { endDate: range.endDate })
      .andWhere(`snapshot.metrics #>> '{authority,metricCatalogSha256}' = :metricCatalogSha256`, {
        metricCatalogSha256: ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256,
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
      load: () => Promise<
        TenantMetrics | UserMetrics | FinancialMetrics | SystemMetrics | UsageMetrics
      >;
    }> = [
      { category: 'tenant', load: () => this.getTenantMetrics() },
      { category: 'user', load: () => this.getUserMetrics() },
      { category: 'financial', load: () => this.getFinancialMetrics() },
      { category: 'system', load: () => this.getSystemMetrics() },
      { category: 'usage', load: () => this.getUsageMetrics() },
    ];

    const results = await Promise.allSettled(
      tasks.map(async (task) => {
        const metrics = await task.load();
        return this.saveSnapshot('daily', task.category, metrics, snapshotDate);
      }),
    );

    const failures = results
      .map((result, index) => ({ result, category: tasks[index]?.category }))
      .filter(
        (entry): entry is { result: PromiseRejectedResult; category: MetricCategory } =>
          entry.result.status === 'rejected' && !!entry.category,
      );

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
        startDate.setDate(startDate.getDate() - params.dataPoints * 7);
        break;
      case 'month':
        startDate.setMonth(startDate.getMonth() - params.dataPoints);
        break;
      case 'year':
        startDate.setFullYear(startDate.getFullYear() - params.dataPoints);
        break;
    }

    const snapshots = await this.getSnapshots(category, { startDate, endDate: now }, 'daily');

    return snapshots.flatMap((snapshot) => {
      const value = this.getMetricValue(snapshot.metrics, metricKey);
      return value === null
        ? []
        : [
            {
              date:
                snapshot.snapshotDate.toISOString().split('T')[0] ||
                snapshot.snapshotDate.toISOString(),
              value,
            },
          ];
    });
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
   * Extracts a fulfilled projection or compiles an explicit unavailable
   * projection. When a source rejects, its name is appended to the unavailable
   * list and the error is logged — but healthy authorities remain visible.
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
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    this.logger.error(`${sourceName} metrics failed: ${reason}`);
    unavailable.push(sourceName);
    return getDefault();
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
    const byPlan = this.requireMeasuredMetric(financialMetrics.byPlan, 'financial.byPlan');
    const mrr = this.requireMeasuredMetric(financialMetrics.mrr, 'financial.mrr');
    const arr = this.requireMeasuredMetric(financialMetrics.arr, 'financial.arr');
    const totalRevenue = this.requireMeasuredMetric(
      financialMetrics.totalRevenue,
      'financial.totalRevenue',
    );
    const starterRevenue = this.requireMeasuredMetric(
      byPlan['starter'] ?? null,
      'financial.byPlan.starter',
    );
    const professionalRevenue = this.requireMeasuredMetric(
      byPlan['professional'] ?? null,
      'financial.byPlan.professional',
    );
    const enterpriseRevenue = this.requireMeasuredMetric(
      byPlan['enterprise'] ?? null,
      'financial.byPlan.enterprise',
    );
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
        percentage:
          totalByPlan > 0 ? Number(((professionalRevenue / totalByPlan) * 100).toFixed(1)) : 0,
      },
      {
        plan: 'Enterprise',
        revenue: enterpriseRevenue,
        percentage:
          totalByPlan > 0 ? Number(((enterpriseRevenue / totalByPlan) * 100).toFixed(1)) : 0,
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

    const revenueByMonth = monthlyRows.map((r) => ({
      month: new Date(r.month).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      revenue: Number(parseDbNumber(r.avg_mrr, 'financial.revenueByMonth.mrr').toFixed(2)),
    }));

    // BUG-010 fix: exclude trial tenants from ARPT denominator (they don't pay)
    // MEDIUM-004 companion: use a targeted COUNT query instead of loading all active tenants
    const payingCountRows = await this.dataSource.query<CountRow[]>(`
      SELECT COUNT(*) AS cnt
      FROM auth.tenants
      WHERE status = 'ACTIVE' AND LOWER(plan) <> 'trial'
    `);
    const payingTenantCount = parseDbInt(payingCountRows[0]?.cnt, 'financial.payingTenantCount');
    const averageRevenuePerTenant =
      payingTenantCount > 0 ? Number((mrr / payingTenantCount).toFixed(2)) : 0;

    return {
      totalRevenue,
      mrr,
      arr,
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
  async getRevenueByPlanAnalytics(): Promise<
    Array<{
      plan: string;
      revenue: number;
      tenantCount: number;
      percentage: number;
      avgRevenuePerTenant: number;
    }>
  > {
    const financialMetrics = await this.getFinancialMetrics();
    const byPlan = this.requireMeasuredMetric(financialMetrics.byPlan, 'financial.byPlan');

    // Single aggregation query for plan counts — no full table scan
    const planCountRows: Array<{ plan: string; cnt: string }> = await this.dataSource.query(`
      SELECT LOWER(plan) AS plan, COUNT(*) AS cnt
      FROM auth.tenants
      GROUP BY LOWER(plan)
    `);
    const planCountMap = new Map(planCountRows.map((r) => [r.plan, parseInt(r.cnt, 10)]));
    const starterCount = planCountMap.get('starter') || 0;
    const professionalCount = planCountMap.get('professional') || 0;
    const enterpriseCount = planCountMap.get('enterprise') || 0;

    const starterRev = this.requireMeasuredMetric(
      byPlan['starter'] ?? null,
      'financial.byPlan.starter',
    );
    const professionalRev = this.requireMeasuredMetric(
      byPlan['professional'] ?? null,
      'financial.byPlan.professional',
    );
    const enterpriseRev = this.requireMeasuredMetric(
      byPlan['enterprise'] ?? null,
      'financial.byPlan.enterprise',
    );
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
        percentage:
          totalRevenue > 0 ? Number(((professionalRev / totalRevenue) * 100).toFixed(1)) : 0,
        avgRevenuePerTenant:
          professionalCount > 0 ? Number((professionalRev / professionalCount).toFixed(2)) : 0,
      },
      {
        plan: 'Enterprise',
        revenue: enterpriseRev,
        tenantCount: enterpriseCount,
        percentage:
          totalRevenue > 0 ? Number(((enterpriseRev / totalRevenue) * 100).toFixed(1)) : 0,
        avgRevenuePerTenant:
          enterpriseCount > 0 ? Number((enterpriseRev / enterpriseCount).toFixed(2)) : 0,
      },
    ];
  }

  /**
   * Get revenue trend analytics
   */
  async getRevenueTrendAnalytics(period: string): Promise<{
    period: string;
    data: Array<{ date: string; revenue: number; growth: number | null }>;
    summary: {
      totalRevenue: number | null;
      averageRevenue: number | null;
      growthRate: number | null;
      highestMonth: { date: string; revenue: number } | null;
      lowestMonth: { date: string; revenue: number } | null;
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
      const monthKey = `${snapshot.snapshotDate.getFullYear()}-${String(snapshot.snapshotDate.getMonth() + 1).padStart(2, '0')}`;
      const mrr = this.getMetricValue(snapshot.metrics, 'mrr');
      if (mrr === null) continue;

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
    const data: Array<{ date: string; revenue: number; growth: number | null }> = [];
    let previousRevenue: number | null = null;
    let totalRevenue = 0;

    const sortedMonths = Array.from(monthlyData.keys()).sort();
    for (const monthKey of sortedMonths) {
      // SECURITY FIX: Safe access with fallback to prevent division by zero
      const values = monthlyData.get(monthKey) || [];
      if (values.length === 0) continue; // Skip months with no data to avoid NaN
      const avgRevenue = values.reduce((a, b) => a + b, 0) / values.length;
      const growth =
        previousRevenue !== null && previousRevenue > 0
          ? Number((((avgRevenue - previousRevenue) / previousRevenue) * 100).toFixed(2))
          : null;

      data.push({
        date: monthKey,
        revenue: Number(avgRevenue.toFixed(2)),
        growth,
      });

      totalRevenue += avgRevenue;
      previousRevenue = avgRevenue;
    }

    // Calculate summary
    const revenues = data.map((d) => d.revenue);
    const maxRevenue = revenues.length > 0 ? Math.max(...revenues) : null;
    const minRevenue = revenues.length > 0 ? Math.min(...revenues) : null;
    const highestMonth =
      maxRevenue === null ? null : (data.find((d) => d.revenue === maxRevenue) ?? null);
    const lowestMonth =
      minRevenue === null ? null : (data.find((d) => d.revenue === minRevenue) ?? null);

    const firstRevenue = data[0]?.revenue ?? null;
    const lastRevenue = data[data.length - 1]?.revenue ?? null;
    const overallGrowthRate =
      firstRevenue !== null && firstRevenue > 0 && lastRevenue !== null
        ? Number((((lastRevenue - firstRevenue) / firstRevenue) * 100).toFixed(2))
        : null;

    return {
      period,
      data,
      summary: {
        totalRevenue: data.length > 0 ? Number(totalRevenue.toFixed(2)) : null,
        averageRevenue: data.length > 0 ? Number((totalRevenue / data.length).toFixed(2)) : null,
        growthRate: overallGrowthRate,
        highestMonth:
          highestMonth === null ? null : { date: highestMonth.date, revenue: highestMonth.revenue },
        lowestMonth:
          lowestMonth === null ? null : { date: lowestMonth.date, revenue: lowestMonth.revenue },
      },
    };
  }
}
