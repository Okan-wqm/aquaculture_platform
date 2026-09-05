/**
 * Settings domain types (System Settings, Feature Toggles, Maintenance, Performance, Errors, Jobs)
 */

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

export interface EmailTemplateVariable {
  name: string;
  description: string;
  required: boolean;
  defaultValue?: string;
}

export interface EmailTemplate {
  id: string;
  code: string;
  name: string;
  description?: string;
  category: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  variables: EmailTemplateVariable[];
  isActive: boolean;
  isSystem: boolean;
  tenantId?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface IpAccessRule {
  id: string;
  tenantId?: string;
  ruleType: 'whitelist' | 'blacklist';
  ipAddress: string;
  description?: string;
  isActive: boolean;
  expiresAt?: string;
  hitCount: number;
  lastHitAt?: string;
  createdBy?: string;
  createdAt: string;
}

// ============================================================================
// Feature Toggle Types
// ============================================================================

export type FeatureToggleStatus = 'enabled' | 'disabled' | 'percentage_rollout' | 'scheduled';
export type MaintenanceStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'extended';
export type JobStatus = 'pending' | 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retrying';

export interface FeatureToggle {
  id: string;
  key: string;
  name: string;
  description?: string;
  status: FeatureToggleStatus;
  scope: 'global' | 'tenant' | 'user';
  category?: string;
  rolloutPercentage: number;
  enabledTenants?: string[];
  disabledTenants?: string[];
  conditions?: Array<{ type: string; operator: string; value: unknown }>;
  variants?: Array<{ key: string; value: unknown; weight: number }>;
  isExperimental: boolean;
  deprecatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A maintenance window, as `GET /system/settings/maintenance` returns it.
 *
 * Arbitrated against the `MaintenanceMode` entity
 * (`apps/admin-api-service/src/system-management/entities/maintenance-mode.entity.ts`).
 * This declaration had drifted from that entity on five points while
 * `MaintenancePage` carried its own, more accurate, shadow copy of the same
 * name — the two disagreed, and the page's double type assertion onto
 * `MaintenanceWindow[]` was what stopped the compiler from saying so.
 * `MaintenanceScope` includes `region`, `MaintenanceType` has five members
 * rather than three, and `estimatedDurationMinutes`, `affectedTenants`,
 * `affectedRegions`, `internalNotes` and `updatedAt` are real columns this
 * type simply omitted. `createdBy` is nullable on the entity.
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
 * Exactly the fields `CreateMaintenanceDto`
 * (`apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts`)
 * whitelists.
 *
 * Declared in its own right rather than as `Omit<MaintenanceWindow, …>`: a read
 * model minus a few keys is not a write contract, and under the platform's
 * `forbidNonWhitelisted: true` pipe every server-owned field the omission did
 * not happen to name is a 400.
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

export interface PerformanceMetrics {
  service: string;
  avgResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  throughput: number;
  errorRate: number;
  apdexScore: number;
  timestamp: string;
}

export interface PerformanceDashboard {
  currentSnapshot: {
    healthScore: number;
    avgResponseTime: number;
    errorRate: number;
    throughput: number;
    apdexScore: number;
  };
  trends: {
    responseTime: Array<{ timestamp: string; value: number }>;
    throughput: Array<{ timestamp: string; value: number }>;
    errorRate: Array<{ timestamp: string; value: number }>;
  };
  serviceBreakdown: Array<{
    service: string;
    avgResponseTime: number;
    errorRate: number;
    requestCount: number;
  }>;
  alerts: Array<{
    metric: string;
    threshold: number;
    currentValue: number;
    severity: 'warning' | 'critical';
  }>;
}

export interface ErrorGroup {
  id: string;
  fingerprint: string;
  message: string;
  errorType?: string;
  service?: string;
  severity: 'debug' | 'info' | 'warning' | 'error' | 'critical' | 'fatal';
  status: 'new' | 'acknowledged' | 'in_progress' | 'resolved' | 'ignored';
  occurrenceCount: number;
  userCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  assignedTo?: string;
  isRegression: boolean;
}

export interface ErrorOccurrence {
  id: string;
  groupId: string;
  message: string;
  stackTrace?: string;
  context?: Record<string, unknown>;
  tenantId?: string;
  userId?: string;
  timestamp: string;
}

export interface BackgroundJob {
  id: string;
  name: string;
  queueName: string;
  jobType: 'immediate' | 'scheduled' | 'recurring' | 'delayed';
  status: JobStatus;
  priority: number;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorMessage?: string;
  progress?: { current: number; total: number; percentage: number; message?: string };
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  attempts: number;
  maxAttempts: number;
  cronExpression?: string;
  nextRunAt?: string;
  createdAt: string;
}

export interface JobQueue {
  name: string;
  isPaused: boolean;
  concurrency: number;
  pendingCount: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
}
