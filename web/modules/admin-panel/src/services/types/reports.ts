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

/** Lifecycle state of a saved report definition — the entity's `status` column. */
export type ReportDefinitionStatus = 'active' | 'inactive' | 'draft';

/**
 * A saved report definition, as `GET /reports/definitions` returns it.
 *
 * This drifted from the entity on three axes at once (APA-150), and the
 * optionality of the invented fields is what made all three type-legal:
 *
 *  - FORBIDDEN: `isActive`, `columns`, `filters`, `nextRunAt` and `createdBy`
 *    are not in `CreateDefinitionDto`'s whitelist, and the platform pipe runs
 *    `forbidNonWhitelisted: true` — so the create payload, built as
 *    `Omit<ReportDefinition, 'id'|'createdAt'|'lastRunAt'>`, would have been
 *    rejected with a 400 the moment anything called it.
 *  - RENAMED: `filters` is `defaultFilters` and `isActive` is `status`, which
 *    is three-valued (`draft` has no boolean).
 *  - FABRICATED: `columns` and `nextRunAt` do not exist on the entity, so any
 *    list UI reading them gets `undefined`. There is no scheduler, which is why
 *    there is no next run: the schedule fields were retired in APA-141.
 *
 * Latent only because `ReportsPage` ships a hardcoded catalogue and never calls
 * the definitions API.
 */
export interface ReportDefinition {
  id: string;
  name: string;
  description?: string;
  type: ReportType;
  defaultFormat: ReportFormat;
  status: ReportDefinitionStatus;
  defaultFilters?: Record<string, unknown>;
  includeCharts: boolean;
  createdBy?: string;
  createdByEmail?: string;
  lastRunAt?: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Exactly the fields `CreateDefinitionDto` whitelists.
 *
 * Declared as its own type rather than an `Omit<ReportDefinition, …>`: a read
 * model minus a few keys is not a write contract, and deriving one from the
 * other is what shipped server-generated fields into a create body under a
 * pipe that rejects unknown keys.
 */
export interface CreateReportDefinitionInput {
  name: string;
  description?: string;
  type: ReportType;
  defaultFormat?: ReportFormat;
  defaultFilters?: Record<string, unknown>;
  includeCharts?: boolean;
}

/** Exactly the fields `UpdateDefinitionDto` whitelists. */
export interface UpdateReportDefinitionInput {
  name?: string;
  description?: string;
  defaultFormat?: ReportFormat;
  status?: ReportDefinitionStatus;
  defaultFilters?: Record<string, unknown>;
  includeCharts?: boolean;
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
  /** The first REPORT_PREVIEW_ROW_LIMIT generated rows, captured at execution
   *  time; absent on executions written before the column existed (APA-144). */
  previewRows?: Array<Record<string, unknown>>;
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

/**
 * `ReportData` used to sit here — `{ columns, rows, summary, generatedAt }` —
 * with no endpoint returning it and no consumer reading it. A report body
 * arrives either as `ReportResult`'s inline `data`/`summary` from
 * `POST /reports/generate`, or as an execution's persisted `previewRows`. The
 * `columns` descriptor in particular was never produced by anything; it is the
 * same invented-field class as the definition's `columns` and `nextRunAt`
 * (APA-150), and an unconsumed type is where the next such invention gets
 * copied from.
 */
