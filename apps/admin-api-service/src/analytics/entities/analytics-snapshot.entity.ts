/**
 * Analytics Snapshot Entity
 *
 * Periyodik olarak hesaplanan metriklerin saklanması için entity.
 * Bu sayede dashboard hızlı yüklenir ve geçmiş veriler karşılaştırılabilir.
 */

import { DateOnlyColumn, type IsoDateString } from '@aquaculture/backend-common/database';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

// ============================================================================
// Metric Types
// ============================================================================

export type SnapshotType = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type MetricCategory = 'tenant' | 'user' | 'financial' | 'system' | 'usage';

// ============================================================================
// Metric Interfaces
// ============================================================================

/**
 * Tenant counts and rates.
 *
 * `churnedThisMonth`, `churnRate` and `growthRate` are `number | null` because
 * tenant churn is NOT MEASURABLE on this platform today (APA-135), and a bare
 * `number` is what forced the previous proxy into existence.
 *
 * The retired proxy counted `status IN ('CANCELLED','SUSPENDED') AND
 * "updatedAt" >= date_trunc('month', NOW())`. `updatedAt` is an
 * `@UpdateDateColumn`, so it means "last touched", not "churned" — any
 * unrelated write re-dated a long-suspended tenant into the current month. And
 * 'CANCELLED' is unreachable on `auth.tenants`, so the filter collapsed to the
 * REVERSIBLE suspended state. No dated, durable record of the terminal
 * transitions exists: the outbox is pruned after 7 days, the audit log is
 * best-effort and skipped by the bulk paths, and `tenant_activities` has no
 * archived/cancelled member.
 *
 * `growthRate` is null for the same reason — it is `(new - churned) / total`,
 * so computing it with churned = 0 would report gross growth as net.
 *
 * Landing a durable tenant-lifecycle ledger fills these in with NO contract
 * change; reintroducing a timestamp proxy is the regression.
 */
export interface TenantMetrics {
  total: number;
  active: number;
  inactive: number;
  trial: number;
  suspended: number;
  newThisMonth: number;
  churnedThisMonth: number | null;
  churnRate: number | null;
  growthRate: number | null;
  byPlan: Record<string, number>;
}

export interface UserMetrics {
  total: number;
  active: number;
  inactive: number;
  newThisMonth: number;
  activeLastDay: number;
  activeLastWeek: number;
  activeLastMonth: number;
  growthRate: number;
  avgUsersPerTenant: number;
  byRole: Record<string, number>;
}

export interface FinancialMetrics {
  mrr: number;
  arr: number;
  arpu: number;
  arppu: number;
  ltv: number;
  totalRevenue: number;
  revenueThisMonth: number;
  /**
   * Month-over-month MRR change, or null when there is no baseline snapshot to
   * compare against. A 0 here claimed "no change, measured" for a platform that
   * had simply never taken a baseline (APA-134).
   */
  revenueGrowthRate: number | null;
  pendingPayments: number;
  overduePayments: number;
  refunds: number;
  byPlan: Record<string, number>;
  byCurrency: Record<string, number>;
}

/**
 * Infrastructure metrics for the System Metrics card.
 *
 * Every field is `number | null` because admin-api measures NONE of them today:
 * there is no APM, uptime monitor, API-gateway meter or job-queue probe wired to
 * this service. `null` means "not measured" and must render as an explicit
 * placeholder, never as a number (APA-131). A bare `number` was what forced
 * fabrication in the first place — the only way to satisfy the type was to
 * invent a constant (1 TB "default" storage, 100% uptime, 10 connections).
 *
 * Wiring a real source (Prometheus / observability-service) fills these in
 * WITHOUT a contract change; reintroducing a literal here is the regression.
 */
export interface SystemMetrics {
  totalStorageBytes: number | null;
  usedStorageBytes: number | null;
  storageUtilization: number | null;
  apiCallsToday: number | null;
  apiCallsThisMonth: number | null;
  avgResponseTimeMs: number | null;
  errorRate: number | null;
  uptimePercent: number | null;
  activeConnections: number | null;
  queuedJobs: number | null;
}

/** The platform modules usage may be reported for. */
export type ModuleKey =
  | 'dashboard'
  | 'farm_management'
  | 'sensor_monitoring'
  | 'alerts'
  | 'reports'
  | 'hr_module'
  | 'billing';

export interface ModuleUsageStats {
  activeUsers: number;
  totalSessions: number;
  avgSessionDuration: number;
}

