/**
 * Reports Service
 *
 * Rapor oluşturma ve export işlemleri.
 * Tenant, Financial, Usage ve System raporları üretir.
 *
 * OPTIMIZED: Redis caching with 4 hour TTL for expensive report calculations.
 */

import * as crypto from 'crypto';

import { IsoDateString, toIsoDateString } from '@aquaculture/backend-common/database';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  BadRequestException,
  GoneException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { MinioClientService } from '@platform/storage';
import PDFDocument from 'pdfkit';
import { DataSource, Repository } from 'typeorm';

import { AuditLogService } from '../../audit/audit.service';
import {
  AnalyticsSnapshot,
  ReportType,
  ReportFormat,
  ReportRequest,
  ReportResult,
  ReportDefinition,
  ReportExecution,
  ReportDefinitionStatus,
  ReportSchedule,
  ReportExecutionStatus,
  SystemMetrics,
} from '../entities/analytics-snapshot.entity';
import { TenantReadOnly, TenantStatus, TenantPlan } from '../entities/external/tenant.entity';
import { UserReadOnly } from '../entities/external/user.entity';

import { AnalyticsService } from './analytics.service';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

// ============================================================================
// Report Data Types
// ============================================================================

interface TenantReportRow {
  id: string;
  name: string;
  plan: string;
  status: string;
  users: number;
  createdAt: string;
  mrr: number;
  storageUsed: string;
  lastActivity: string;
}

interface ChurnReportRow {
  tenantId: string;
  tenantName: string;
  plan: string;
  cancelDate: string;
  reason: string;
  mrr: number;
  lifetimeValue: number;
  usageDays: number;
}

interface RevenueReportRow {
  date: string;
  revenue: number;
  newSubscriptions: number;
  renewals: number;
  upgrades: number;
  downgrades: number;
  refunds: number;
  netRevenue: number;
}

interface PaymentReportRow {
  invoiceId: string;
  tenantName: string;
  amount: number;
  currency: string;
  dueDate: string;
  status: string;
  daysPastDue: number;
}

interface ModuleUsageReportRow {
  module: string;
  activeUsers: number;
  totalSessions: number;
  avgSessionDuration: number;
  adoptionRate: number;
  trend: string;
}

interface FeatureUsageReportRow {
  feature: string;
  adoptionRate: number;
  activeUsers: number;
  avgUsagePerUser: number;
  trend: string;
}

/**
 * A per-day system-performance row. Every metric is `number | null` because
 * "not measured" must be representable: the platform has no APM/uptime feed for
 * most days, and inventing a constant there is what made this report lie
 * (APA-143). `null` renders as an empty/n-a cell, never as a plausible number.
 */
interface PerformanceReportRow {
  date: string;
  avgResponseTime: number | null;
  errorRate: number | null;
  uptime: number | null;
  apiCalls: number | null;
  activeConnections: number | null;
}

/** Mean of the measured values only; null when nothing was measured. */
function avgOrNull(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return present.length === 0 ? null : present.reduce((s, v) => s + v, 0) / present.length;
}

/** Sum of the measured values only; null when nothing was measured. */
function sumOrNull(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return present.length === 0 ? null : present.reduce((s, v) => s + v, 0);
}

