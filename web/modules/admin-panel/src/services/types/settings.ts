/**
 * Settings domain types (System Settings, Feature Toggles, Maintenance, Performance, Errors, Jobs)
 */

import type { ApiSchema } from '../contract';

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

export type EmailTemplateVariable = ApiSchema<'EmailTemplateVariableDto'>;

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

// ============================================================================
// Feature Toggle Types
// ============================================================================

export type FeatureToggleStatus = 'enabled' | 'disabled' | 'percentage_rollout' | 'scheduled';
export type MaintenanceStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'extended';
/**
 * A queued job, as `GET /system/jobs` returns it, with its status union DERIVED
 * rather than restated. The hand-written union omitted `paused`, which the
 * backend enum has: `JobQueuePage`'s `getStatusBadge` builds an exhaustive
 * `Record<JobStatus, …>`, so a paused job fell through to the `|| 'default'`
 * fallback and rendered as an ordinary queued one. Derived from the contract,
 * omitting a state the API can send is a compile error in that map.
 */
export type BackgroundJob = ApiSchema<'BackgroundJob'>;
export type JobStatus = BackgroundJob['status'];

/**
 * A feature toggle, as `GET /system/feature-toggles` returns it.
 *
 * `scope` is the field that mattered: the hand-written union was
 * `global | tenant | user` while the DTO has a fourth, `environment`. An
 * environment-scoped toggle rendered with the fallback badge, and opening it in
 * the edit form — whose Select offers only three options — could write a
 * different scope back on save (ADMIN-MEDIUM-111).
 */
export type FeatureToggle = ApiSchema<'FeatureToggle'>;

/** The scopes a toggle can actually carry. */
export type FeatureToggleScope = FeatureToggle['scope'];

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

/** One point on a trend series, as `GET /system/performance/dashboard` sends it. */
export interface PerformanceTrendPoint {
  timestamp: string;
  value: number;
}

/**
 * The application half of a snapshot.
 *
 * `null` is NOT MEASURED, which the backend distinguishes from zero
 * (`ApplicationMetrics` in `performance-metric.entity.ts`) — an empty metrics
 * window is not a perfect Apdex of 1.0.
 */
export interface PerformanceApplicationMetrics {
  avgResponseTime: number | null;
  p95ResponseTime: number | null;
  p99ResponseTime: number | null;
  throughput: number | null;
  errorRate: number | null;
  apdexScore: number | null;
  activeRequests: number | null;
  totalRequests: number | null;
}

/** `GET /system/performance/database`. Every field is nullable at the source. */
export interface DatabasePerformance {
  activeConnections: number | null;
  poolSize: number | null;
  poolUtilization: number | null;
  avgQueryTime: number | null;
  slowQueryCount: number | null;
  cacheHitRatio: number | null;
  deadlockCount: number | null;
}

/** `GET /system/performance/infrastructure`. */
export interface InfrastructureMetrics {
  cpuUsage: number;
  memoryUsage: number;
  memoryTotal: number;
  diskUsage: number | null;
  diskTotal: number | null;
  networkLatency: number | null;
  containerCount: number | null;
  healthyContainers: number | null;
  podRestarts: number | null;
}

/**
 * `GET /system/performance/dashboard`, as the endpoint actually answers.
 *
 * The previous declaration described a shape the server has never sent: a flat
 * `currentSnapshot` carrying a `healthScore`. The real response nests the
 * measurements under `currentSnapshot.applicationMetrics` (and sends `null`
 * for the whole snapshot when none has been taken), and carries the score at
 * the TOP level. `PerformanceDashboardPage` bridged the gap with a pair of
 * `as Record<string, unknown>` casts and a `?? 100` — so a platform with no
 * snapshot at all reported perfect health (ADMIN-HIGH-123). A type that
 * matches the endpoint needs no cast and leaves nowhere to put the 100.
 */
export interface PerformanceDashboard {
  currentSnapshot: {
    id: string;
    service?: string;
    timestamp: string;
    applicationMetrics: PerformanceApplicationMetrics;
    databaseMetrics: DatabasePerformance;
    infrastructureMetrics: InfrastructureMetrics;
    overallHealthScore?: number | null;
  } | null;
  /** Recomputed per request from the current snapshot and the live alerts. */
  healthScore: number | null;
  trends: {
    responseTime: PerformanceTrendPoint[];
    throughput: PerformanceTrendPoint[];
    errorRate: PerformanceTrendPoint[];
    cpuUsage: PerformanceTrendPoint[];
    memoryUsage: PerformanceTrendPoint[];
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

export type ErrorGroup = ApiSchema<'ErrorGroup'>;

export type ErrorOccurrence = ApiSchema<'ErrorOccurrence'>;


/**
 * A job queue, as `GET /system/jobs/queues` returns it.
 *
 * The hand-written copy called the in-flight count `activeCount`; the DTO calls
 * it `runningCount`. `JobQueuePage` renders it under a label that literally
 * reads "Running", so every queue card showed a blank there (ADMIN-MEDIUM-111).
 */
export type JobQueue = ApiSchema<'JobQueue'>;
