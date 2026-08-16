/**
 * Analytics Snapshot Entity
 *
 * Periyodik olarak hesaplanan metriklerin saklanması için entity.
 * Bu sayede dashboard hızlı yüklenir ve geçmiş veriler karşılaştırılabilir.
 */

import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import type { ReportDefinitionStatus, ReportExecutionStatus } from '../dto/report-contract.dto';
import type {
  ReportFormat,
  ReportArtifactCommitState,
  ReportMeasurementProofV1,
  ReportMeasurementState,
  ReportType,
} from '@platform/reporting-contracts';
import type { AnalyticsMetricSectionProjectionV1 } from '@aquaculture/shared-contracts';

// ============================================================================
// Metric Types
// ============================================================================

export type SnapshotType = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type MetricCategory = 'tenant' | 'user' | 'financial' | 'system' | 'usage';

// ============================================================================
// Metric Interfaces
// ============================================================================

export type TenantMetrics = AnalyticsMetricSectionProjectionV1<'tenants'>;
export type UserMetrics = AnalyticsMetricSectionProjectionV1<'users'>;
export type FinancialMetrics = AnalyticsMetricSectionProjectionV1<'financial'>;
export type SystemMetrics = AnalyticsMetricSectionProjectionV1<'system'>;
export type UsageMetrics = AnalyticsMetricSectionProjectionV1<'usage'>;

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

// ============================================================================
// Report Definition Entity (Saved Reports)
// ============================================================================

@Entity('report_definitions', { schema: 'admin', synchronize: false })
@Index(['createdBy'])
@Index(['status'])
export class ReportDefinition {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'varchar', length: 50 })
  type!: ReportType;

  @Column({ type: 'varchar', length: 20, default: 'json' })
  defaultFormat!: ReportFormat;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: ReportDefinitionStatus;

  @Column({ type: 'jsonb', nullable: true })
  defaultFilters?: Record<string, unknown> | null;

  @Column({ type: 'uuid', nullable: true })
  createdBy?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  createdByEmail?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}

// ============================================================================
// Report Execution Entity (Execution History)
// ============================================================================

@Entity('report_executions', { schema: 'admin', synchronize: false })
@Index(['definitionId'])
@Index(['status'])
@Index(['createdAt'])
export class ReportExecution {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  definitionId?: string | null;

  @Column({ type: 'varchar', length: 200 })
  reportName!: string;

  @Column({ type: 'varchar', length: 50 })
  reportType!: ReportType;

  @Column({ type: 'varchar', length: 20 })
  format!: ReportFormat;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: ReportExecutionStatus;

  @Column({ type: 'timestamptz', nullable: true })
  startDate?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endDate?: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  filters?: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  summary?: Record<string, unknown> | null;

  @Column({ type: 'int', nullable: true })
  rowCount?: number | null;

  @Column({ type: 'int', nullable: true })
  fileSizeBytes?: number | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  artifactObjectKey?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  artifactSha256?: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  artifactContentType?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  downloadExpiresAt?: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  previewRows?: Array<Record<string, unknown>> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  previewSha256?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  measurementProof?: ReportMeasurementProofV1 | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  measurementProofSha256?: string | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  stagedArtifactObjectKey?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  stagedArtifactSha256?: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  artifactCommitState?: ReportArtifactCommitState | null;

  @Column({ type: 'varchar', length: 64 })
  capabilityCatalogSha256!: string;

  @Column({ type: 'varchar', length: 64 })
  measurementCatalogSha256!: string;

  @Column({ type: 'varchar', length: 64 })
  authorityGraphSha256!: string;

  @Column({ type: 'int' })
  artifactMaximumBytes!: number;

  @Column({ type: 'int' })
  previewMaximumRows!: number;

  @Column({ type: 'varchar', length: 20 })
  measurementState!: ReportMeasurementState;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string | null;

  @Column({ type: 'int', nullable: true })
  durationMs?: number | null;

  @Column({ type: 'uuid', nullable: true })
  executedBy?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  executedByEmail?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date | null;
}
