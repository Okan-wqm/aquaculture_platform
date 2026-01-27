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

export interface SystemMetrics {
  totalStorageBytes: number;
  usedStorageBytes: number;
  storageUtilization: number;
  apiCallsToday: number;
  apiCallsThisMonth: number;
  avgResponseTimeMs: number;
  errorRate: number;
  uptimePercent: number;
  activeConnections: number;
  queuedJobs: number;
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

@Entity('analytics_snapshots', { schema: 'public', synchronize: false })
@Index(['snapshotType', 'snapshotDate'])
@Index(['category', 'snapshotDate'])
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

export type ReportFormat = 'json' | 'csv' | 'excel' | 'pdf';

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

@Entity('report_definitions', { schema: 'public', synchronize: false })
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

  @Column({ type: 'timestamp', nullable: true })
  lastRunAt?: Date;

  @Column({ type: 'int', default: 0 })
  runCount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}

// ============================================================================
// Report Execution Entity (Execution History)
// ============================================================================

export type ReportExecutionStatus = 'pending' | 'running' | 'completed' | 'failed';

@Entity('report_executions', { schema: 'public', synchronize: false })
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

  @Column({ type: 'timestamp', nullable: true })
  startDate?: Date;

  @Column({ type: 'timestamp', nullable: true })
  endDate?: Date;

  @Column({ type: 'jsonb', nullable: true })
  filters?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  summary?: Record<string, unknown>;

  @Column({ type: 'int', nullable: true })
  rowCount?: number;

  @Column({ type: 'int', nullable: true })
  fileSizeBytes?: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  downloadUrl?: string;

  @Column({ type: 'timestamp', nullable: true })
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

  @Column({ type: 'timestamp', nullable: true })
  completedAt?: Date;
}
