/**
 * Settings API (System Settings, IP Access)
 * and System Settings API (Feature Toggles, Maintenance, Performance, Errors, Jobs)
 *
 * Email Templates -> api/email-templates.ts (emailTemplatesApi)
 *
 */

import { apiFetch } from '../http-client';
import type {
  StandardPaginatedResult,
  PaginationParams,
  DateRangeParams,
  IpAccessRule,
  CreateFeatureToggleInput,
  UpdateFeatureToggleInput,
  MaintenanceWindow,
  PerformanceDashboard,
  PerformanceMetrics,
  ErrorGroup,
  ErrorOccurrence,
  BackgroundJob,
  JobQueue,
  JobStatus,
} from '../types';

// Re-export extracted APIs for barrel convenience
export { emailTemplatesApi } from './email-templates';

import {
  ADMIN_API_ROUTES,
  type AdminApiRouteBody,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';

type FeatureToggleQuery = AdminApiRouteQuery<'GET /system/settings/feature-toggles'>;
type FeatureEvaluationInput = AdminApiRouteBody<'POST /system/settings/feature-toggles/evaluate'>;
type MaintenanceQuery = AdminApiRouteQuery<'GET /system/settings/maintenance'>;
type CreateMaintenanceInput = AdminApiRouteBody<'POST /system/settings/maintenance'>;
type UpdateMaintenanceInput = AdminApiRouteBody<'PUT /system/settings/maintenance/:id'>;
type ErrorGroupsQuery = AdminApiRouteQuery<'GET /system/errors/groups'>;
type UpdateErrorInput = AdminApiRouteBody<'PUT /system/errors/groups/:id'>;
type ResolveErrorInput = AdminApiRouteBody<'POST /system/errors/groups/:id/resolve'>;
type JobsQuery = AdminApiRouteQuery<'GET /system/jobs'>;

export const settingsApi = {
  // System settings live in config-service now (ORPHAN-HIGH-373): the legacy
  // admin-api settings stores are retired — their write endpoints return 410
  // Gone and the reads were static env-backed stubs. Read/write goes through
  // the federated GraphQL operations in graphql/platform-configuration-
  // operations.ts (hooks/usePlatformConfiguration.ts). Only the live SMTP
  // test-send and system-info endpoints remain here.
  testEmailConfig: (to: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /settings/config/email/test'], { body: { to } }),
  getSystemInfo: () => apiFetch(ADMIN_API_ROUTES['GET /settings/system/info']),

  // IP Access Rules
  getIpAccessRules: (
    params?: { tenantId?: string; type?: string; isActive?: boolean } & PaginationParams,
  ) => apiFetch(ADMIN_API_ROUTES['GET /settings/ip-access'], { query: params || {} }),
  getIpAccessRule: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /settings/ip-access/:id'], { path: { id: id } }),
  createIpAccessRule: (data: Omit<IpAccessRule, 'id' | 'hitCount' | 'lastHitAt' | 'createdAt'>) =>
    apiFetch(ADMIN_API_ROUTES['POST /settings/ip-access'], { body: data }),
  updateIpAccessRule: (id: string, data: Partial<IpAccessRule>) =>
    apiFetch(ADMIN_API_ROUTES['PUT /settings/ip-access/:id'], { path: { id: id }, body: data }),
  deleteIpAccessRule: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['DELETE /settings/ip-access/:id'], { path: { id: id } }),
  checkIpAccess: (ip: string, tenantId?: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /settings/ip-access/check'], { body: { ip, tenantId } }),
};

export const systemSettingsApi = {
  // Feature Toggles
  getFeatureToggles: (params: FeatureToggleQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/settings/feature-toggles'], { query: params }),
  getFeatureToggle: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/settings/feature-toggles/:id'], { path: { id: id } }),
  createFeatureToggle: (data: CreateFeatureToggleInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/settings/feature-toggles'], { body: data }),
  updateFeatureToggle: (id: string, data: UpdateFeatureToggleInput) =>
    apiFetch(ADMIN_API_ROUTES['PUT /system/settings/feature-toggles/:id'], {
      path: { id: id },
      body: data,
    }),
  deleteFeatureToggle: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['DELETE /system/settings/feature-toggles/:id'], { path: { id: id } }),
  toggleFeature: (id: string, enabled: boolean) =>
    apiFetch(ADMIN_API_ROUTES['PUT /system/settings/feature-toggles/:id'], {
      path: { id: id },
      body: { status: enabled ? 'enabled' : 'disabled' },
    }),
  evaluateFeature: (key: string, context: FeatureEvaluationInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/settings/feature-toggles/evaluate'], {
      query: { key: key },
      body: context,
    }),

  // Maintenance Mode
  getMaintenanceWindows: (params: MaintenanceQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/settings/maintenance'], { query: params }),
  getMaintenanceWindow: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/settings/maintenance/:id'], { path: { id: id } }),
  createMaintenanceWindow: (data: CreateMaintenanceInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/settings/maintenance'], { body: data }),
  updateMaintenanceWindow: (id: string, data: UpdateMaintenanceInput) =>
    apiFetch(ADMIN_API_ROUTES['PUT /system/settings/maintenance/:id'], {
      path: { id: id },
      body: data,
    }),
  startMaintenance: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/settings/maintenance/:id/start'], { path: { id: id } }),
  endMaintenance: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/settings/maintenance/:id/end'], { path: { id: id } }),
  cancelMaintenance: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/settings/maintenance/:id/cancel'], {
      path: { id: id },
    }),
  extendMaintenance: (id: string, additionalMinutes: number) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/settings/maintenance/:id/extend'], {
      path: { id: id },
      body: { additionalMinutes },
    }),
  checkMaintenanceStatus: (tenantId?: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/settings/maintenance/check'], {
      query: { tenantId: tenantId },
    }),

  // Provisioning Settings
  getProvisioningConfig: () =>
    apiFetch(ADMIN_API_ROUTES['GET /system/settings/provisioning-config']),
  updateProvisioningConfig: (config: Record<string, string>) =>
    apiFetch(ADMIN_API_ROUTES['PUT /system/settings/provisioning-config'], { body: config }),

  // Performance Monitoring
  getPerformanceDashboard: (service?: string, timeRange?: { start: string; end: string }) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/performance/dashboard'], {
      query: { service, ...timeRange },
    }),
  getPerformanceMetrics: (service?: string, timeRange?: { start: string; end: string }) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/performance/application'], {
      query: { service, ...timeRange },
    }),
  getApdexScore: (service?: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/performance/application/apdex'], {
      query: { service: service },
    }),
  getDatabasePerformance: (database?: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/performance/database'], {
      query: { database: database },
    }),
  getSlowQueries: (threshold?: number, limit?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/performance/database/slow-queries'], {
      query: { threshold, limit },
    }),
  getInfrastructureMetrics: (host?: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/performance/infrastructure'], {
      query: { host: host },
    }),

  // Error Tracking
  getErrorDashboard: () =>
    apiFetch(ADMIN_API_ROUTES['GET /system/errors/dashboard'], {
      query: {},
    }),
  getErrorGroups: (params: ErrorGroupsQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/errors/groups'], { query: params }),
  getErrorGroup: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/errors/groups/:id'], { path: { id: id } }),
  getErrorOccurrences: (groupId: string, params?: PaginationParams) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/errors/groups/:groupId/occurrences'], {
      path: { groupId: groupId },
      query: params || {},
    }),
  updateErrorStatus: (
    id: string,
    status: UpdateErrorInput['status'],
    assignedTo?: string,
    notes?: string,
  ) =>
    apiFetch(ADMIN_API_ROUTES['PUT /system/errors/groups/:id'], {
      path: { id: id },
      body: { status, assignedTo, notes },
    }),
  resolveError: (id: string, _resolvedBy: string, notes?: ResolveErrorInput['notes']) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/errors/groups/:id/resolve'], {
      path: { id: id },
      body: { notes },
    }),
  ignoreError: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/errors/groups/:id/ignore'], { path: { id: id } }),

  // Job Queue Management
  getJobDashboard: () => apiFetch(ADMIN_API_ROUTES['GET /system/jobs/dashboard']),
  getQueues: () => apiFetch(ADMIN_API_ROUTES['GET /system/jobs/queues']),
  getQueue: (name: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/jobs/queues/:name'], { path: { name: name } }),
  createQueue: (data: { name: string; concurrency?: number; maxJobsPerSecond?: number }) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/jobs/queues'], { body: data }),
  pauseQueue: (name: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/jobs/queues/:name/pause'], { path: { name: name } }),
  resumeQueue: (name: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/jobs/queues/:name/resume'], { path: { name: name } }),
  getJobs: (params: JobsQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/jobs'], { query: params }),
  getJob: (id: string) => apiFetch(ADMIN_API_ROUTES['GET /system/jobs/:id'], { path: { id: id } }),
  createJob: (data: {
    name: string;
    queueName: string;
    payload?: Record<string, unknown>;
    priority?: number;
    scheduledAt?: string;
    cronExpression?: string;
  }) => apiFetch(ADMIN_API_ROUTES['POST /system/jobs'], { body: data }),
  cancelJob: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/jobs/:id/cancel'], { path: { id: id } }),
  retryJob: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /system/jobs/:id/retry'], { path: { id: id } }),
};
