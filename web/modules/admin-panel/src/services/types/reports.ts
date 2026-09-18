/**
 * Reports domain types
 */

import type { ApiSchema } from '../contract';

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

export type ReportDefinition = ApiSchema<'ReportDefinition'>;

export type ReportExecution = ApiSchema<'ReportExecution'>;

export interface ReportData {
  columns: Array<{ key: string; label: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  generatedAt: string;
}
