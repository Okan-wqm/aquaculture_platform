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
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { MinioClientService } from '@platform/storage';
import PDFDocument from 'pdfkit';
import { Between, DataSource, In, Repository } from 'typeorm';

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
  ReportExecutionStatus,
  REPORT_PREVIEW_ROW_LIMIT,
  REPORT_RANGE_SEMANTICS,
  SystemMetrics,
  measuredEntries,
} from '../entities/analytics-snapshot.entity';
import { InvoiceReadOnly, InvoiceStatus } from '../entities/external/invoice.entity';
import { monthlyPriceOf } from '../entities/external/subscription-pricing.util';
import { SubscriptionReadOnly, SubscriptionStatus } from '../entities/external/subscription.entity';
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

/**
 * A row of the payments report, sourced from `billing.invoices`.
 *
 * `status` is the billing `InvoiceStatus` enum, not a bare `string`. The loose
 * type is what let `const status = amount === 0 ? 'paid' : 'paid'` — a literal
 * tautology — type-check for as long as it did, which made every non-paid
 * branch dead code and pinned the collection rate at 100% (APA-138).
 */
interface PaymentReportRow {
  invoiceId: string;
  tenantName: string;
  amount: number;
  amountDue: number;
  currency: string;
  dueDate: string;
  status: InvoiceStatus;
  daysPastDue: number;
}

/**
 * A period-over-period movement of a usage metric.
 *
 * `null` is the ONLY inhabitant today, and that is the point. No
 * snapshot-history comparator exists, so every direction literal would be a
 * constant asserted as an observation — which is exactly what `trend: 'stable'`
 * was on every row of every usage report (APA-142). Typing it as
 * `'up' | 'down' | 'stable' | null` would re-permit the constant being removed;
 * a future edit could reinstate it and still type-check. Widen this union in
 * the SAME commit that lands the comparator, never before.
 */
type UsageTrend = null;

interface ModuleUsageReportRow {
  module: string;
  activeUsers: number;
  totalSessions: number;
  avgSessionDuration: number;
  adoptionRate: number;
  trend: UsageTrend;
}

interface FeatureUsageReportRow {
  feature: string;
  adoptionRate: number;
  activeUsers: number;
  /** Per-user usage frequency has no producer; `0` claimed a measured zero for
   *  every feature (APA-142). */
  avgUsagePerUser: number | null;
  trend: UsageTrend;
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

/**
 * A generated report body, discriminated on whether its data source exists.
 *
 * A generator CANNOT hand back rows without asserting they were measured: the
 * `data` property lives only on the `measured: true` arm, so `formatReportData`
 * and `createReportArtifact` are unreachable until the caller narrows. That is
 * the structural guarantee behind APA-142 — an artifact, a sha256 and a
 * download link can only ever cover measured rows.
 *
 * Zero rows used to be indistinguishable from zero measurements: a
 * `usage_modules` execution over an unwired telemetry pipeline uploaded a
 * ZERO-BYTE csv to object storage, hashed it (the sha256 of the empty string),
 * stamped `status='completed'` and handed out a 7-day link, which the admin
 * panel rendered as a green "Ready" badge with a Download button.
 */
export type ReportBody<TRow> =
  | { measured: true; data: TRow[]; summary: Record<string, unknown> }
  | { measured: false; unavailableReason: string };

/**
 * Raised when a report type has no producer for its rows.
 *
 * 422 rather than 500: the request is well-formed, the resource simply cannot
 * be produced, and no retry will change that.
 */
export class ReportDataSourceUnavailableException extends UnprocessableEntityException {
  constructor(
    readonly reportType: ReportType,
    readonly unavailableReason: string,
  ) {
    super(`Report "${reportType}" has no data source: ${unavailableReason}`);
  }
}

/**
 * Whether a report body may be kept in, or served from, the cache.
 *
 * ONE predicate for both directions, because the two questions have the same
 * answer and asking them separately is how they drift apart.
 *
 * On READ it makes the cache self-healing. A cache entry is data from an
 * external store that a PREVIOUS release may have written, and `getJson<T>`
 * casts it unchecked — so a payload written before `ReportBody` gained its
 * `measured` discriminant would decode with `measured === undefined` and report
 * a perfectly healthy tenant/revenue/performance report as having no data
 * source for the full four-hour TTL of every key still warm at rollout.
 * Validating on read turns that into a miss that recomputes and rewrites,
 * across every future shape change, rather than relying on someone remembering
 * to bump a version segment in the key.
 *
 * On WRITE it keeps unavailability OUT of the cache. Availability is not a
 * property of the report, it is a property of the world: `system_performance`
 * becomes producible the moment the 1AM snapshot cron writes its row. Caching
 * "there is no data" for four hours would make the platform slow to notice that
 * there now is — a request at 00:59 would keep answering "no data source" until
 * 04:59. Recomputing an unavailable answer is cheap; being wrong about it for
 * four hours is not.
 *
 * The row element type is deliberately not validated: rows are written by this
 * service's own generators, and the discriminant is the only part a stale
 * writer can get wrong.
 */
function isCacheableReportBody(value: unknown): value is ReportBody<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'measured' in value &&
    value.measured === true &&
    'data' in value &&
    Array.isArray(value.data) &&
    'summary' in value
  );
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