/**
 * Per-module / per-feature usage.
 *
 * INVARIANT — PRESENCE MEANS MEASURED: a `moduleUsage` or `featureAdoption`
 * key appears ONLY when it was read from a real data source. "Not
 * instrumented" is encoded as structural ABSENCE (an empty map), never as a
 * fabricated zero entry.
 *
 * WHY (APA-133): the maps used to be emitted fully keyed with zeros because
 * per-module usage has no producer yet — the audit-log analysis pipeline is
 * not wired. Six "0 users" bars then rendered on a SUPER_ADMIN decision
 * dashboard as if measured, and the daily cron persisted the invented map into
 * `admin.analytics_snapshots`. `Partial<>` is load-bearing here: a REQUIRED
 * full-key `Record<ModuleKey, …>` would make the honest empty map a type
 * error, i.e. the contract itself would force the fabrication — the same
 * mechanism behind APA-131 and APA-132.
 *
 * Wiring the pipeline later adds keys with no contract change.
 */
export interface UsageMetrics {
  moduleUsage: Partial<Record<ModuleKey, ModuleUsageStats>>;
  featureAdoption: Record<string, number>;
  topFeatures: Array<{ feature: string; usage: number }>;
  peakHours: number[];
  avgDailyActiveUsers: number;
}

/**
 * The entries of a sparse metric map that carry an actual measurement.
 *
 * A `Partial<Record<…>>` yields `V | undefined` from `Object.entries`, and the
 * whole point of the sparse encoding is that a consumer must SKIP the holes
 * rather than render them as zero. Centralising the skip keeps that rule next
 * to the contract that declares it, so a new consumer gets it for free.
 */
export function measuredEntries<V>(map: Partial<Record<string, V>>): Array<[string, V]> {
  const measured: Array<[string, V]> = [];
  for (const [key, value] of Object.entries(map)) {
    if (value !== undefined) {
      measured.push([key, value]);
    }
  }
  return measured;
}

// ============================================================================
// Entity
// ============================================================================

@Entity('analytics_snapshots', { schema: 'admin', synchronize: false })
// LOW-005 fix: single composite index covers all common query patterns
// (filter by category + optional snapshotType, ordered by snapshotDate)
@Index(['category', 'snapshotType', 'snapshotDate'])
export class AnalyticsSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20 })
  snapshotType!: SnapshotType;

  @Column({ type: 'varchar', length: 20 })
  category!: MetricCategory;

  // PostgreSQL `date` hydrates as a 'YYYY-MM-DD' string; typing it as Date made
  // every .toISOString()/.getFullYear() call a runtime crash (APA-130).
  @DateOnlyColumn()
  snapshotDate!: IsoDateString;

  @Column({ type: 'jsonb' })
  metrics!: TenantMetrics | UserMetrics | FinancialMetrics | SystemMetrics | UsageMetrics;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;
}

// ============================================================================
// Dashboard Summary
// ============================================================================

export interface DashboardSummary {
  tenants: TenantMetrics;
  users: UserMetrics;
  financial: FinancialMetrics;
  system: SystemMetrics;
  usage: UsageMetrics;
  generatedAt: Date;
  /**
   * Lists which data sources failed during aggregation.
   * Present only when the dashboard is in degraded mode (partial failure).
   * Possible values: 'tenants', 'users', 'financial', 'system', 'usage'.
   */
  unavailable?: string[];
}

// ============================================================================
// Time Series Data
// ============================================================================

/**
 * A point on a trend series. `value` is nullable because a snapshot may record
 * a metric as unmeasured (APA-131, APA-135) and a chart must render that as a
 * gap, not as a confident zero (APA-135).
 */
export interface TimeSeriesPoint {
  date: string;
  value: number | null;
}

export interface TimeSeriesData {
  label: string;
  data: TimeSeriesPoint[];
  color?: string;
}

export type AnalyticsRange = '7d' | '30d' | '90d' | '1y';
export type AnalyticsGranularity = 'day' | 'week' | 'month';

export interface TimeSeriesResponse {
  range: AnalyticsRange;
  granularity: AnalyticsGranularity;
  data: TimeSeriesPoint[];
  source: string;
  asOf: string;
}

export interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    backgroundColor?: string | string[];
    borderColor?: string;
  }>;
}

// ============================================================================
// Report Types
// ============================================================================

/**
 * Every report the platform can produce — the runtime SSoT, with the type
 * derived from it rather than the other way round.
 *
 * The literal set used to be written out five times: the union here, three
 * `@IsIn([...])` decorators, and the `download/:reportType` allow-list, which
 * the route validates its path parameter against. A type-keyed route is exactly
 * why `POST /reports/generate` could not hand back a resolvable
 * `/api/reports/download/rpt_…` link (APA-146) — an ephemeral id was never a
 * member of this set and never could be. Deriving `ReportType` from the array
 * makes the vocabulary assertable at runtime and impossible to widen in one
 * place only.
 */
