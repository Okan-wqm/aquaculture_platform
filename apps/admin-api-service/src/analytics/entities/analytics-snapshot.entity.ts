/**
 * Analytics Snapshot Entity
 *
 * Periyodik olarak hesaplanan metriklerin saklanması için entity.
 * Bu sayede dashboard hızlı yüklenir ve geçmiş veriler karşılaştırılabilir.
 */

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

export interface TenantMetrics {
  total: number;
  active: number;
  inactive: number;
  trial: number;
  suspended: number;
  newThisMonth: number;
  churnedThisMonth: number;
  churnRate: number;
  growthRate: number;
  byPlan: Record<string, number>;
  byRegion: Record<string, number>;
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
  revenueGrowthRate: number;
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

export interface UsageMetrics {
  moduleUsage: Record<string, {
    activeUsers: number;
    totalSessions: number;
    avgSessionDuration: number;
  }>;
  featureAdoption: Record<string, number>;
  topFeatures: Array<{ feature: string; usage: number }>;
  peakHours: number[];
  avgDailyActiveUsers: number;
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

  @Column({ type: 'date' })
  snapshotDate!: Date;

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

export interface TimeSeriesPoint {
  date: string;
  value: number;
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

export type ReportType =
  | 'tenant_overview'
  | 'tenant_churn'
  | 'financial_revenue'
  | 'financial_payments'
  | 'usage_modules'
  | 'usage_features'
  | 'system_performance';

export type ReportFormat = 'json' | 'csv' | 'pdf';

export interface ReportRequest {
  type: ReportType;
  format: ReportFormat;
  startDate: Date;
  endDate: Date;
  filters?: Record<string, unknown>;
  includeCharts?: boolean;
}

export interface ReportResult {
  id: string;
  type: ReportType;
  format: ReportFormat;
  title: string;
  generatedAt: Date;
  data: unknown;
  summary?: Record<string, unknown>;
  downloadUrl?: string;
}

// ============================================================================
// Report Definition Entity (Saved Reports)
// ============================================================================

export type ReportDefinitionStatus = 'active' | 'inactive' | 'draft';
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

  @Column({ type: 'varchar', length: 20, default: 'manual' })
  schedule!: ReportSchedule;

  @Column({ type: 'jsonb', nullable: true })
  defaultFilters?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  recipients?: string[];

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

export type ReportExecutionStatus = 'pending' | 'running' | 'completed' | 'failed';

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
