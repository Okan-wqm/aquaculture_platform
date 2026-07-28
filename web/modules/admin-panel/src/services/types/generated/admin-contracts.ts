/**
 * GENERATED — DO NOT EDIT.
 *
 * Produced by `npm run codegen:admin-contracts` from the backend types named
 * in `tools/codegen/admin-contracts/manifest.ts`.
 *
 * These are WIRE shapes: what arrives at `JSON.parse`, not what the backend
 * holds in memory. `Date` is `string`, optional keys are absent rather than
 * `undefined`, and enums are unions of their serialized values.
 *
 * Editing this file by hand re-creates the problem it exists to remove: a
 * frontend copy of a contract that can drift from its owner. Change the
 * backend type and regenerate. CI runs `codegen:admin-contracts:check`.
 */

// ==========================================================================
// analytics
// ==========================================================================

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface TenantMetrics {
  total: number;
  active: number;
  inactive: number;
  trial: number;
  suspended: number;
  newThisMonth: number;
  churnedThisMonth: null | number;
  churnRate: null | number;
  growthRate: null | number;
  byPlan: Record<string, number>;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
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

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface FinancialMetrics {
  mrr: number;
  arr: number;
  arpu: number;
  arppu: number;
  ltv: number;
  totalRevenue: number;
  revenueThisMonth: number;
  revenueGrowthRate: null | number;
  pendingPayments: number;
  overduePayments: number;
  refunds: number;
  byPlan: Record<string, number>;
  byCurrency: Record<string, number>;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface AnalyticsSystemMetrics {
  totalStorageBytes: null | number;
  usedStorageBytes: null | number;
  storageUtilization: null | number;
  apiCallsToday: null | number;
  apiCallsThisMonth: null | number;
  avgResponseTimeMs: null | number;
  errorRate: null | number;
  uptimePercent: null | number;
  activeConnections: null | number;
  queuedJobs: null | number;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface UsageMetrics {
  moduleUsage: {
    dashboard?: ModuleUsageStats;
    farm_management?: ModuleUsageStats;
    sensor_monitoring?: ModuleUsageStats;
    alerts?: ModuleUsageStats;
    reports?: ModuleUsageStats;
    hr_module?: ModuleUsageStats;
    billing?: ModuleUsageStats;
  };
  featureAdoption: Record<string, number>;
  topFeatures: Array<{
    feature: string;
    usage: number;
  }>;
  peakHours: number[];
  avgDailyActiveUsers: number;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    backgroundColor?: string | string[];
    borderColor?: string;
  }>;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface TimeSeriesPoint {
  date: string;
  value: null | number;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface TimeSeriesData {
  label: string;
  data: TimeSeriesPoint[];
  color?: string;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface TimeSeriesResponse {
  range: "7d" | "30d" | "90d" | "1y";
  granularity: "day" | "week" | "month";
  data: TimeSeriesPoint[];
  source: string;
  asOf: string;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface DashboardSummary {
  tenants: TenantMetrics;
  users: UserMetrics;
  financial: FinancialMetrics;
  system: AnalyticsSystemMetrics;
  usage: UsageMetrics;
  generatedAt: string;
  unavailable?: string[];
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export type ReportType = "tenant_overview" | "tenant_churn" | "financial_revenue" | "financial_payments" | "usage_modules" | "usage_features" | "system_performance";

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export type ReportFormat = "json" | "csv" | "pdf";

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export type ReportExecutionStatus = "pending" | "running" | "completed" | "failed" | "unavailable";

/** @see apps/admin-api-service/src/analytics/services/analytics.service.ts */
export interface ComparisonDto {
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  trend: "up" | "down" | "stable";
}

// ==========================================================================
// shared
// ==========================================================================

/** @see transitive */
export interface ModuleUsageStats {
  activeUsers: number;
  totalSessions: number;
  avgSessionDuration: number;
}

/** @see transitive */
export interface ImpersonationPermissions {
  canViewData: boolean;
  canModifyData: boolean;
  canAccessSettings: boolean;
  canManageUsers: boolean;
  canViewBilling: boolean;
  canExportData: boolean;
  restrictedModules?: string[];
  allowedModules?: string[];
}

/** @see transitive */
export interface ImpersonationAction {
  action: string;
  resource: string;
  resourceId?: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

/** @see transitive */
export interface SafeImpersonationSession {
  id: string;
  superAdminId: string;
  superAdminEmail?: string;
  targetTenantId: string;
  targetTenantName?: string;
  targetUserId?: string;
  targetUserEmail?: string;
  status: "active" | "ended" | "expired" | "terminated";
  reason: "support_request" | "debugging" | "configuration" | "onboarding_assistance" | "security_investigation" | "data_verification" | "other";
  reasonDetails?: string;
  ticketReference?: string;
  permissions?: ImpersonationPermissions;
  ipAddress?: string;
  userAgent?: string;
  mfaCompleted: boolean;
  expiresAt: string;
  endedAt?: string;
  endReason?: string;
  actionsPerformed?: ImpersonationAction[];
  actionCount: number;
  accessedResources?: Array<{
    type: string;
    id: string;
    action: string;
    timestamp: string;
  }>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** @see transitive */
export interface JobProgress {
  current: number;
  total: number;
  percentage: number;
  message?: string;
  checkpoint?: unknown;
}

/** @see transitive */
export interface JobRetryPolicy {
  maxRetries: number;
  retryDelay: number;
  exponentialBackoff: boolean;
  backoffMultiplier?: number;
  maxDelay?: number;
}

/** @see transitive */
export interface StackFrame {
  filename: string;
  function: string;
  lineno: number;
  colno?: number;
  context?: string[];
  inApp?: false | true;
}

/** @see transitive */
export interface ErrorContext {
  user?: {
    id: string;
    email?: string;
    tenantId?: string;
  };
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    queryParams?: Record<string, string>;
  };
  response?: {
    statusCode: number;
    body?: unknown;
  };
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  breadcrumbs?: Array<{
    type: string;
    category: string;
    message: string;
    timestamp: string;
    data?: Record<string, unknown>;
  }>;
}

/** @see transitive */
export interface FeatureCondition {
  type: "tenant_id" | "user_role" | "plan_type" | "region" | "custom";
  operator: "equals" | "not_equals" | "contains" | "in" | "not_in" | "regex";
  value: string | string[];
}

/** @see transitive */
export interface RolloutSchedule {
  startDate: string;
  endDate?: string;
  percentage: number;
  targetPercentage?: number;
  incrementPerDay?: number;
}

// ==========================================================================
// impersonation
// ==========================================================================

/** @see apps/admin-api-service/src/impersonation/services/impersonation.service.ts */
export interface ImpersonationAuditSummary {
  windowStart: string;
  windowEnd: string;
  totalSessionsInWindow: number;
  actionsLoggedInWindow: number;
  sessionsByReasonInWindow: {
    support_request: number;
    debugging: number;
    configuration: number;
    onboarding_assistance: number;
    security_investigation: number;
    data_verification: number;
    other: number;
  };
  topImpersonatorsInWindow: Array<{
    adminId: string;
    email: string;
    sessionCount: number;
  }>;
  topTargetTenantsInWindow: Array<{
    tenantId: string;
    tenantName: string;
    sessionCount: number;
  }>;
  recentSessionsInWindow: SafeImpersonationSession[];
  activeSessionsNow: number;
  activePermissionsNow: number;
}

// ==========================================================================
// security
// ==========================================================================

/** @see apps/admin-api-service/src/security/services/compliance.service.ts */
export interface ComplianceRequirement {
  id: string;
  framework: "gdpr" | "ccpa" | "hipaa" | "pci_dss" | "sox" | "iso27001";
  requirement: string;
  description: string;
  category: string;
  isMandatory: boolean;
  verificationMethod: string;
}

/** @see apps/admin-api-service/src/security/services/compliance.service.ts */
export interface ComplianceCheckResult {
  checkedAt: string;
  requirement: ComplianceRequirement;
  status: "compliant" | "non_compliant" | "partial" | "not_applicable";
  details: string;
  evidence?: string;
  remediation?: string;
}

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type ComplianceType = "gdpr" | "ccpa" | "hipaa" | "pci_dss" | "sox" | "iso27001";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type DataRequestStatus = "pending" | "completed" | "in_progress" | "expired" | "rejected";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type DataRequestType = "access" | "deletion" | "portability" | "rectification" | "restriction";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type SecurityEventStatus = "detected" | "investigating" | "confirmed" | "mitigated" | "false_positive" | "escalated";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type SecurityEventType = "failed_login" | "brute_force_attempt" | "suspicious_activity" | "unauthorized_access" | "privilege_escalation" | "data_exfiltration" | "malware_detected" | "api_abuse" | "rate_limit_exceeded" | "sql_injection_attempt" | "xss_attempt" | "csrf_attempt" | "account_lockout" | "password_spray" | "credential_stuffing" | "session_hijacking" | "ip_blacklisted" | "geo_anomaly" | "device_anomaly" | "time_anomaly";

// ==========================================================================
// database
// ==========================================================================

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export type BackupStatus = "pending" | "completed" | "failed" | "in_progress" | "expired";

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export type BackupType = "full" | "incremental" | "differential";

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export type MigrationStatus = "pending" | "running" | "completed" | "failed" | "rolled_back";

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export type SchemaStatus = "creating" | "active" | "migrating" | "suspended" | "pending_deletion" | "deleted";

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export interface SchemaMigration {
  id: string;
  tenantId: null | string;
  schemaName: string;
  migrationName: string;
  version: string;
  status: "pending" | "running" | "completed" | "failed" | "rolled_back";
  upScript: string;
  downScript: string;
  errorMessage: string;
  executionTimeMs: number;
  isDryRun: boolean;
  affectedTables: string[];
  executedBy: string;
  startedAt: string;
  completedAt: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export interface TenantSchema {
  id: string;
  tenantId: string;
  schemaName: string;
  status: "creating" | "active" | "migrating" | "suspended" | "pending_deletion" | "deleted";
  currentVersion: string;
  sizeBytes: number;
  tableCount: number;
  connectionCount: number;
  maxConnections: number;
  metadata: Record<string, unknown>;
  lastMigrationAt: string;
  lastBackupAt: string;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export interface DatabaseBackup {
  id: string;
  tenantId: null | string;
  schemaName: string;
  backupType: "full" | "incremental" | "differential";
  status: "pending" | "completed" | "failed" | "in_progress" | "expired";
  filePath: string;
  fileName: string;
  sizeBytes: number;
  checksum: string;
  isEncrypted: boolean;
  isCompressed: boolean;
  retentionDays: number;
  errorMessage: string;
  metadata: {
    tableCount?: number;
    rowCount?: number;
    version?: string;
    compressionRatio?: number;
    encryptionAlgorithm?: string;
    encryptionKeyId?: string;
  };
  startedAt: string;
  completedAt: string;
  expiresAt: string;
  createdAt: string;
}

// ==========================================================================
// debug
// ==========================================================================

/** @see apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts */
export const DEBUG_SESSION_TYPE_VALUES = ["query_inspection", "api_log_viewing", "cache_inspection", "feature_flag_override", "performance_profiling", "error_debugging"] as const;
export type DebugSessionType = (typeof DEBUG_SESSION_TYPE_VALUES)[number];

/** @see apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts */
export interface DebugSession {
  id: string;
  adminId: string;
  tenantId: string;
  sessionType: "query_inspection" | "api_log_viewing" | "cache_inspection" | "feature_flag_override" | "performance_profiling" | "error_debugging";
  isActive: boolean;
  configuration?: Record<string, unknown>;
  filters?: {
    startTime?: string;
    endTime?: string;
    queryTypes?: Array<"select" | "insert" | "update" | "delete" | "transaction" | "schema">;
    apiEndpoints?: string[];
    cacheKeys?: string[];
    minDuration?: number;
    includeErrors?: false | true;
    userId?: string;
  };
  maxResults: number;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/** @see apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts */
export interface CapturedQuery {
  id: string;
  debugSessionId?: string;
  tenantId: string;
  userId?: string;
  queryType: "select" | "insert" | "update" | "delete" | "transaction" | "schema";
  query: string;
  parameters?: unknown[];
  normalizedQuery?: string;
  durationMs: number;
  rowsAffected?: number;
  rowsReturned?: number;
  tableName?: string;
  explainPlan?: Record<string, unknown>;
  isSlowQuery: boolean;
  hasError: boolean;
  errorMessage?: string;
  stackTrace?: string;
  connectionSource?: string;
  timestamp: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts */
export interface CapturedApiCall {
  id: string;
  debugSessionId?: string;
  tenantId: string;
  userId?: string;
  method: string;
  endpoint: string;
  fullUrl?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  queryParams?: Record<string, string>;
  responseStatus: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  durationMs: number;
  clientIp?: string;
  userAgent?: string;
  correlationId?: string;
  hasError: boolean;
  errorMessage?: string;
  timestamp: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts */
export interface FeatureFlagOverride {
  id: string;
  tenantId: string;
  featureKey: string;
  originalValue: unknown;
  overrideValue: unknown;
  isActive: boolean;
  adminId: string;
  reason?: string;
  expiresAt?: string;
  appliedAt?: string;
  revertedAt?: string;
  revertedBy?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ==========================================================================
// tenant
// ==========================================================================

/** @see apps/admin-api-service/src/tenant/entities/tenant-activity.entity.ts */
export interface TenantActivity {
  id: string;
  tenantId: string;
  activityType: "created" | "activated" | "suspended" | "deactivated" | "plan_changed" | "limits_updated" | "module_assigned" | "module_removed" | "user_added" | "user_removed" | "settings_updated" | "payment_received" | "payment_failed" | "trial_started" | "trial_expired" | "contact_updated" | "domain_changed";
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  performedBy?: string;
  performedByEmail?: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/tenant/entities/tenant-activity.entity.ts */
export interface TenantNote {
  id: string;
  tenantId: string;
  content: string;
  category: string;
  isPinned: boolean;
  createdBy: string;
  createdByEmail?: string;
  createdAt: string;
  updatedAt: string;
}

// ==========================================================================
// support
// ==========================================================================

/** @see apps/admin-api-service/src/support/entities/support.entity.ts */
export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  order: number;
  isRequired: boolean;
  estimatedMinutes: number;
  resourceUrl?: string;
  videoUrl?: string;
}

// ==========================================================================
// audit
// ==========================================================================

/** @see apps/admin-api-service/src/audit/audit.entity.ts */
export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId?: string;
  tenantId?: string;
  performedBy: string;
  performedByEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  severity: "info" | "warning" | "critical";
  requestId?: string;
  sessionId?: string;
  createdAt: string;
  legalHold: boolean;
}

/** @see apps/admin-api-service/src/audit/audit.entity.ts */
export const AUDIT_SEVERITY_VALUES = ["info", "warning", "critical"] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITY_VALUES)[number];

// ==========================================================================
// settings
// ==========================================================================

/** @see apps/admin-api-service/src/system-management/entities/job-queue.entity.ts */
export const JOB_STATUS_VALUES = ["pending", "scheduled", "running", "completed", "failed", "cancelled", "retrying", "paused"] as const;
export type JobStatus = (typeof JOB_STATUS_VALUES)[number];

/** @see apps/admin-api-service/src/system-management/entities/job-queue.entity.ts */
export interface BackgroundJob {
  id: string;
  name: string;
  queueName: string;
  jobType: "scheduled" | "immediate" | "recurring" | "delayed" | "triggered";
  status: "pending" | "scheduled" | "running" | "completed" | "failed" | "cancelled" | "retrying" | "paused";
  priority: number;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorMessage?: string;
  stackTrace?: string;
  progress?: JobProgress;
  tenantId?: string;
  userId?: string;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  attempts: number;
  maxAttempts: number;
  retryPolicy?: JobRetryPolicy;
  nextRetryAt?: string;
  cronExpression?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  timeoutMs: number;
  dependencies?: string[];
  parentJobId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  workerId?: string;
  isRecurring: boolean;
  isPaused: boolean;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/system-management/entities/error-tracking.entity.ts */
export interface ErrorGroup {
  id: string;
  fingerprint: string;
  severity: "debug" | "info" | "warning" | "error" | "critical" | "fatal";
  status: "new" | "acknowledged" | "in_progress" | "resolved" | "ignored" | "recurring";
  message: string;
  errorType?: string;
  service?: string;
  culprit?: string;
  occurrenceCount: number;
  userCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  affectedTenants?: string[];
  affectedReleases?: string[];
  tags?: Record<string, string[]>;
  assignedTo?: string;
  notes?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNotes?: string;
  linkedTicketUrl?: string;
  isRegression: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/system-management/entities/error-tracking.entity.ts */
export interface ErrorOccurrence {
  id: string;
  groupId: string;
  fingerprint: string;
  severity: "debug" | "info" | "warning" | "error" | "critical" | "fatal";
  message: string;
  errorType?: string;
  stackTrace?: string;
  stackFrames?: StackFrame[];
  context?: ErrorContext;
  service?: string;
  environment?: string;
  release?: string;
  tenantId?: string;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/system-management/entities/feature-toggle.entity.ts */
export const FEATURE_TOGGLE_SCOPE_VALUES = ["global", "tenant", "user", "environment"] as const;
export type FeatureToggleScope = (typeof FEATURE_TOGGLE_SCOPE_VALUES)[number];

/** @see apps/admin-api-service/src/system-management/entities/feature-toggle.entity.ts */
export const FEATURE_TOGGLE_STATUS_VALUES = ["enabled", "disabled", "percentage_rollout", "scheduled"] as const;
export type FeatureToggleStatus = (typeof FEATURE_TOGGLE_STATUS_VALUES)[number];

/** @see apps/admin-api-service/src/system-management/entities/feature-toggle.entity.ts */
export interface FeatureToggle {
  id: string;
  key: string;
  name: string;
  description?: string;
  scope: "global" | "tenant" | "user" | "environment";
  status: "enabled" | "disabled" | "percentage_rollout" | "scheduled";
  category?: string;
  conditions?: FeatureCondition[];
  rolloutPercentage: number;
  rolloutSchedule?: RolloutSchedule;
  enabledTenants?: string[];
  disabledTenants?: string[];
  metadata?: Record<string, unknown>;
  defaultValue?: unknown;
  variants?: Array<{
    key: string;
    value: unknown;
    weight: number;
    description?: string;
  }>;
  requiresRestart: boolean;
  isExperimental: boolean;
  deprecatedAt?: string;
  deprecationMessage?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}
