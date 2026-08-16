/**
 * Settings API (System Settings, IP Access)
 * and System Settings API (Feature Toggles, Maintenance, Performance, Errors, Jobs)
 *
 * Tenant Config  -> api/tenant-config.ts  (tenantConfigApi)
 * Email Templates -> api/email-templates.ts (emailTemplatesApi)
 *
 * settingsApi still re-exports their methods for backward compatibility.
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  DateRangeParams,
  IpAccessRule,
  FeatureToggle,
  CreateMaintenanceWindowInput,
  MaintenanceWindow,
  PerformanceDashboard,
  PerformanceMetrics,
  ErrorGroup,
  ErrorOccurrence,
  BackgroundJob,
  JobQueue,
  JobDashboard,
  JobStatus,
} from '../types';

// Re-export extracted APIs for barrel convenience
export { tenantConfigApi } from './tenant-config';
export { emailTemplatesApi } from './email-templates';

// Import extracted APIs for backward-compatible delegation
import { tenantConfigApi } from './tenant-config';
import { emailTemplatesApi } from './email-templates';

export const settingsApi = {
  // System settings live in config-service now (ORPHAN-HIGH-373): the legacy
  // admin-api settings stores are retired — their write endpoints return 410
  // Gone and the reads were static env-backed stubs. Read/write goes through
  // the federated GraphQL operations in graphql/platform-configuration-
  // operations.ts (hooks/usePlatformConfiguration.ts). Only the live SMTP
  // test-send and system-info endpoints remain here.
  testEmailConfig: (to: string) =>
    apiFetch<Record<string, unknown>>('/settings/config/email/test', {
      method: 'POST',
      body: JSON.stringify({ to }),
    }),
  getSystemInfo: () => apiFetch<Record<string, unknown>>('/settings/system/info'),

  // Tenant Configuration (delegated to tenant-config.ts, kept here for backward compat)
  getTenantConfig: tenantConfigApi.getTenantConfig,
  updateTenantConfig: tenantConfigApi.updateTenantConfig,
  createTenantApiKey: tenantConfigApi.createTenantApiKey,
  revokeTenantApiKey: tenantConfigApi.revokeTenantApiKey,
  createWebhook: tenantConfigApi.createWebhook,
  deleteWebhook: tenantConfigApi.deleteWebhook,
  testWebhook: tenantConfigApi.testWebhook,

  // Email Templates (delegated to email-templates.ts, kept here for backward compat)
  getEmailTemplates: emailTemplatesApi.getEmailTemplates,
  getEmailTemplate: emailTemplatesApi.getEmailTemplate,
  getEmailTemplateByCode: emailTemplatesApi.getEmailTemplateByCode,
  createEmailTemplate: emailTemplatesApi.createEmailTemplate,
  updateEmailTemplate: emailTemplatesApi.updateEmailTemplate,
  deleteEmailTemplate: emailTemplatesApi.deleteEmailTemplate,
  previewEmailTemplate: emailTemplatesApi.previewEmailTemplate,
  sendTestEmail: emailTemplatesApi.sendTestEmail,

  // IP Access Rules
  getIpAccessRules: (params?: { tenantId?: string; type?: string; isActive?: boolean } & PaginationParams) =>
    apiFetch<PaginatedResult<IpAccessRule>>(`/settings/ip-access?${buildQueryString(params || {})}`),
  getIpAccessRule: (id: string) => apiFetch<IpAccessRule>(`/settings/ip-access/${id}`),
  createIpAccessRule: (data: Omit<IpAccessRule, 'id' | 'hitCount' | 'lastHitAt' | 'createdAt'>) =>
    apiFetch<IpAccessRule>('/settings/ip-access', { method: 'POST', body: JSON.stringify(data) }),
  updateIpAccessRule: (id: string, data: Partial<IpAccessRule>) =>
    apiFetch<IpAccessRule>(`/settings/ip-access/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteIpAccessRule: (id: string) =>
    apiFetch<void>(`/settings/ip-access/${id}`, { method: 'DELETE' }),
  checkIpAccess: (ip: string, tenantId?: string) =>
    apiFetch<{ allowed: boolean; matchedRule?: IpAccessRule }>('/settings/ip-access/check', { method: 'POST', body: JSON.stringify({ ip, tenantId }) }),
};

export const systemSettingsApi = {
  // Feature Toggles
  getFeatureToggles: (params?: { scope?: string; status?: string; category?: string; search?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<FeatureToggle>>(`/system/settings/feature-toggles?${buildQueryString(params || {})}`),
  getFeatureToggle: (id: string) => apiFetch<FeatureToggle>(`/system/settings/feature-toggles/${id}`),
  getFeatureToggleByKey: (key: string) => apiFetch<FeatureToggle>(`/system/settings/feature-toggles/key/${key}`),
  createFeatureToggle: (data: Omit<FeatureToggle, 'id' | 'createdAt' | 'updatedAt'>) =>
    apiFetch<FeatureToggle>('/system/settings/feature-toggles', { method: 'POST', body: JSON.stringify(data) }),
  updateFeatureToggle: (id: string, data: Partial<FeatureToggle>) =>
    apiFetch<FeatureToggle>(`/system/settings/feature-toggles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteFeatureToggle: (id: string) =>
    apiFetch<void>(`/system/settings/feature-toggles/${id}`, { method: 'DELETE' }),
  toggleFeature: (id: string, enabled: boolean) =>
    apiFetch<FeatureToggle>(`/system/settings/feature-toggles/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  evaluateFeature: (key: string, context: Record<string, unknown>) =>
    apiFetch<{ key: string; enabled: boolean; variant?: string; value?: unknown; reason: string }>('/system/settings/feature-toggles/evaluate', {
      method: 'POST',
      body: JSON.stringify({ key, context })
    }),

  // Maintenance Mode
  getMaintenanceWindows: (params?: { status?: string; scope?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<MaintenanceWindow>>(`/system/settings/maintenance?${buildQueryString(params || {})}`),
  getMaintenanceWindow: (id: string) => apiFetch<MaintenanceWindow>(`/system/settings/maintenance/${id}`),
  createMaintenanceWindow: (data: CreateMaintenanceWindowInput) =>
    apiFetch<MaintenanceWindow>('/system/settings/maintenance', { method: 'POST', body: JSON.stringify(data) }),
  updateMaintenanceWindow: (id: string, data: Partial<MaintenanceWindow>) =>
    apiFetch<MaintenanceWindow>(`/system/settings/maintenance/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  startMaintenance: (id: string) =>
    apiFetch<MaintenanceWindow>(`/system/settings/maintenance/${id}/start`, { method: 'POST' }),
  endMaintenance: (id: string) =>
    apiFetch<MaintenanceWindow>(`/system/settings/maintenance/${id}/end`, { method: 'POST' }),
  cancelMaintenance: (id: string) =>
    apiFetch<MaintenanceWindow>(`/system/settings/maintenance/${id}/cancel`, { method: 'POST' }),
  extendMaintenance: (id: string, additionalMinutes: number) =>
    apiFetch<MaintenanceWindow>(`/system/settings/maintenance/${id}/extend`, { method: 'POST', body: JSON.stringify({ additionalMinutes }) }),
  checkMaintenanceStatus: (tenantId?: string) =>
    apiFetch<{ isInMaintenance: boolean; maintenanceInfo?: { title: string; message: string; estimatedEnd?: string } }>(`/system/settings/maintenance/check${tenantId ? `?tenantId=${tenantId}` : ''}`),

  // Provisioning Settings
  getProvisioningConfig: () =>
    apiFetch<Record<string, string>>('/system/settings/provisioning-config'),
  updateProvisioningConfig: (config: Record<string, string>) =>
    apiFetch<Record<string, string>>('/system/settings/provisioning-config', { method: 'PUT', body: JSON.stringify(config) }),

  // Performance Monitoring
  getPerformanceDashboard: (service?: string, timeRange?: { start: string; end: string }) =>
    apiFetch<PerformanceDashboard>(`/system/performance/dashboard?${buildQueryString({ service, ...timeRange })}`),
  getPerformanceMetrics: (service?: string, timeRange?: { start: string; end: string }) =>
    apiFetch<PerformanceMetrics[]>(`/system/performance/application?${buildQueryString({ service, ...timeRange })}`),
  getApdexScore: (service?: string) =>
    apiFetch<{ apdexScore: number }>(`/system/performance/application/apdex${service ? `?service=${service}` : ''}`),
  getDatabasePerformance: (database?: string) =>
    apiFetch<{
      activeConnections: number;
      poolSize: number;
      poolUtilization: number;
      avgQueryTime: number;
      slowQueryCount: number;
      cacheHitRatio: number;
    }>(`/system/performance/database${database ? `?database=${database}` : ''}`),
  getSlowQueries: (threshold?: number, limit?: number) =>
    apiFetch<Array<{ query: string; avgTime: number; count: number; maxTime: number }>>(`/system/performance/database/slow-queries?${buildQueryString({ threshold, limit })}`),
  getInfrastructureMetrics: (host?: string) =>
    apiFetch<{
      cpuUsage: number;
      memoryUsage: number;
      diskUsage: number;
      networkLatency: number;
      containerCount: number;
      healthyContainers: number;
    }>(`/system/performance/infrastructure${host ? `?host=${host}` : ''}`),

  // Error Tracking
  getErrorDashboard: () =>
    apiFetch<{
      totalErrors: number;
      unresolvedErrors: number;
      criticalErrors: number;
      errorsByService: Array<{ service: string; count: number }>;
      errorTrend: Array<{ timestamp: string; count: number }>;
      topErrors: ErrorGroup[];
    }>('/system/errors/dashboard'),
  getErrorGroups: (params?: {
    status?: string;
    severity?: string;
    service?: string;
    search?: string;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<ErrorGroup>>(`/system/errors/groups?${buildQueryString(params || {})}`),
  getErrorGroup: (id: string) => apiFetch<ErrorGroup>(`/system/errors/groups/${id}`),
  getErrorOccurrences: (groupId: string, params?: PaginationParams) =>
    apiFetch<PaginatedResult<ErrorOccurrence>>(`/system/errors/groups/${groupId}/occurrences?${buildQueryString(params || {})}`),
  updateErrorStatus: (id: string, status: string, assignedTo?: string, notes?: string) =>
    apiFetch<ErrorGroup>(`/system/errors/groups/${id}/status`, { method: 'PUT', body: JSON.stringify({ status, assignedTo, notes }) }),
  resolveError: (id: string, resolvedBy: string, notes?: string) =>
    apiFetch<ErrorGroup>(`/system/errors/groups/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolvedBy, notes }) }),
  ignoreError: (id: string) =>
    apiFetch<ErrorGroup>(`/system/errors/groups/${id}/ignore`, { method: 'POST' }),

  // Job Queue Management
  getJobDashboard: () =>
    apiFetch<JobDashboard>('/system/jobs/dashboard'),
  getQueues: () => apiFetch<JobQueue[]>('/system/jobs/queues'),
  getQueue: (name: string) => apiFetch<JobQueue>(`/system/jobs/queues/${name}`),
  createQueue: (data: { name: string; concurrency?: number; maxJobsPerSecond?: number }) =>
    apiFetch<JobQueue>('/system/jobs/queues', { method: 'POST', body: JSON.stringify(data) }),
  pauseQueue: (name: string) =>
    apiFetch<JobQueue>(`/system/jobs/queues/${name}/pause`, { method: 'POST' }),
  resumeQueue: (name: string) =>
    apiFetch<JobQueue>(`/system/jobs/queues/${name}/resume`, { method: 'POST' }),
  drainQueue: (name: string) =>
    apiFetch<{ drained: number }>(`/system/jobs/queues/${name}/drain`, { method: 'POST' }),
  getJobs: (params?: {
    queueName?: string;
    status?: JobStatus[];
    jobType?: string;
    search?: string;
  } & PaginationParams) =>
    apiFetch<PaginatedResult<BackgroundJob>>(`/system/jobs?${buildQueryString(params || {})}`),
  getJob: (id: string) => apiFetch<BackgroundJob>(`/system/jobs/${id}`),
  createJob: (data: {
    name: string;
    queueName: string;
    payload?: Record<string, unknown>;
    priority?: number;
    scheduledAt?: string;
    cronExpression?: string;
  }) =>
    apiFetch<BackgroundJob>('/system/jobs', { method: 'POST', body: JSON.stringify(data) }),
  cancelJob: (id: string) =>
    apiFetch<BackgroundJob>(`/system/jobs/${id}/cancel`, { method: 'POST' }),
  retryJob: (id: string) =>
    apiFetch<BackgroundJob>(`/system/jobs/${id}/retry`, { method: 'POST' }),
  getScheduledJobs: () => apiFetch<BackgroundJob[]>('/system/jobs/scheduled'),
  getFailedJobs: (limit?: number) =>
    apiFetch<BackgroundJob[]>(`/system/jobs/failed${limit ? `?limit=${limit}` : ''}`),
  cleanupJobs: (olderThanDays: number, status?: JobStatus[]) =>
    apiFetch<{ deleted: number }>('/system/jobs/cleanup', { method: 'POST', body: JSON.stringify({ olderThanDays, status }) }),
};
