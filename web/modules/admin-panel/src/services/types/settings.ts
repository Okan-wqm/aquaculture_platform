/**
 * Settings domain types (System Settings, Feature Toggles, Maintenance, Performance, Errors, Jobs)
 */

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
import type {
  EmailTemplateVariable,
  EmailTemplate,
  IpAccessRule,
  MaintenanceStatus,
} from './generated/admin-contracts';

export type {
  EmailTemplateVariable,
  EmailTemplate,
  IpAccessRule,
  MaintenanceStatus,
};

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
// Imported so shapes below can reference them; re-exported so import sites
// are unchanged.
import type {
  JobQueue,
  JobQueueStats,
  JobExecutionLog,
  JobDashboardDto,
  JobQueueSummaryDto,
  RetriedJobsResult,
  PurgedJobsResult,
  PerformanceDashboard,
  ApplicationMetrics,
  DatabasePerformanceMetrics,
  InfrastructureMetrics,
  MetricThreshold,
  SlowQueryAggregate,
  ServiceBreakdown,
  ThresholdBreach,
  MetricHistoryPoint,
  ApdexScoreResult,
  JobStatus,
  BackgroundJob,
  ErrorGroup,
  ErrorOccurrence,
  FeatureToggleScope,
  FeatureToggleStatus,
  FeatureToggle,
} from './generated/admin-contracts';

// The vocabularies are VALUES as well as types — dropdowns derive their
// options from these rather than re-listing the members by hand.
export {
  JOB_STATUS_VALUES,
  FEATURE_TOGGLE_SCOPE_VALUES,
  FEATURE_TOGGLE_STATUS_VALUES,
} from './generated/admin-contracts';

export type {
  JobStatus,
  BackgroundJob,
  ErrorGroup,
  ErrorOccurrence,
  FeatureToggleScope,
  FeatureToggleStatus,
  FeatureToggle,
};

// ============================================================================
// System Settings Types
// ============================================================================

export interface SystemSetting {
  key: string;
  value: string | number | boolean | Record<string, unknown>;
  category: string;
  description: string;
  isEncrypted?: boolean;
  isReadOnly?: boolean;
  validationRules?: Record<string, unknown>;
  updatedAt: string;
  updatedBy?: string;
}

export interface TenantConfiguration {
  tenantId: string;
  configuration: Record<string, unknown>;
  branding?: {
    logo?: string;
    primaryColor?: string;
    secondaryColor?: string;
    favicon?: string;
    customCss?: string;
  };
  integrations?: Array<{
    type: string;
    isEnabled: boolean;
    config: Record<string, unknown>;
  }>;
  apiKeys?: Array<{
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    lastUsedAt?: string;
    expiresAt?: string;
  }>;
  webhooks?: Array<{
    id: string;
    url: string;
    events: string[];
    isActive: boolean;
    secretHash?: string;
  }>;
  updatedAt: string;
}

/**
 * A maintenance window, as `GET /system/settings/maintenance` returns it.
 *
 * Corrected against `MaintenanceMode` (APA-106's slice). This declaration had
 * drifted from the entity on four points while `MaintenancePage` carried its
 * own, more accurate, shadow copy — the two disagreed, and an
 * page's double type assertion onto `MaintenanceWindow[]` was what stopped
 * the compiler from saying so. The entity's enums are the arbiter: `scope` includes
 * `region`, `type` has five members rather than three, and
 * `estimatedDurationMinutes`, `affectedTenants` and `updatedAt` are real
 * columns this type simply omitted.
 */
export interface MaintenanceWindow {
  id: string;
  title: string;
  description: string;
  scope: 'global' | 'tenant' | 'service' | 'region';
  type: 'scheduled' | 'emergency' | 'rolling_update' | 'database_migration' | 'security_patch';
  status: MaintenanceStatus;
  tenantId?: string;
  affectedTenants?: string[];
  affectedServices?: Array<{ name: string; status: string }>;
  affectedRegions?: string[];
  scheduledStart: string;
  scheduledEnd?: string;
  actualStart?: string;
  actualEnd?: string;
  estimatedDurationMinutes: number;
  userMessage?: string;
  internalNotes?: string;
  allowReadOnlyAccess: boolean;
  bypassForSuperAdmins: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Exactly the fields `CreateMaintenanceDto` whitelists.
 *
 * Declared in its own right rather than as `Omit<MaintenanceWindow, …>`: a read
 * model minus a few keys is not a write contract, and under the platform's
 * `forbidNonWhitelisted: true` pipe every server-owned field the omission did
 * not happen to name is a 400. `createdBy` in particular is derived from the
 * verified JWT and is rejected as a body field (APA-266).
 */
export interface CreateMaintenanceWindowInput {
  title: string;
  description: string;
  scope?: MaintenanceWindow['scope'];
  type?: MaintenanceWindow['type'];
  tenantId?: string;
  affectedTenants?: string[];
  affectedServices?: Array<{
    name: string;
    status: 'unavailable' | 'degraded' | 'read_only';
    message?: string;
  }>;
  scheduledStart: string;
  scheduledEnd?: string;
  estimatedDurationMinutes?: number;
  userMessage?: string;
  allowReadOnlyAccess?: boolean;
  bypassForSuperAdmins?: boolean;
  whitelistedIPs?: string[];
}

/**
 * What `POST /system/settings/feature-toggles` accepts.
 *
 * Declared against `CreateFeatureToggleDto`, NOT as `Omit<FeatureToggle, …>`.
 * Deriving a write payload from a read model is the APA-150 anti-pattern: under
 * `forbidNonWhitelisted` every server-owned field the omission did not happen
 * to name is a 400, and it simultaneously demands fields the DTO never asked
 * for — `requiresRestart`, which the create form has no reason to send.
 */
/**
 * The system-management read contracts, GENERATED.
 *
 * The hand-written `PerformanceDashboard` declared `currentSnapshot` as a flat
 * five-field object against a backend `PerformanceSnapshot | null` — so the page
 * read `currentSnapshot.healthScore` on a value that is null whenever no
 * snapshot has been taken. `PerformanceMetrics` and `JobDashboard` were the same
 * class of hand copy.
 */
export type {
  JobQueue,
  JobQueueStats,
  JobExecutionLog,
  JobDashboardDto,
  JobQueueSummaryDto,
  RetriedJobsResult,
  PurgedJobsResult,
  PerformanceDashboard,
  ApplicationMetrics,
  DatabasePerformanceMetrics,
  InfrastructureMetrics,
  MetricThreshold,
  SlowQueryAggregate,
  ServiceBreakdown,
  ThresholdBreach,
  MetricHistoryPoint,
  ApdexScoreResult,
};

/** The panel's historical name for the job dashboard contract. */
export type JobDashboard = JobDashboardDto;

/** The panel's historical name for a service's application-level metrics. */
export type PerformanceMetrics = ApplicationMetrics;

export interface CreateFeatureToggleInput {
  key: string;
  name: string;
  description?: string;
  scope?: FeatureToggleScope;
  status?: FeatureToggleStatus;
  category?: string;
  rolloutPercentage?: number;
  defaultValue?: unknown;
  isExperimental?: boolean;
  requiresRestart?: boolean;
}
