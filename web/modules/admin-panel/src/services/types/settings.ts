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

export interface MaintenanceWindow {
  id: string;
  title: string;
  description: string;
  scope: 'global' | 'tenant' | 'service' | 'region';
  type: 'scheduled' | 'emergency' | 'rolling_update' | 'database_migration' | 'security_patch';
  status: MaintenanceStatus;
  tenantId?: string;
  affectedTenants?: string[];
  affectedServices?: Array<{
    name: string;
    status: 'unavailable' | 'degraded' | 'read_only';
    message?: string;
  }>;
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

/** Exact JSON body accepted by CreateMaintenanceDto. */
export interface CreateMaintenanceWindowInput {
  title: string;
  description: string;
  scope?: MaintenanceWindow['scope'];
  type?: MaintenanceWindow['type'];
  tenantId?: string;
  affectedTenants?: string[];
  affectedServices?: MaintenanceWindow['affectedServices'];
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

export interface JobDashboard {
  totalJobs: number;
  pendingJobs: number;
  runningJobs: number;
  completedToday: number;
  failedToday: number;
  avgDuration: number;
  queues: readonly JobQueue[];
  recentJobs: readonly BackgroundJob[];
}
