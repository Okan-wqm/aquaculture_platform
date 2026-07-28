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
/**
 * `'unavailable'` mirrors the backend terminal state added in APA-142: the
 * report type has no data source, so nothing broke and no retry will help.
 * Folding it into 'completed' or 'failed' is the exact conflation it exists to
 * remove.
 */
export type ReportStatus = 'pending' | 'running' | 'completed' | 'failed' | 'unavailable';

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
  /** Why the report could not be produced; set only for status 'unavailable'. */
  unavailableReason?: string;
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