/** Round to 2dp, preserving the unmeasured (null) case. */
function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private static readonly CACHE_TTL = 14400; // 4 hours

  constructor(
    @InjectRepository(AnalyticsSnapshot)
    private readonly snapshotRepository: Repository<AnalyticsSnapshot>,
    @InjectRepository(TenantReadOnly)
    private readonly tenantRepository: Repository<TenantReadOnly>,
    @InjectRepository(UserReadOnly)
    private readonly userRepository: Repository<UserReadOnly>,
    @InjectRepository(ReportDefinition)
    private readonly definitionRepository: Repository<ReportDefinition>,
    @InjectRepository(ReportExecution)
    private readonly executionRepository: Repository<ReportExecution>,
    private readonly analyticsService: AnalyticsService,
    private readonly auditLogService: AuditLogService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional()
    private readonly redisService?: RedisService,
    @Optional()
    private readonly storageService?: MinioClientService,
  ) {}

  /**
   * Get cached report data or compute it
   */
  private async getCachedOrCompute<T>(
    cacheKey: string,
    compute: () => Promise<T>,
  ): Promise<T> {
    if (this.redisService) {
      try {
        const cached = await this.redisService.getJson<T>(cacheKey);
        if (cached) {
          this.logger.debug(`Cache HIT: ${cacheKey}`);
          return cached;
        }
      } catch {
        // Cache miss or error
      }
    }

    const result = await compute();

    if (this.redisService) {
      // ERROR HANDLING FIX: Log cache write errors instead of silently ignoring
      this.redisService.setJson(cacheKey, result, ReportsService.CACHE_TTL).catch((error) => {
        this.logger.warn(`Failed to write cache for key ${cacheKey}: ${(error as Error).message}`);
      });
    }

    return result;
  }

  // ============================================================================
  // Report Generation
  // ============================================================================

  /**
   * Generate a report
   */
  async generateReport(request: ReportRequest): Promise<ReportResult> {
    this.logger.log(`Generating ${request.type} report in ${request.format} format`);

    let data: unknown;
    let title: string;
    let summary: Record<string, unknown> = {};

    // OPTIMIZED: Cache expensive report computations
    // BUG-002/BUG-019 fix: include filters in cache key to prevent stale cached results
    // being returned for requests with different filter criteria
    const filtersKey = request.filters
      ? JSON.stringify(Object.fromEntries(Object.entries(request.filters).sort()))
      : 'none';
    const cacheKey = `report:${request.type}:${request.startDate?.toISOString() || 'all'}:${request.endDate?.toISOString() || 'all'}:${filtersKey}`;

    switch (request.type) {
      case 'tenant_overview': {
        const tenantResult = await this.getCachedOrCompute(
          cacheKey,
          () => this.generateTenantOverviewReport(request),
        );
        data = tenantResult.data;
        title = 'Tenant Overview Report';
        summary = tenantResult.summary;
        break;
      }

      case 'tenant_churn': {
        const churnResult = await this.getCachedOrCompute(
          cacheKey,
          () => this.generateChurnReport(request),
        );
        data = churnResult.data;
        title = 'Churn Analysis Report';
        summary = churnResult.summary;
        break;
      }

      case 'financial_revenue': {
        const revenueResult = await this.getCachedOrCompute(
          cacheKey,
          () => this.generateRevenueReport(request),
        );
        data = revenueResult.data;
        title = 'Revenue Report';
        summary = revenueResult.summary;
        break;
      }

      case 'financial_payments': {
        const paymentsResult = await this.generatePaymentsReport(request);
        data = paymentsResult.data;
        title = 'Payments Report';
        summary = paymentsResult.summary;
        break;
      }

      case 'usage_modules': {
        const modulesResult = await this.generateModuleUsageReport(request);
        data = modulesResult.data;
        title = 'Module Usage Report';
        summary = modulesResult.summary;
        break;
      }

      case 'usage_features': {
        const featuresResult = await this.generateFeatureUsageReport(request);
        data = featuresResult.data;
        title = 'Feature Usage Report';
        summary = featuresResult.summary;
        break;
      }

      case 'system_performance': {
        const perfResult = await this.getCachedOrCompute(
          cacheKey,
          () => this.generatePerformanceReport(request),
        );
        data = perfResult.data;
        title = 'System Performance Report';
        summary = perfResult.summary;
        break;
      }

      default:
        throw new BadRequestException('Unknown report type');
    }

    // Format data based on requested format
    const formattedData = this.formatReportData(data, request.format);

    const result: ReportResult = {
      // BUG-028 fix: use crypto.randomBytes for an unguessable ID; replace deprecated substr()
      id: `rpt_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
      type: request.type,
      format: request.format,
      title,
      generatedAt: new Date(),
      data: formattedData,
      summary,
    };

    // For file formats, generate download URL
    if (['csv', 'pdf'].includes(request.format)) {
      result.downloadUrl = `/api/reports/download/${result.id}`;
    }

    return result;
  }

  // ============================================================================
  // Tenant Reports
  // ============================================================================

  private async generateTenantOverviewReport(_request: ReportRequest): Promise<{
    data: TenantReportRow[];
    summary: Record<string, unknown>;
  }> {
    // Fetch real tenants from database
    const tenants = await this.tenantRepository.find({
      order: { createdAt: 'DESC' },
    });

    // Get user counts per tenant
    const userCounts = await this.userRepository
      .createQueryBuilder('user')
      .select('user.tenantId', 'tenantId')
      .addSelect('COUNT(*)', 'count')
      .where('user.tenantId IS NOT NULL')
      .groupBy('user.tenantId')
      .getRawMany<{ tenantId: string; count: string }>();

    const userCountMap = new Map(userCounts.map(u => [u.tenantId, parseInt(u.count, 10)]));

    // HIGH-002 fix: replaced N+1 per-tenant getStatistics() calls with a single
    // GROUP BY aggregation over all tenants at once.
    const storageMap = new Map<string, string>();
    try {
      const auditCountRows: Array<{ tenantId: string; cnt: string }> =
        await this.dataSource.query(
          // Schema-qualified after P9 (2026-04-14): audit_logs in shared schema.
          // The earlier batch of unqualified→qualified rewrites missed this site
          // because grep pattern matched only `FROM audit_logs<space>` and this
          // form had a multi-space alignment. Closes NEW-CRITICAL-B from the
          // round-2 review.
          `SELECT "tenantId", COUNT(*) AS cnt
           FROM   shared.audit_logs
           WHERE  "tenantId" IS NOT NULL
           GROUP  BY "tenantId"`,
        );
      for (const row of auditCountRows) {
        const userCount = userCountMap.get(row.tenantId) || 0;
        const totalLogs = parseInt(row.cnt, 10);
        const estimatedBytes = (totalLogs * 2048) + (userCount * 1024);
        storageMap.set(row.tenantId, this.formatBytes(estimatedBytes));
      }
    } catch {
      // Non-critical — storage column will show '0 KB'
    }

    // MRR pricing by plan
    const planPricing: Record<string, number> = {
      [TenantPlan.TRIAL]: 0,
      [TenantPlan.STARTER]: 99,
      [TenantPlan.PROFESSIONAL]: 299,
      [TenantPlan.ENTERPRISE]: 499,
    };

    // Transform to report format
    const data: TenantReportRow[] = tenants.map(tenant => ({
      id: tenant.id,
      name: tenant.name,
      plan: tenant.plan,
      status: tenant.status === TenantStatus.ACTIVE ? 'Active' :
              tenant.status === TenantStatus.PENDING ? 'Trial' : tenant.status,
      users: userCountMap.get(tenant.id) || 0,
      createdAt: tenant.createdAt?.toISOString().substring(0, 10) ?? '',
      mrr: tenant.status === TenantStatus.ACTIVE ? planPricing[tenant.plan] || 0 : 0,
      storageUsed: storageMap.get(tenant.id) || '0 KB',
      lastActivity: tenant.updatedAt?.toISOString().substring(0, 10) ?? '',
    }));

    // Calculate summary
    const totalMRR = data.reduce((sum, t) => sum + t.mrr, 0);
    const totalUsers = data.reduce((sum, t) => sum + t.users, 0);
    const planDistribution = tenants.reduce((acc, t) => {
      acc[t.plan] = (acc[t.plan] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      data,
      summary: {
        totalTenants: tenants.length,
        activeTenants: tenants.filter(t => t.status === TenantStatus.ACTIVE).length,
        trialTenants: tenants.filter(t => t.plan === TenantPlan.TRIAL || t.status === TenantStatus.PENDING).length,
        totalMRR,
        avgUsersPerTenant: tenants.length > 0 ? Math.round(totalUsers / tenants.length) : 0,
        planDistribution,
      },
    };
  }

  private async generateChurnReport(_request: ReportRequest): Promise<{
    data: ChurnReportRow[];
    summary: Record<string, unknown>;
  }> {
    // Fetch cancelled/suspended tenants from database
    const cancelledTenants = await this.tenantRepository.find({
      where: [
        { status: TenantStatus.CANCELLED },
        { status: TenantStatus.SUSPENDED },
      ],
      order: { updatedAt: 'DESC' },
    });

    // MRR pricing by plan
    const planPricing: Record<string, number> = {
      [TenantPlan.TRIAL]: 0,
      [TenantPlan.STARTER]: 99,
      [TenantPlan.PROFESSIONAL]: 299,
      [TenantPlan.ENTERPRISE]: 499,
    };

    // Transform to report format
    const data: ChurnReportRow[] = cancelledTenants.map(tenant => {
      const createdDate = tenant.createdAt ? new Date(tenant.createdAt) : new Date();
      const cancelDate = tenant.updatedAt ? new Date(tenant.updatedAt) : new Date();
      const usageDays = Math.floor((cancelDate.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
      const monthlyPrice = planPricing[tenant.plan] || 0;
      const lifetimeMonths = Math.max(1, Math.ceil(usageDays / 30));

      return {
        tenantId: tenant.id,
        tenantName: tenant.name,
        plan: tenant.plan,
        cancelDate: cancelDate.toISOString().substring(0, 10),
        reason: 'Unknown', // Would need a separate field to track cancellation reasons
        mrr: monthlyPrice,
        lifetimeValue: monthlyPrice * lifetimeMonths,
        usageDays,
      };
    });

    const metrics = await this.analyticsService.getTenantMetrics();

    // Count reasons (would need real data)
    const reasonCounts: Record<string, number> = {};
    data.forEach(d => {
      reasonCounts[d.reason] = (reasonCounts[d.reason] || 0) + 1;
    });

    return {
      data,
      summary: {
        totalChurned: data.length,
        churnRate: metrics.churnRate,
        lostMRR: data.reduce((sum, t) => sum + t.mrr, 0),
        avgLifetimeValue: data.length > 0 ? Math.round(data.reduce((sum, t) => sum + t.lifetimeValue, 0) / data.length) : 0,
        topReasons: reasonCounts,
      },
    };
  }

  // ============================================================================
  // Financial Reports
  // ============================================================================

  private async generateRevenueReport(request: ReportRequest): Promise<{
    data: RevenueReportRow[];
    summary: Record<string, unknown>;
  }> {
    const startDate = request.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = request.endDate || new Date();

    const planPricing: Record<string, number> = {
      [TenantPlan.TRIAL]: 0,
      [TenantPlan.STARTER]: 99,
      [TenantPlan.PROFESSIONAL]: 299,
      [TenantPlan.ENTERPRISE]: 499,
    };

    // Fetch all tenants with their creation dates and plans
    const tenants = await this.tenantRepository.find();

    // Build daily revenue data for the requested date range
    const data: RevenueReportRow[] = [];
    const current = new Date(startDate);
    current.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    while (current <= end) {
      const dateStr = current.toISOString().substring(0, 10);
      const currentTime = current.getTime();

      // Count active tenants at this date and calculate daily revenue
      let dailyRevenue = 0;
      let newSubscriptions = 0;

      for (const tenant of tenants) {
        const createdAt = tenant.createdAt ? new Date(tenant.createdAt) : null;
        if (!createdAt || createdAt.getTime() > currentTime) continue;

        // Only count active or pending tenants that existed by this date
        if (tenant.status === TenantStatus.ACTIVE || tenant.status === TenantStatus.PENDING) {
          const monthlyPrice = planPricing[tenant.plan] || 0;
          // Prorate monthly price to a daily amount
          dailyRevenue += monthlyPrice / 30;

          // Check if tenant was created on this exact day
          const createdDateStr = createdAt.toISOString().substring(0, 10);
          if (createdDateStr === dateStr) {
            newSubscriptions++;
          }
        }
      }

      dailyRevenue = Math.round(dailyRevenue * 100) / 100;

      data.push({
        date: dateStr,
        revenue: dailyRevenue,
        newSubscriptions,
        renewals: 0, // Requires subscription renewal tracking
        upgrades: 0, // Requires plan change history table
        downgrades: 0, // Requires plan change history table
        refunds: 0, // Requires refund tracking
        netRevenue: dailyRevenue,
      });

      current.setDate(current.getDate() + 1);
    }

    // Calculate summary totals
    const totalRevenue = data.reduce((sum, d) => sum + d.revenue, 0);
    const totalNewSubscriptions = data.reduce((sum, d) => sum + d.newSubscriptions, 0);
    const totalNetRevenue = data.reduce((sum, d) => sum + d.netRevenue, 0);
    const activePaidTenants = tenants.filter(
      t => t.status === TenantStatus.ACTIVE && t.plan !== TenantPlan.TRIAL,
    ).length;

    return {
      data,
      summary: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalNewSubscriptions,
        totalRenewals: 0,
        totalUpgrades: 0,
        totalDowngrades: 0,
        totalRefunds: 0,
        totalNetRevenue: Math.round(totalNetRevenue * 100) / 100,
        activePaidTenants,
        avgDailyRevenue: data.length > 0 ? Math.round((totalRevenue / data.length) * 100) / 100 : 0,
      },
    };
  }

  private async generatePaymentsReport(_request: ReportRequest): Promise<{
    data: PaymentReportRow[];
    summary: Record<string, unknown>;
  }> {
    const planPricing: Record<string, number> = {
      [TenantPlan.TRIAL]: 0,
      [TenantPlan.STARTER]: 99,
      [TenantPlan.PROFESSIONAL]: 299,
      [TenantPlan.ENTERPRISE]: 499,
    };

    // Fetch active tenants to generate synthetic invoice records
    const tenants = await this.tenantRepository.find({
      where: { status: TenantStatus.ACTIVE },
      order: { name: 'ASC' },
    });

    const now = new Date();
    const data: PaymentReportRow[] = [];
    let totalPaid = 0;
    let totalPending = 0;
    let totalOverdue = 0;
    let paidCount = 0;
    let pendingCount = 0;
    let overdueCount = 0;

    for (const tenant of tenants) {
      const amount = planPricing[tenant.plan] || 0;

      // Generate a deterministic invoice ID from tenant id and current month
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const invoiceId = `INV-${monthKey}-${tenant.id.substring(0, 8).toUpperCase()}`;

      // Due date is the 1st of the current month
      const dueDate = new Date(now.getFullYear(), now.getMonth(), 1);
      const dueDateStr = dueDate.toISOString().substring(0, 10);

      // Calculate days past due (if any)
      const daysPastDue = Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)));

      // Trial tenants always have paid $0 invoices; active paid tenants are considered paid
      const status = amount === 0 ? 'paid' : 'paid';

      data.push({
        invoiceId,
        tenantName: tenant.name,
        amount,
        currency: 'USD',
        dueDate: dueDateStr,
        status,
        daysPastDue: status === 'paid' ? 0 : daysPastDue,
      });

      if (status === 'paid') {
        totalPaid += amount;
        paidCount++;
      } else if (status === 'pending') {
        totalPending += amount;
        pendingCount++;
      } else if (status === 'overdue') {
        totalOverdue += amount;
        overdueCount++;
      }
    }

    return {
      data,
      summary: {
        totalInvoices: data.length,
        totalPaid: Math.round(totalPaid * 100) / 100,
        totalPending: Math.round(totalPending * 100) / 100,
        totalOverdue: Math.round(totalOverdue * 100) / 100,
        paidCount,
        pendingCount,
        overdueCount,
        collectionRate: data.length > 0 ? Math.round((paidCount / data.length) * 100) : 0,
      },
    };
  }

  // ============================================================================
  // Usage Reports
  // ============================================================================

  private async generateModuleUsageReport(_request: ReportRequest): Promise<{
    data: ModuleUsageReportRow[];
    summary: Record<string, unknown>;
  }> {
    const usage = await this.analyticsService.getUsageMetrics();

    // C-3 fix: use actual user count instead of hardcoded 2456, remove Math.random() for trend
    const userMetrics = await this.analyticsService.getUserMetrics();
    const totalActiveUsers = userMetrics.active || 1; // avoid division by zero

    const data: ModuleUsageReportRow[] = Object.entries(usage.moduleUsage).map(([module, stats]) => ({
      module: this.formatModuleName(module),
      activeUsers: stats.activeUsers,
      totalSessions: stats.totalSessions,
      avgSessionDuration: stats.avgSessionDuration,
      adoptionRate: Math.round((stats.activeUsers / totalActiveUsers) * 100),
      trend: 'stable', // Trend calculation requires historical snapshot comparison
    }));

    return {
      data,
      summary: {
        totalModules: data.length,
        mostUsedModule: data.sort((a, b) => b.activeUsers - a.activeUsers)[0]?.module,
        avgAdoptionRate: Math.round(data.reduce((sum, m) => sum + m.adoptionRate, 0) / data.length),
        totalSessions: data.reduce((sum, m) => sum + m.totalSessions, 0),
      },
    };
  }

  private async generateFeatureUsageReport(_request: ReportRequest): Promise<{
    data: FeatureUsageReportRow[];
    summary: Record<string, unknown>;
  }> {
    const usage = await this.analyticsService.getUsageMetrics();

    // C-3 fix: use actual user count, remove Math.random()
    const featureUserMetrics = await this.analyticsService.getUserMetrics();
    const featureTotalActive = featureUserMetrics.active || 1;

    const data: FeatureUsageReportRow[] = Object.entries(usage.featureAdoption).map(([feature, rate]) => ({
      feature: this.formatFeatureName(feature),
      adoptionRate: rate,
      activeUsers: Math.round((rate / 100) * featureTotalActive),
      avgUsagePerUser: 0, // Requires real per-user usage tracking
      trend: 'stable', // Trend calculation requires historical snapshot comparison
    }));

    return {
      data,
      summary: {
        totalFeatures: data.length,
        avgAdoptionRate: Math.round(data.reduce((sum, f) => sum + f.adoptionRate, 0) / data.length),
        highAdoptionCount: data.filter(f => f.adoptionRate >= 60).length,
        lowAdoptionCount: data.filter(f => f.adoptionRate < 40).length,
      },
    };
  }

  // ============================================================================
  // Performance Report
  // ============================================================================

  private async generatePerformanceReport(request: ReportRequest): Promise<{
    data: PerformanceReportRow[];
    summary: Record<string, unknown>;
  }> {
    const startDate = request.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = request.endDate || new Date();

    const data: PerformanceReportRow[] = [];

    // Try to get data from analytics_snapshots (system category)
    let snapshotRows: Array<{ snapshotDate: string; metrics: SystemMetrics }> = [];
    try {
      snapshotRows = await this.dataSource.query(
        `SELECT "snapshotDate"::text, metrics
         FROM admin.analytics_snapshots
         WHERE category = 'system'
           AND "snapshotDate" >= $1
           AND "snapshotDate" <= $2
         ORDER BY "snapshotDate" ASC`,
        [toIsoDateString(startDate), toIsoDateString(endDate)],
      );
    } catch {
      // Table may not exist or have no data
    }

    if (snapshotRows.length > 0) {
      // Use real snapshot data grouped by date
      const groupedByDate = new Map<IsoDateString, SystemMetrics[]>();
      for (const row of snapshotRows) {
        // `"snapshotDate"::text` already yields a calendar date. Validate it at
        // this raw-SQL boundary rather than round-tripping through `Date`: the
        // Date branch was unreachable (the driver never returns one for `::text`)
        // and it silently re-introduced UTC shifting on a value that has no
        // timezone (APA-130).
        const dateStr = toIsoDateString(row.snapshotDate);
        const existing = groupedByDate.get(dateStr) || [];
        existing.push(row.metrics);
        groupedByDate.set(dateStr, existing);
      }

      for (const [dateStr, metricsArr] of groupedByDate) {
        // Null-preserving: a day whose snapshots carry no measured value stays
        // null. The previous `|| 99.9` coalescing silently turned "no uptime
        // recorded" into "99.9% uptime" (APA-143).
        data.push({
          date: dateStr,
          avgResponseTime: roundOrNull(avgOrNull(metricsArr.map((m) => m.avgResponseTimeMs))),
          errorRate: roundOrNull(avgOrNull(metricsArr.map((m) => m.errorRate))),
          uptime: roundOrNull(avgOrNull(metricsArr.map((m) => m.uptimePercent))),
          apiCalls: sumOrNull(metricsArr.map((m) => m.apiCallsToday)),
          activeConnections: roundOrNull(avgOrNull(metricsArr.map((m) => m.activeConnections))),
        });
      }
    } else {
      // No system snapshots for this range: emit an honest per-day row whose
      // metrics are all null (APA-143). Absence is represented structurally so
      // the reader can tell "we did not measure this" from a real measurement.
      //
      // Two former fabrications are deliberately gone, not replaced:
      //  - the 45ms / 0.1% / 99.9% "default estimates", which were invented
      //    numbers presented as measurements;
      //  - shared.audit_logs row counts proxied as `apiCalls`. Admin audit rows
      //    are not API calls; the proxy made an unrelated table's volume look
      //    like traffic. pg_stat_activity's *current* connection count was
      //    likewise stamped onto every historical day, which it never described.
      const current = new Date(startDate);
      current.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);

      while (current <= end) {
        data.push({
          date: current.toISOString().substring(0, 10),
          avgResponseTime: null,
          errorRate: null,
          uptime: null,
          apiCalls: null,
          activeConnections: null,
        });

        current.setDate(current.getDate() + 1);
      }
    }

    // Summary aggregates over MEASURED days only. Averaging nulls as zero would
    // reintroduce the same lie at the summary level (a month with no telemetry
    // would report a flattering 0ms/0% rather than "unmeasured"). `coverage`
    // makes the measured fraction explicit so a near-empty report cannot be
    // read as a healthy one.
    const totalDays = data.length;
    const daysWithData = data.filter(
      (d) => d.uptime !== null || d.avgResponseTime !== null || d.apiCalls !== null,
    ).length;

    return {
      data,
      summary: {
        avgResponseTime: roundOrNull(avgOrNull(data.map((d) => d.avgResponseTime))),
        avgErrorRate: roundOrNull(avgOrNull(data.map((d) => d.errorRate))),
        avgUptime: roundOrNull(avgOrNull(data.map((d) => d.uptime))),
        totalApiCalls: sumOrNull(data.map((d) => d.apiCalls)),
        avgDailyApiCalls: roundOrNull(avgOrNull(data.map((d) => d.apiCalls))),
        avgActiveConnections: roundOrNull(avgOrNull(data.map((d) => d.activeConnections))),
        totalDays,
        daysWithData,
        coverage: totalDays > 0 ? Math.round((daysWithData / totalDays) * 100) / 100 : 0,
      },
    };
  }

  // ============================================================================
  // Export Formatting
  // ============================================================================

  private formatReportData(data: unknown, format: ReportFormat): unknown {
    switch (format) {
      case 'json':
        return data;

      case 'csv':
        return this.convertToCsv(data as Record<string, unknown>[]);

      case 'pdf':
        return data;

      default:
        throw new BadRequestException(`Unsupported report format: ${String(format)}`);
    }
  }

  private convertToCsv(data: Record<string, unknown>[]): string {
    if (!data || data.length === 0) return '';

    const firstRow = data[0];
    if (!firstRow) return '';

    const headers = Object.keys(firstRow);
    const csvRows = [headers.map(header => this.escapeCsvValue(header)).join(',')];

    for (const row of data) {
      const values = headers.map(header => {
        const value = row[header];
        return this.escapeCsvValue(value);
      });
      csvRows.push(values.join(','));
    }

    return csvRows.join('\n');
  }

  private escapeCsvValue(value: unknown): string {
    let strValue = this.formatUnknownValue(value);

    if (/^[=+\-@\t\r]/.test(strValue)) {
      strValue = `'${strValue}`;
    }

    return `"${strValue.replace(/"/g, '""')}"`;
  }

  private formatUnknownValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'symbol') return value.description ?? 'Symbol()';
    if (typeof value === 'function') return '[function]';
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private formatModuleName(name: string): string {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private formatFeatureName(name: string): string {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let value = bytes;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * Generate PDF buffer from report data
   */
  async generatePdfBuffer(reportType: ReportType, data: unknown): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fontSize(20).font('Helvetica-Bold').text('Aquaculture Platform Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(14).font('Helvetica').text(this.getReportTitle(reportType), { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.moveDown(1.5);

      // Draw a line
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown(1);

      // Content based on report type
      if (Array.isArray(data)) {
        this.renderTableData(doc, data as Record<string, unknown>[]);
      } else if (typeof data === 'object' && data !== null) {
        const reportData = data as { data?: unknown[]; summary?: Record<string, unknown> };
        if (reportData.summary) {
          doc.fontSize(12).font('Helvetica-Bold').text('Summary', { underline: true });
          doc.moveDown(0.5);
          this.renderSummary(doc, reportData.summary);
          doc.moveDown(1);
        }
        if (reportData.data && Array.isArray(reportData.data)) {
          doc.fontSize(12).font('Helvetica-Bold').text('Details', { underline: true });
          doc.moveDown(0.5);
          this.renderTableData(doc, reportData.data as Record<string, unknown>[]);
        }
      }

      // Footer
      doc.moveDown(2);
      doc.fontSize(8).fillColor('gray').text('Aquaculture Platform - Confidential', { align: 'center' });

      doc.end();
    });
  }

  private getReportTitle(type: ReportType): string {
    const titles: Record<ReportType, string> = {
      tenant_overview: 'Tenant Overview Report',
      tenant_churn: 'Churn Analysis Report',
      financial_revenue: 'Revenue Report',
      financial_payments: 'Payments Report',
      usage_modules: 'Module Usage Report',
      usage_features: 'Feature Adoption Report',
      system_performance: 'System Performance Report',
    };
    return titles[type] || 'Report';
  }

  private renderSummary(doc: PDFKit.PDFDocument, summary: Record<string, unknown>): void {
    doc.fontSize(10).font('Helvetica');
    for (const [key, value] of Object.entries(summary)) {
      const formattedKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
      doc.text(`${formattedKey}: ${this.formatUnknownValue(value)}`, { indent: 20 });
    }
  }

  private renderTableData(doc: PDFKit.PDFDocument, data: Record<string, unknown>[]): void {
    if (!data || data.length === 0) {
      doc.fontSize(10).text('No data available');
      return;
    }

    const firstRow = data[0];
    if (!firstRow) return;

    const headers = Object.keys(firstRow);
    const colWidth = (doc.page.width - 100) / Math.min(headers.length, 5);

    // Render headers
    doc.fontSize(9).font('Helvetica-Bold');
    let xPos = 50;
    headers.slice(0, 5).forEach(header => {
      const displayHeader = header.replace(/([A-Z])/g, ' $1').slice(0, 12);
      doc.text(displayHeader, xPos, doc.y, { width: colWidth, continued: false });
      xPos += colWidth;
    });
    doc.moveDown(0.5);

    // Render rows (limit to first 50 rows for PDF)
    doc.font('Helvetica').fontSize(8);
    const maxRows = Math.min(data.length, 50);
    for (let i = 0; i < maxRows; i++) {
      const row = data[i];
      if (!row) continue;

      xPos = 50;
      const yPos = doc.y;
      headers.slice(0, 5).forEach(header => {
        const value = this.formatUnknownValue(row[header]).slice(0, 20);
        doc.text(value, xPos, yPos, { width: colWidth });
        xPos += colWidth;
      });
      doc.moveDown(0.5);

      // Check for page break
      if (doc.y > doc.page.height - 100) {
        doc.addPage();
      }
    }

    if (data.length > 50) {
      doc.moveDown(1);
      doc.fontSize(9).fillColor('gray').text(`... and ${data.length - 50} more rows (truncated for PDF)`);
    }
  }

  /**
   * Get available report types
   */
  getAvailableReports(): Array<{ type: ReportType; name: string; description: string; category: string }> {
    return [
      { type: 'tenant_overview', name: 'Tenant Overview', description: 'Complete list of all tenants with their status and metrics', category: 'Tenant' },
      { type: 'tenant_churn', name: 'Churn Analysis', description: 'Analysis of churned tenants and cancellation reasons', category: 'Tenant' },
      { type: 'financial_revenue', name: 'Revenue Report', description: 'Daily revenue breakdown with subscriptions and refunds', category: 'Financial' },
      { type: 'financial_payments', name: 'Payments Report', description: 'Invoice and payment status overview', category: 'Financial' },
      { type: 'usage_modules', name: 'Module Usage', description: 'Usage statistics for each platform module', category: 'Usage' },
      { type: 'usage_features', name: 'Feature Adoption', description: 'Feature adoption rates and usage patterns', category: 'Usage' },
      { type: 'system_performance', name: 'System Performance', description: 'API performance, uptime, and error rates', category: 'System' },
    ];
  }

  // ============================================================================
  // Report Definitions CRUD
  // ============================================================================

  /**
   * Get all report definitions
   */
  async getDefinitions(params?: {
    status?: ReportDefinitionStatus;
    type?: ReportType;
    page?: number;
    limit?: number;
  }): Promise<IStandardPaginatedResult<ReportDefinition>> {
    const page = params?.page || 1;
    const limit = params?.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.definitionRepository.createQueryBuilder('def');

    if (params?.status) {
      queryBuilder.andWhere('def.status = :status', { status: params.status });
    }

    if (params?.type) {
      queryBuilder.andWhere('def.type = :type', { type: params.type });
    }

    queryBuilder.orderBy('def.createdAt', 'DESC');
    queryBuilder.skip(skip).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return createStandardPaginatedResult(data, total, page, limit);
  }

  /**
   * Get report definition by ID
   */
  async getDefinition(id: string): Promise<ReportDefinition> {
    const definition = await this.definitionRepository.findOne({ where: { id } });
    if (!definition) {
      throw new NotFoundException(`Report definition not found: ${id}`);
    }
    return definition;
  }

  /**
   * Create report definition
   */
  async createDefinition(data: {
    name: string;
    description?: string;
    type: ReportType;
    defaultFormat?: ReportFormat;
    schedule?: ReportSchedule;
    defaultFilters?: Record<string, unknown>;
    recipients?: string[];
    includeCharts?: boolean;
    createdBy?: string;
    createdByEmail?: string;
  }): Promise<ReportDefinition> {
    const definition = this.definitionRepository.create({
      name: data.name,
      description: data.description,
      type: data.type,
      defaultFormat: data.defaultFormat || 'json',
      status: 'active',
      schedule: data.schedule || 'manual',
      defaultFilters: data.defaultFilters,
      recipients: data.recipients,
      includeCharts: data.includeCharts || false,
      createdBy: data.createdBy,
      createdByEmail: data.createdByEmail,
      runCount: 0,
    });

    return this.definitionRepository.save(definition);
  }

  /**
   * Update report definition
   */
  async updateDefinition(id: string, data: Partial<{
    name: string;
    description: string;
    defaultFormat: ReportFormat;
    status: ReportDefinitionStatus;
    schedule: ReportSchedule;
    defaultFilters: Record<string, unknown>;
    recipients: string[];
    includeCharts: boolean;
  }>): Promise<ReportDefinition> {
    const definition = await this.getDefinition(id);

    Object.assign(definition, data, { updatedAt: new Date() });

    return this.definitionRepository.save(definition);
  }

  /**
   * Delete report definition
   */
  async deleteDefinition(id: string): Promise<void> {
    const definition = await this.getDefinition(id);
    await this.definitionRepository.remove(definition);
  }

  // ============================================================================
  // Report Executions
  // ============================================================================

  /**
   * Get execution history
   */
  async getExecutions(params?: {
    definitionId?: string;
    status?: ReportExecutionStatus;
    reportType?: ReportType;
    page?: number;
    limit?: number;
  }): Promise<IStandardPaginatedResult<ReportExecution>> {
    const page = params?.page || 1;
    const limit = params?.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.executionRepository.createQueryBuilder('exec');

    if (params?.definitionId) {
      queryBuilder.andWhere('exec.definitionId = :definitionId', { definitionId: params.definitionId });
    }

    if (params?.status) {
      queryBuilder.andWhere('exec.status = :status', { status: params.status });
    }

    if (params?.reportType) {
      queryBuilder.andWhere('exec.reportType = :reportType', { reportType: params.reportType });
    }

    queryBuilder.orderBy('exec.createdAt', 'DESC');
    queryBuilder.skip(skip).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return createStandardPaginatedResult(data, total, page, limit);
  }

  /**
   * Get execution by ID
   */
  async getExecution(id: string): Promise<ReportExecution> {
    const execution = await this.executionRepository.findOne({ where: { id } });
    if (!execution) {
      throw new NotFoundException(`Report execution not found: ${id}`);
    }
    return execution;
  }

  /**
   * Execute a report (from definition or ad-hoc)
   */
  async executeReport(params: {
    definitionId?: string;
    reportType?: ReportType;
    reportName?: string;
    format: ReportFormat;
    filters?: Record<string, unknown>;
    startDate?: Date;
    endDate?: Date;
    executedBy?: string;
    executedByEmail?: string;
  }): Promise<ReportExecution> {
    const startTime = Date.now();

    // Get definition if provided
    let definition: ReportDefinition | null = null;
    if (params.definitionId) {
      definition = await this.getDefinition(params.definitionId);
    }

    const reportType = definition?.type || params.reportType;
    const reportName = definition?.name || params.reportName || `${reportType} Report`;

    if (!reportType) {
      throw new BadRequestException('Report type is required');
    }

    // Create execution record
    const execution = this.executionRepository.create({
      definitionId: params.definitionId,
      reportName,
      reportType,
      format: params.format,
      status: 'running' as ReportExecutionStatus,
      startDate: params.startDate,
      endDate: params.endDate,
      filters: params.filters || definition?.defaultFilters,
      executedBy: params.executedBy,
      executedByEmail: params.executedByEmail,
    });

    await this.executionRepository.save(execution);

    try {
      // Generate the actual report
      const startDateObj = params.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDateObj = params.endDate || new Date();

      const reportResult = await this.generateReport({
        type: reportType,
        format: 'json',
        startDate: startDateObj,
        endDate: endDateObj,
        filters: params.filters || definition?.defaultFilters,
        includeCharts: definition?.includeCharts,
      });

      const artifact = await this.createReportArtifact({
        executionId: execution.id,
        reportName: execution.reportName,
        reportType,
        format: params.format,
        data: reportResult.data,
        summary: reportResult.summary,
        generatedAt: reportResult.generatedAt,
      });

      // Update execution with results
      execution.status = 'completed';
      execution.summary = reportResult.summary;
      execution.rowCount = Array.isArray(reportResult.data) ? reportResult.data.length : 1;
      execution.fileSizeBytes = artifact.size;
      execution.artifactObjectKey = artifact.objectKey;
      execution.artifactSha256 = artifact.sha256;
      execution.artifactContentType = artifact.contentType;
      execution.downloadUrl = `/api/reports/executions/${execution.id}/download`;
      execution.downloadExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      execution.durationMs = Date.now() - startTime;
      execution.completedAt = new Date();

      await this.executionRepository.save(execution);

      // Update definition run count if applicable
      if (definition) {
        definition.lastRunAt = new Date();
        definition.runCount += 1;
        await this.definitionRepository.save(definition);
      }

      return execution;
    } catch (error) {
      // Mark execution as failed
      execution.status = 'failed';
      execution.errorMessage = error instanceof Error ? error.message : 'Unknown error';
      execution.durationMs = Date.now() - startTime;
      execution.completedAt = new Date();

      await this.executionRepository.save(execution);

      throw error;
    }
  }

  private async createReportArtifact(params: {
    executionId: string;
    reportName: string;
    reportType: ReportType;
    format: ReportFormat;
    data: unknown;
    summary?: Record<string, unknown>;
    generatedAt: Date;
  }): Promise<{ objectKey: string; sha256: string; contentType: string; size: number }> {
    if (!this.storageService) {
      throw new InternalServerErrorException('Report artifact storage is not configured');
    }

    const contentType = this.getContentType(params.format);
    const extension = this.getExtension(params.format);
    const filename = `${params.reportName.replace(/\s+/g, '_')}_${params.executionId}.${extension}`;
    let buffer: Buffer;

    if (params.format === 'json') {
      buffer = Buffer.from(JSON.stringify({
        data: params.data,
        summary: params.summary || {},
        metadata: {
          generatedAt: params.generatedAt.toISOString(),
          reportType: params.reportType,
          format: params.format,
        },
      }));
    } else if (params.format === 'csv') {
      buffer = Buffer.from(this.convertToCsv(Array.isArray(params.data) ? params.data as Record<string, unknown>[] : []));
    } else {
      buffer = await this.generatePdfBuffer(params.reportType, {
        data: params.data,
        summary: params.summary || {},
      });
    }

    const upload = await this.storageService.uploadFile(
      'platform-admin',
      'report-executions',
      params.executionId,
      filename,
      buffer,
      {
        contentType,
        metadata: {
          reportType: params.reportType,
          reportFormat: params.format,
          sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        },
      },
    );

    return {
      objectKey: upload.path,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      contentType,
      size: buffer.length,
    };
  }

  private getContentType(format: ReportFormat): string {
    const contentTypes: Record<ReportFormat, string> = {
      json: 'application/json',
      csv: 'text/csv',
      pdf: 'application/pdf',
    };
    return contentTypes[format];
  }

  private getExtension(format: ReportFormat): string {
    const extensions: Record<ReportFormat, string> = {
      json: 'json',
      csv: 'csv',
      pdf: 'pdf',
    };
    return extensions[format];
  }

  /**
   * Get execution download data
   */
  async getExecutionDownload(id: string): Promise<{
    execution: ReportExecution;
    data: Buffer;
    contentType: string;
    filename: string;
  }> {
    const execution = await this.getExecution(id);

    if (execution.status !== 'completed') {
      throw new BadRequestException('Report execution is not completed');
    }

    if (execution.downloadExpiresAt && new Date() > execution.downloadExpiresAt) {
      throw new GoneException('Download link has expired');
    }

    if (!execution.artifactObjectKey) {
      throw new GoneException('Report artifact is unavailable');
    }

    if (!this.storageService) {
      throw new InternalServerErrorException('Report artifact storage is not configured');
    }

    const reportData = await this.storageService.downloadFile(execution.artifactObjectKey);
    const sha256 = crypto.createHash('sha256').update(reportData).digest('hex');
    if (execution.artifactSha256 && execution.artifactSha256 !== sha256) {
      this.logger.error(`Report artifact checksum mismatch for execution ${execution.id}`);
      throw new InternalServerErrorException('Report artifact integrity check failed');
    }

    return {
      execution,
      data: reportData,
      contentType: execution.artifactContentType || this.getContentType(execution.format),
      filename: `${execution.reportName.replace(/\s+/g, '_')}_${execution.id}.${this.getExtension(execution.format)}`,
    };
  }

  // ============================================================================
  // Quick Reports (for frontend compatibility)
  // ============================================================================

  /**
   * Generate quick tenant report
   */
  async generateQuickTenantsReport(format: ReportFormat, filters?: Record<string, unknown>): Promise<ReportExecution> {
    return this.executeReport({
      reportType: 'tenant_overview',
      reportName: 'Quick Tenants Report',
      format,
      filters,
      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      endDate: new Date(),
    });
  }

  /**
   * Generate quick users report
   */
  async generateQuickUsersReport(format: ReportFormat, filters?: Record<string, unknown>): Promise<ReportExecution> {
    return this.executeReport({
      reportType: 'usage_modules',
      reportName: 'Quick Users Report',
      format,
      filters,
      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      endDate: new Date(),
    });
  }

  /**
   * Generate quick revenue report
   */
  async generateQuickRevenueReport(format: ReportFormat, filters?: Record<string, unknown>): Promise<ReportExecution> {
    return this.executeReport({
      reportType: 'financial_revenue',
      reportName: 'Quick Revenue Report',
      format,
      filters,
      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      endDate: new Date(),
    });
  }

  /**
   * Generate quick audit report
   */
  async generateQuickAuditReport(format: ReportFormat, filters?: Record<string, unknown>): Promise<ReportExecution> {
    return this.executeReport({
      reportType: 'system_performance',
      reportName: 'Quick Audit Report',
      format,
      filters,
      startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      endDate: new Date(),
    });
  }
}
