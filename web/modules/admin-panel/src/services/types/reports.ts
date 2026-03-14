/**
 * Reports domain types
 */

export type ReportType = 'tenants' | 'users' | 'revenue' | 'usage' | 'audit' | 'compliance' | 'custom';
export type ReportFormat = 'pdf' | 'xlsx' | 'csv' | 'json';
export type ReportStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface ReportDefinition {
  id: string;
  name: string;
  description?: string;
  type: ReportType;
  schedule?: string;
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
  reportId: string;
  reportName: string;
  status: ReportStatus;
  format: ReportFormat;
  fileUrl?: string;
  fileSize?: number;
  rowCount?: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
  requestedBy: string;
}

export interface ReportData {
  columns: Array<{ key: string; label: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  generatedAt: string;
}
