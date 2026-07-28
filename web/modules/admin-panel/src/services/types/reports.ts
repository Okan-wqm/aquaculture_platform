/**
 * Reports domain types
 */

export type ReportType =
  | 'tenant_overview'
  | 'tenant_churn'
  | 'financial_revenue'
  | 'financial_payments'
  | 'usage_modules'
  | 'usage_features'
  | 'system_performance';
export type ReportFormat = 'pdf' | 'csv' | 'json';
export type ReportStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ReportDefinition {
  id: string;
  name: string;
  description?: string;
  type: ReportType;
  filters?: Record<string, unknown>;
  columns?: string[];
  isActive: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdBy: string;
  createdAt: string;
}

export interface ReportExecution {
  id: string;
  definitionId?: string;
  reportName: string;
  reportType: ReportType;
  status: ReportStatus;
  format: ReportFormat;
  downloadUrl?: string;
  downloadExpiresAt?: string;
  fileSizeBytes?: number;
  rowCount?: number;
  summary?: Record<string, unknown>;
  errorMessage?: string;
  durationMs?: number;
  createdAt: string;
  startDate?: string;
  endDate?: string;
  completedAt?: string;
  executedBy?: string;
  executedByEmail?: string;
}

export interface ReportData {
  columns: Array<{ key: string; label: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  generatedAt: string;
}