export const REPORT_TYPES = [
  'tenant_overview',
  'tenant_churn',
  'financial_revenue',
  'financial_payments',
  'usage_modules',
  'usage_features',
  'system_performance',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

export type ReportFormat = 'json' | 'csv' | 'pdf';

export interface ReportRequest {
  type: ReportType;
  format: ReportFormat;
  startDate: Date;
  endDate: Date;
  filters?: Record<string, unknown>;
  includeCharts?: boolean;
}

/**
 * The result of a SYNCHRONOUS report generation (`POST /reports/generate` and
 * the ad-hoc GET routes). It is an in-memory preview payload: `data` and
 * `summary` come back inline and nothing is persisted, so `id` identifies
 * nothing that outlives the response.
 *
 * There is deliberately NO `downloadUrl` here. It used to be set to
 * `/api/reports/download/${id}` for csv/pdf, but the only route that matches
 * takes a report TYPE, not an id, and 400s on an `rpt_…` segment — and because
 * the result is never stored, a by-id route could not be built for it either.
 * Repointing it at the type-based route would be a subtler lie: that route
 * re-generates a DIFFERENT report over a default 30-day window rather than
 * returning the one the caller just received. File downloads belong to the
 * persisted executions flow (`ReportExecution.downloadUrl`, set in
 * `executeReport`), which is what the admin panel already uses (APA-146).
 */
export interface ReportResult {
  id: string;
  type: ReportType;
  format: ReportFormat;
  title: string;
  generatedAt: Date;
  data: unknown;
  summary?: Record<string, unknown>;
}

// ============================================================================
// Report Definition Entity (Saved Reports)
// ============================================================================

export type ReportDefinitionStatus = 'active' | 'inactive' | 'draft';
/**
 * RETIRED (APA-141). No scheduler ever consumed this: the only @Cron in the
 * module drives the daily analytics snapshot, and a repo-wide search for reads
 * of `definition.schedule` / `.recipients` found only the write sites. A
 * definition saved with schedule='daily' never ran and its recipients never
 * received anything. The fields are gone from the entity, the DTOs and the
 * service API; the physical columns are retired separately (PLAT-LOW-903).
 *
 * The type itself is kept because the retirement migration and its spec name
 * the values they reset.
 */
export type ReportSchedule = 'manual' | 'daily' | 'weekly' | 'monthly';

@Entity('report_definitions', { schema: 'admin', synchronize: false })
@Index(['createdBy'])
@Index(['status'])
export class ReportDefinition {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'varchar', length: 50 })
  type!: ReportType;

  @Column({ type: 'varchar', length: 20, default: 'json' })
  defaultFormat!: ReportFormat;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: ReportDefinitionStatus;

  @Column({ type: 'jsonb', nullable: true })
  defaultFilters?: Record<string, unknown>;

  @Column({ type: 'boolean', default: false })
  includeCharts!: boolean;

  @Column({ type: 'uuid', nullable: true })
  createdBy?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  createdByEmail?: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt?: Date;

  @Column({ type: 'int', default: 0 })
  runCount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}

// ============================================================================
// Report Execution Entity (Execution History)
// ============================================================================

/**
 * Terminal outcomes of a report execution.
 *
 * `'unavailable'` is NOT a failure: nothing broke, and retrying will never
 * help — the report type has no data source at all. It exists because
 * `'completed'` was the only success-shaped terminal state, so a report over
 * zero measured rows was persisted with a MinIO artifact, a sha256 and a 7-day
 * download link, giving cryptographic provenance to something nobody measured
 * (APA-142). A SUPER_ADMIN could not tell "no module was used" from "no
 * producer exists".
 *
 * An `'unavailable'` execution carries no artifact fields by construction:
 * `generateReport` throws before `createReportArtifact` is reached, so there is
 * no code path that writes an object key, hash, link or expiry for one.
 */
export type ReportExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'unavailable';

@Entity('report_executions', { schema: 'admin', synchronize: false })
@Index(['definitionId'])
@Index(['status'])
@Index(['createdAt'])
export class ReportExecution {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  definitionId?: string;

  @Column({ type: 'varchar', length: 200 })
  reportName!: string;

  @Column({ type: 'varchar', length: 50 })
  reportType!: ReportType;

  @Column({ type: 'varchar', length: 20 })
  format!: ReportFormat;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: ReportExecutionStatus;

  @Column({ type: 'timestamptz', nullable: true })
  startDate?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endDate?: Date;

  @Column({ type: 'jsonb', nullable: true })
  filters?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  summary?: Record<string, unknown>;

  @Column({ type: 'int', nullable: true })
  rowCount?: number;

  @Column({ type: 'int', nullable: true })
  fileSizeBytes?: number;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  artifactObjectKey?: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  artifactSha256?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  artifactContentType?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  downloadUrl?: string;

  @Column({ type: 'timestamptz', nullable: true })
  downloadExpiresAt?: Date;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  /**
   * Why the report could not be produced, for status `'unavailable'`.
   *
   * Deliberately NOT folded into `errorMessage`: an absent data source is not
   * an error, and rendering it under an error badge is the same conflation the
   * status split exists to remove.
   */
  @Column({ type: 'text', nullable: true })
  unavailableReason?: string;

  @Column({ type: 'int', nullable: true })
  durationMs?: number;

  @Column({ type: 'uuid', nullable: true })
  executedBy?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  executedByEmail?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;
}