/** Currency rounding to 2dp. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
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
    // billing.invoices is the SSoT for monetary state (CLAUDE.md D14); the
    // payments report reads it instead of synthesising invoices (APA-138).
    @InjectRepository(InvoiceReadOnly)
    private readonly invoiceRepository: Repository<InvoiceReadOnly>,
    // billing.subscriptions is the SSoT for what a tenant pays (APA-147).
    @InjectRepository(SubscriptionReadOnly)
    private readonly subscriptionRepository: Repository<SubscriptionReadOnly>,
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
   * Get cached report data or compute it.
   *
   * `isCacheable` is not optional on purpose, and it gates BOTH directions: a
   * value it rejects is never served and never stored. A cache read is
   * deserialisation from a store a previous release may have written, and
   * `getJson<T>` hands the payload back with an unchecked cast — so requiring
   * the caller to say what a valid payload looks like turns a stale shape into
   * a MISS instead of a value that satisfies the type system while being wrong
   * (APA-142).
   */
  private async getCachedOrCompute<T>(
    cacheKey: string,
    isCacheable: (value: unknown) => value is T,
    compute: () => Promise<T>,
  ): Promise<T> {
    if (this.redisService) {
      try {
        const cached = await this.redisService.getJson<unknown>(cacheKey);
        if (isCacheable(cached)) {
          this.logger.debug(`Cache HIT: ${cacheKey}`);
          return cached;
        }
        if (cached !== null && cached !== undefined) {
          this.logger.debug(`Cache DISCARD (not cacheable): ${cacheKey}`);
        }
      } catch {
        // Cache miss or error
      }
    }

    const result = await compute();

    if (this.redisService && isCacheable(result)) {
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

    let body: ReportBody<unknown>;
    let title: string;

    // OPTIMIZED: Cache expensive report computations
    // BUG-002/BUG-019 fix: include filters in cache key to prevent stale cached results
    // being returned for requests with different filter criteria
    const filtersKey = request.filters
      ? JSON.stringify(Object.fromEntries(Object.entries(request.filters).sort()))
      : 'none';
    // A point-in-time report's rows do not depend on the window, so keying by
    // it fragmented the cache into per-range entries holding IDENTICAL data —
    // which is precisely what hid the ignored range from anyone comparing two
    // runs (APA-140). One key per point-in-time report, as its content warrants.
    const rangeKey =
      REPORT_RANGE_SEMANTICS[request.type] === 'ranged'
        ? `${request.startDate?.toISOString() || 'all'}:${request.endDate?.toISOString() || 'all'}`
        : 'point-in-time';
    const cacheKey = `report:${request.type}:${rangeKey}:${filtersKey}`;

    switch (request.type) {
      case 'tenant_overview': {
        body = await this.getCachedOrCompute<ReportBody<unknown>>(
          cacheKey,
          isCacheableReportBody,
          () => this.generateTenantOverviewReport(request),
        );
        title = 'Tenant Overview Report';
        break;
      }

      case 'tenant_churn': {
        body = await this.getCachedOrCompute<ReportBody<unknown>>(
          cacheKey,
          isCacheableReportBody,
          () => this.generateChurnReport(request),
        );
        title = 'Churn Analysis Report';
        break;
      }

      case 'financial_revenue': {
        body = await this.getCachedOrCompute<ReportBody<unknown>>(
          cacheKey,
          isCacheableReportBody,
          () => this.generateRevenueReport(request),
        );
        title = 'Revenue Report';
        break;
      }

      case 'financial_payments': {
        body = await this.generatePaymentsReport(request);
        title = 'Payments Report';
        break;
      }

      case 'usage_modules': {
        body = await this.generateModuleUsageReport(request);
        title = 'Module Usage Report';
        break;
      }

      case 'usage_features': {
        body = await this.generateFeatureUsageReport(request);
        title = 'Feature Usage Report';
        break;
      }

      case 'system_performance': {
        body = await this.getCachedOrCompute<ReportBody<unknown>>(
          cacheKey,
          isCacheableReportBody,
          () => this.generatePerformanceReport(request),
        );
        title = 'System Performance Report';
        break;
      }

      default:
        throw new BadRequestException('Unknown report type');
    }

    // The single choke point. A report whose data source does not exist must
    // never reach formatReportData: an empty body serialises to a zero-byte
    // CSV, which executeReport would upload to object storage, hash, and hand a
    // 7-day download link for — cryptographic provenance over something nobody
    // measured (APA-142). Throwing here gives all twelve callers of
    // generateReport (nine controller routes plus executeReport) the correct
    // behaviour with no code of their own.
    if (!body.measured) {
      throw new ReportDataSourceUnavailableException(request.type, body.unavailableReason);
    }

    // Format data based on requested format
    const formattedData = this.formatReportData(body.data, request.format);

    const result: ReportResult = {
      // BUG-028 fix: use crypto.randomBytes for an unguessable ID; replace deprecated substr()
      id: `rpt_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
      type: request.type,
      format: request.format,
      title,
      generatedAt: new Date(),
      data: formattedData,
      summary: body.summary,
    };

    return result;
  }

  // ============================================================================
  // Tenant Reports
  // ============================================================================

  private async generateTenantOverviewReport(
    _request: ReportRequest,
  ): Promise<ReportBody<TenantReportRow>> {
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

    // MRR from the billing SSoT, never an in-code tier table (APA-147).
    const monthlyPriceByTenant = await this.resolveMonthlyPrices(tenants.map((t) => t.id));

    // Transform to report format
    const data: TenantReportRow[] = tenants.map(tenant => ({
      id: tenant.id,
      name: tenant.name,
      plan: tenant.plan,
      status: tenant.status === TenantStatus.ACTIVE ? 'Active' :
              tenant.status === TenantStatus.PENDING ? 'Trial' : tenant.status,
      users: userCountMap.get(tenant.id) || 0,
      createdAt: tenant.createdAt?.toISOString().substring(0, 10) ?? '',
      mrr: tenant.status === TenantStatus.ACTIVE ? round2(monthlyPriceByTenant.get(tenant.id) ?? 0) : 0,
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
      measured: true,
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

  private async generateChurnReport(
    _request: ReportRequest,
  ): Promise<ReportBody<ChurnReportRow>> {
    // The churn report cannot be produced, and the reason is the same one that
    // nulled `TenantMetrics.churnedThisMonth` on the dashboard (APA-135): there
    // is no durable, dated record of a tenant leaving.
    //
    // Every column of this report rested on `tenant.updatedAt`. It is an
    // `@UpdateDateColumn`, so it means "last touched", not "cancelled" — any
    // unrelated write re-dates a long-suspended tenant, and the billing plan
    // projection issues exactly such a write on every plan or trial change. So
    // `cancelDate` was a last-write timestamp presented as a churn date, and
    // `usageDays` and `lifetimeValue` were both computed FROM it, which
    // propagated the error into the money columns. The row population was
    // itself wrong too: 'CANCELLED' is unreachable on `auth.tenants`
    // (LIFECYCLE_COMMANDS only accepts it as a transition SOURCE), so the
    // filter collapsed to SUSPENDED — a reversible dunning state that is not
    // churn — and `reason` was the literal 'Unknown' on every row.
    //
    // Every candidate replacement was checked and rejected when APA-135 was
    // closed: `suspendedAt` measures the same reversible state;
    // `billing.subscriptions.cancelled_at` is set before the cancellation takes
    // effect and is NULLed on reactivation; the `TenantStatusChanged` outbox
    // rows are deleted seven days after publish and nothing ingests them;
    // `admin.audit_logs` is best-effort and skipped by the bulk paths; and
    // `admin.tenant_activities` has no archived or cancelled member.
    //
    // Reporting "no data source" is the same ruling the dashboard already
    // makes, on the surface that exports it. Landing a durable
    // tenant-lifecycle ledger turns this back on; a timestamp proxy does not.
    return {
      measured: false,
      unavailableReason:
        'Tenant churn has no producer: no durable, dated record of a tenant leaving exists, ' +
        'and a last-write timestamp is not a cancellation date.',
    };
  }

  // ============================================================================
  // Financial Reports
  // ============================================================================

  private async generateRevenueReport(
    request: ReportRequest,
  ): Promise<ReportBody<RevenueReportRow>> {
    const startDate = request.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = request.endDate || new Date();

    // Fetch all tenants with their creation dates and plans
    const tenants = await this.tenantRepository.find();

    // MRR from the billing SSoT, never an in-code tier table (APA-147).
    // NOTE: this report still projects TODAY's subscription price backwards onto
    // every historical day, so it rewrites history on a repricing or a plan
    // change. That is the separate, larger APA-139 — this change only removes
    // the second pricing source, it does not yet make the series temporal.
    const monthlyPriceByTenant = await this.resolveMonthlyPrices(tenants.map((t) => t.id));

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
          const monthlyPrice = monthlyPriceByTenant.get(tenant.id) ?? 0;
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
      measured: true,
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

  /**
   * Payments report, read from the billing SSoT.
   *
   * It used to SYNTHESISE its rows: one invented invoice per ACTIVE tenant,
   * priced from an in-code plan table, numbered `INV-${month}-${tenantId8}`,
   * dated the 1st of the current month, and stamped
   * `const status = amount === 0 ? 'paid' : 'paid'` — a tautology that made the
   * pending and overdue branches unreachable, `totalPending`/`totalOverdue`
   * structurally 0, and `collectionRate` exactly 100% whenever any active
   * tenant existed. Real unpaid invoices were invisible on the one report a
   * SUPER_ADMIN uses to find them (APA-138).
   *
   * `billing.invoices` is the SSoT for monetary state (CLAUDE.md D14) and the
   * read-only projection already existed in this module. Rows are now real
   * invoices in the requested period; a missing tenant name degrades to the
   * tenant id rather than dropping the invoice, because an unnamed invoice is
   * still money owed.
   *
   * The period is anchored on `due_date`: this is a collections view, so the
   * question it answers is "what fell due in this window, and was it paid" —
   * the same date `daysPastDue` accrues from.
   */
  private async generatePaymentsReport(
    request: ReportRequest,
  ): Promise<ReportBody<PaymentReportRow>> {
    // The boundary guarantees a ranged report carries a window; these defaults
    // cover the internal convenience routes that build their own request.
    const windowStart = request.startDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const windowEnd = request.endDate ?? new Date();

    const invoices = await this.invoiceRepository.find({
      where: { dueDate: Between(windowStart, windowEnd) },
      order: { dueDate: 'ASC' },
    });

    const tenantNames = await this.resolveTenantNames(invoices.map((i) => i.tenantId));
    const now = Date.now();
    const MS_PER_DAY = 1000 * 60 * 60 * 24;

    const data: PaymentReportRow[] = invoices.map((invoice) => {
      // Settled invoices are not "past due" however old they are; an open one
      // accrues from its own due date, so the age is per-invoice, never a
      // single report-wide constant.
      const settled =
        invoice.status === InvoiceStatus.PAID ||
        invoice.status === InvoiceStatus.VOID ||
        invoice.status === InvoiceStatus.REFUNDED;
      const daysPastDue = settled
        ? 0
        : Math.max(0, Math.floor((now - invoice.dueDate.getTime()) / MS_PER_DAY));

      return {
        invoiceId: invoice.invoiceNumber,
        tenantName: tenantNames.get(invoice.tenantId) ?? invoice.tenantId,
        amount: invoice.total,
        amountDue: invoice.amountDue,
        currency: invoice.currency,
        dueDate: toIsoDateString(invoice.dueDate),
        status: invoice.status,
        daysPastDue,
      };
    });

    // Money is bucketed by what the invoice actually owes: a PARTIALLY_PAID
    // invoice contributes its settled part to collected and its remainder to
    // outstanding, which the old paid/pending/overdue-by-full-amount split
    // could not express.
    // VOID and REFUNDED are both "no longer receivable", but for opposite
    // reasons, and neither is money the customer still owes. billing-service
    // zeroes `amountPaid` and restores `amountDue = total` on a full refund
    // (refund-payment.handler.ts:150-159), so a refunded invoice looks exactly
    // like an unpaid one by amount alone — counting it as outstanding would
    // invent a receivable that was deliberately given back.
    const receivable = (row: PaymentReportRow): boolean =>
      row.status !== InvoiceStatus.PAID &&
      row.status !== InvoiceStatus.VOID &&
      row.status !== InvoiceStatus.REFUNDED;

    const overdue = data.filter((row) => row.status === InvoiceStatus.OVERDUE);
    const outstanding = data.filter(receivable);
    const refunded = data.filter((row) => row.status === InvoiceStatus.REFUNDED);
    const collected = data.reduce((sum, row) => sum + (row.amount - row.amountDue), 0);

    // Denominator matches AnalyticsService.getFinancialMetrics, which counts
    // only `status = 'paid'` as revenue and reports refunds as their own
    // aggregate. Leaving refunded invoices in the denominator would depress the
    // collection rate on the report while the dashboard KPI ignored them — the
    // report-vs-dashboard divergence this whole class is about.
    const billed = data
      .filter((row) => row.status !== InvoiceStatus.VOID && row.status !== InvoiceStatus.REFUNDED)
      .reduce((sum, row) => sum + row.amount, 0);

    return {
      measured: true,
      data,
      summary: {
        totalInvoices: data.length,
        totalCollected: round2(collected),
        totalOutstanding: round2(outstanding.reduce((sum, row) => sum + row.amountDue, 0)),
        totalOverdue: round2(overdue.reduce((sum, row) => sum + row.amountDue, 0)),
        totalRefunded: round2(refunded.reduce((sum, row) => sum + row.amount, 0)),
        paidCount: data.filter((row) => row.status === InvoiceStatus.PAID).length,
        outstandingCount: outstanding.length,
        overdueCount: overdue.length,
        refundedCount: refunded.length,
        // No invoices in the period is not a 0% collection rate — it is an
        // undefined one. Reporting 0 would read as "we collected nothing".
        collectionRate: billed > 0 ? Math.round((collected / billed) * 100) : null,
      },
    };
  }

  /**
   * `tenantId -> monthly price`, read from the billing SSoT.
   *
   * The ONE place any report turns a tenant into a monthly figure (APA-147).
   * Three byte-identical in-code tier tables used to do this, so a repricing, a
   * negotiated plan, a $0 tier or a non-monthly cycle made every report
   * contradict the dashboard's MRR on the same screen.
   *
   * A tenant absent from the map has no live subscription; the caller decides
   * what that means (usually 0). Only ACTIVE and TRIAL subscriptions are read:
   * `billing.subscriptions` keeps churned history as soft-deleted rows, and the
   * read-model projects no `is_deleted` column, so an unfiltered `find()` can
   * return a cancelled subscription's price. Filtering on the live statuses
   * expresses the intent — "what is this tenant paying now" — without depending
   * on a column this projection does not carry.
   *
   * Ties are broken by the LATER `startDate`, then by the lexically greater id,
   * so the result is deterministic even if two rows share a start date.
   */
  private async resolveMonthlyPrices(tenantIds: readonly string[]): Promise<Map<string, number>> {
    const unique = [...new Set(tenantIds)];
    if (unique.length === 0) {
      return new Map();
    }
    const subscriptions = await this.subscriptionRepository.find({
      where: {
        tenantId: In(unique),
        status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL]),
      },
    });

    const latest = new Map<string, SubscriptionReadOnly>();
    for (const subscription of subscriptions) {
      const incumbent = latest.get(subscription.tenantId);
      if (
        !incumbent ||
        subscription.startDate.getTime() > incumbent.startDate.getTime() ||
        (subscription.startDate.getTime() === incumbent.startDate.getTime() &&
          subscription.id > incumbent.id)
      ) {
        latest.set(subscription.tenantId, subscription);
      }
    }

    return new Map(
      [...latest].map(([tenantId, subscription]) => [tenantId, monthlyPriceOf(subscription)]),
    );
  }

  /**
   * `tenantId -> name` for the given ids, deduplicated and batched in one query.
   * Ids with no tenant row are simply absent; the caller decides how to degrade.
   */
  private async resolveTenantNames(tenantIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(tenantIds)];
    if (unique.length === 0) {
      return new Map();
    }
    const tenants = await this.tenantRepository.find({
      where: { id: In(unique) },
      select: ['id', 'name'],
    });
    return new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
  }

  // ============================================================================
  // Usage Reports
  // ============================================================================

  private async generateModuleUsageReport(
    _request: ReportRequest,
  ): Promise<ReportBody<ModuleUsageReportRow>> {
    const usage = await this.analyticsService.getUsageMetrics();

    // `measuredEntries` skips unmeasured modules — the metric encodes "not
    // instrumented" as an absent key (APA-133). An empty map is therefore NOT
    // "no module was used": it is "no producer wrote a measurement". Emitting
    // zero rows let executeReport hash and sign a zero-byte artifact as though
    // it were an observation of the platform (APA-142). Availability is DERIVED
    // from the metric, never hardcoded, so wiring the pipeline flips it with no
    // code change here.
    const measured = measuredEntries(usage.moduleUsage);
    if (measured.length === 0) {
      return {
        measured: false,
        unavailableReason:
          'Per-module usage has no producer: the audit-log usage pipeline is not wired.',
      };
    }

    // C-3 fix: use actual user count instead of hardcoded 2456, remove Math.random() for trend
    const userMetrics = await this.analyticsService.getUserMetrics();
    const totalActiveUsers = userMetrics.active || 1; // avoid division by zero

    const data: ModuleUsageReportRow[] = measured.map(([module, stats]) => ({
      module: this.formatModuleName(module),
      activeUsers: stats.activeUsers,
      totalSessions: stats.totalSessions,
      avgSessionDuration: stats.avgSessionDuration,
      adoptionRate: Math.round((stats.activeUsers / totalActiveUsers) * 100),
      trend: null,
    }));

    // `.sort()` mutates in place, so the ranking copies first rather than
    // reordering the caller's rows.
    const byActiveUsers = [...data].sort((a, b) => b.activeUsers - a.activeUsers);

    return {
      measured: true,
      data,
      summary: {
        totalModules: data.length,
        mostUsedModule: byActiveUsers[0]?.module ?? null,
        avgAdoptionRate: roundOrNull(avgOrNull(data.map((m) => m.adoptionRate))),
        totalSessions: data.reduce((sum, m) => sum + m.totalSessions, 0),
      },
    };
  }

  private async generateFeatureUsageReport(
    _request: ReportRequest,
  ): Promise<ReportBody<FeatureUsageReportRow>> {
    const usage = await this.analyticsService.getUsageMetrics();

    // Same reasoning as the module report: an empty adoption map means no
    // producer, not universal non-adoption (APA-142).
    const adoption = Object.entries(usage.featureAdoption);
    if (adoption.length === 0) {
      return {
        measured: false,
        unavailableReason:
          'Feature adoption has no producer: the audit-log usage pipeline is not wired.',
      };
    }

    // C-3 fix: use actual user count, remove Math.random()
    const featureUserMetrics = await this.analyticsService.getUserMetrics();
    const featureTotalActive = featureUserMetrics.active || 1;

    const data: FeatureUsageReportRow[] = adoption.map(([feature, rate]) => ({
      feature: this.formatFeatureName(feature),
      adoptionRate: rate,
      activeUsers: Math.round((rate / 100) * featureTotalActive),
      avgUsagePerUser: null,
      trend: null,
    }));

    return {
      measured: true,
      data,
      summary: {
        totalFeatures: data.length,
        // Empty measured set -> null, not NaN (APA-133).
        avgAdoptionRate: roundOrNull(avgOrNull(data.map((f) => f.adoptionRate))),
        highAdoptionCount: data.filter(f => f.adoptionRate >= 60).length,
        lowAdoptionCount: data.filter(f => f.adoptionRate < 40).length,
      },
    };
  }

  // ============================================================================
  // Performance Report
  // ============================================================================

  private async generatePerformanceReport(
    request: ReportRequest,
  ): Promise<ReportBody<PerformanceReportRow>> {
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

    // Emptiness is not the signal — MEASUREDNESS is. A table of per-day rows
    // whose every metric is null is exactly as unmeasured as no rows at all,
    // and stamping `measured: true` on it would still earn the run a sha256, a
    // 7-day link and a green "Ready" badge over data nobody collected
    // (APA-142). Coverage below is the partial-measurement signal; this is the
    // none-at-all one.
    if (daysWithData === 0) {
      return {
        measured: false,
        unavailableReason:
          'System performance has no producer: no APM or uptime snapshots exist for this range.',
      };
    }

    return {
      measured: true,
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
    defaultFilters?: Record<string, unknown>;
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
      defaultFilters: data.defaultFilters,
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
    defaultFilters: Record<string, unknown>;
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

    // A point-in-time report ignores the window by design, so recording one on
    // the execution row would claim a scope the run never had — the same lie in
    // the history list that the modal used to tell in the form (APA-140).
    const ranged = REPORT_RANGE_SEMANTICS[reportType] === 'ranged';

    // Create execution record
    const execution = this.executionRepository.create({
      definitionId: params.definitionId,
      reportName,
      reportType,
      format: params.format,
      status: 'running' as ReportExecutionStatus,
      startDate: ranged ? params.startDate : undefined,
      endDate: ranged ? params.endDate : undefined,
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
      // The rows exist in memory at exactly this point — generateReport ran
      // with format 'json' above — so a bounded slice costs nothing and works
      // uniformly for json, csv and pdf executions, with no artifact
      // re-parsing and no second endpoint. `rowCount` still carries the true
      // total, so the UI can say "first N of M" (APA-144).
      const generatedRows: readonly unknown[] = Array.isArray(reportResult.data)
        ? reportResult.data
        : [];

      execution.status = 'completed';
      execution.summary = reportResult.summary;
      execution.rowCount = Array.isArray(reportResult.data) ? reportResult.data.length : 1;
      // A real runtime narrowing, not an assertion: a non-object row genuinely
      // cannot be a preview row, and dropping it is honest.
      // A real runtime narrowing, not an assertion: a non-object row genuinely
      // cannot be a preview row, and dropping it is honest.
      execution.previewRows = generatedRows
        .slice(0, REPORT_PREVIEW_ROW_LIMIT)
        .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
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
      // An absent data source is a terminal OUTCOME, not a failure: nothing
      // broke and no retry will help. It is recorded (the request is still
      // audit-worthy) and RETURNED rather than rethrown, so the caller gets the
      // honest execution record instead of a 422 with no history entry. The
      // throw happened inside generateReport — strictly before
      // createReportArtifact — so no object key, sha256, download link or
      // expiry can exist on this row (APA-142).
      if (error instanceof ReportDataSourceUnavailableException) {
        execution.status = 'unavailable';
        execution.unavailableReason = error.unavailableReason;
        execution.durationMs = Date.now() - startTime;
        execution.completedAt = new Date();

        await this.executionRepository.save(execution);

        return execution;
      }

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
