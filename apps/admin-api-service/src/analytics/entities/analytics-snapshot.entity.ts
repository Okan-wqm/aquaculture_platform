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
  id: string;

  @Column({ type: 'varchar', length: 20 })
  snapshotType: SnapshotType;

  @Column({ type: 'varchar', length: 20 })
  category: MetricCategory;

  @Column({ type: 'date' })
  snapshotDate: Date;

  @Column({ type: 'jsonb' })
  metrics: TenantMetrics | UserMetrics | FinancialMetrics | SystemMetrics | UsageMetrics;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
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
