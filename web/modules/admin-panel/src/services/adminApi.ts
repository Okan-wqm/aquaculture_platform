/**
 * Admin API Service
 * Enterprise-grade API client for Super Admin Panel
 * Comprehensive backend integration with all endpoints
 */

// API URL - Shell nginx üzerinden /api prefix'i ile admin-api-service'e yönlendirilir
const ADMIN_API_URL = import.meta.env.VITE_ADMIN_API_URL || '/api';

// ============================================================================
// HTTP Client with Error Handling & Retry Logic
// ============================================================================

interface ApiError extends Error {
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
}

interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
};

const getAuthHeader = (): Record<string, string> => {
  // Token 'access_token' key ile saklanıyor (shared-ui api-client.ts ile uyumlu)
  const token = localStorage.getItem('access_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// Generate unique request ID for tracing
const generateRequestId = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: ApiError | null = null;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      const response = await fetch(`${ADMIN_API_URL}${endpoint}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': generateRequestId(),
          ...getAuthHeader(),
          ...options?.headers,
        },
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ message: 'API Error' }));
        const error: ApiError = new Error(errorBody.message || `HTTP ${response.status}`);
        error.status = response.status;
        error.code = errorBody.code;
        error.details = errorBody.details;

        // Don't retry client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          throw error;
        }

        lastError = error;

        if (attempt < retryConfig.maxRetries) {
          const delay = Math.min(
            retryConfig.baseDelay * Math.pow(2, attempt),
            retryConfig.maxDelay
          );
          await sleep(delay);
          continue;
        }

        throw error;
      }

      // Handle empty responses
      const text = await response.text();
      if (!text) {
        return {} as T;
      }

      return JSON.parse(text);
    } catch (err) {
      if (err instanceof TypeError && err.message.includes('fetch')) {
        // Network error - retry
        lastError = err as ApiError;
        if (attempt < retryConfig.maxRetries) {
          const delay = Math.min(
            retryConfig.baseDelay * Math.pow(2, attempt),
            retryConfig.maxDelay
          );
          await sleep(delay);
          continue;
        }
      }
      throw err;
    }
  }

  throw lastError || new Error('Request failed after retries');
}

// Helper for query string building
const buildQueryString = (params: Record<string, unknown>): string => {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      if (Array.isArray(value)) {
        searchParams.set(key, value.join(','));
      } else {
        searchParams.set(key, String(value));
      }
    }
  });
  return searchParams.toString();
};

// ============================================================================
// Common Types
// ============================================================================

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  [key: string]: unknown;
}

export interface DateRangeParams {
  startDate?: string;
  endDate?: string;
  [key: string]: unknown;
}

// ============================================================================
// Tenant Enums (Backend uyumlu)
// ============================================================================

export enum TenantStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DEACTIVATED = 'deactivated',
  ARCHIVED = 'archived',
}

export enum TenantTier {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
  CUSTOM = 'custom',
}

// ============================================================================
// System Metrics API
// ============================================================================

export interface SystemMetrics {
  timestamp: string;
  database: {
    totalConnections: number;
    activeConnections: number;
    idleConnections: number;
    databaseSize: string;
    tablesCount: number;
  };
  platform: {
    totalTenants: number;
    activeTenants: number;
    totalUsers: number;
    totalFarms: number;
    totalSensors: number;
    activeSensors: number;
    totalAlertRules: number;
    activeAlertRules: number;
    eventsLast24h: number;
    apiCallsLast24h: number;
  };
  resources: {
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
    cpuUsage: { user: number; system: number };
    uptime: number;
    nodeVersion: string;
    platform: string;
  };
}

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime?: number;
  lastCheck: string;
  details?: Record<string, unknown>;
}

export const systemApi = {
  getMetrics: () => apiFetch<SystemMetrics>('/system/metrics'),
  getDatabaseMetrics: () => apiFetch<SystemMetrics['database']>('/system/metrics/database'),
  getPlatformMetrics: () => apiFetch<SystemMetrics['platform']>('/system/metrics/platform'),
  getResourceMetrics: () => apiFetch<SystemMetrics['resources']>('/system/metrics/resources'),
  getServicesHealth: () => apiFetch<ServiceHealth[]>('/system/services/health'),
  getMetricTrends: (metric: string, interval: string) =>
    apiFetch<Array<{ timestamp: string; value: number }>>(`/system/metrics/trends?metric=${metric}&interval=${interval}`),
};

// ============================================================================
// Analytics API
// ============================================================================

export interface DashboardSummary {
  totalTenants: number;
  activeTenants: number;
  totalUsers: number;
  activeUsers: number;
  totalRevenue: number;
  mrr: number;
  growthRate: number;
  churnRate: number;
}

export interface KpiComparison {
  metric: string;
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  trend: 'up' | 'down' | 'stable';
}

export interface TenantMetrics {
  tenantId: string;
  tenantName: string;
  userCount: number;
  activeUsers: number;
  farmCount: number;
  sensorCount: number;
  apiCalls: number;
  dataUsageGb: number;
  lastActivity: string;
}

export interface GrowthTrend {
  period: string;
  tenants: number;
  users: number;
  revenue: number;
  churn: number;
}

export interface RevenueAnalytics {
  totalRevenue: number;
  mrr: number;
  arr: number;
  averageRevenuePerTenant: number;
  revenueByPlan: Array<{ plan: string; revenue: number; percentage: number }>;
  revenueByMonth: Array<{ month: string; revenue: number }>;
}

export interface UsageAnalytics {
  totalApiCalls: number;
  apiCallsByEndpoint: Array<{ endpoint: string; count: number }>;
  avgResponseTime: number;
  errorRate: number;
  activeSessionsNow: number;
  peakConcurrentUsers: number;
  dataStorageUsedGb: number;
}

export interface EngagementMetrics {
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  monthlyActiveUsers: number;
  avgSessionDuration: number;
  avgActionsPerSession: number;
  featureUsage: Array<{ feature: string; usageCount: number; uniqueUsers: number }>;
}

export const analyticsApi = {
  // Dashboard
  getDashboardSummary: () => apiFetch<DashboardSummary>('/analytics/dashboard'),
  getKpiComparisons: (period?: string) =>
    apiFetch<KpiComparison[]>(`/analytics/kpi-comparisons${period ? `?period=${period}` : ''}`),

  // Tenant Metrics
  getTenantMetrics: (params?: PaginationParams & { sortBy?: string; order?: 'asc' | 'desc' }) =>
    apiFetch<PaginatedResult<TenantMetrics>>(`/analytics/tenants?${buildQueryString(params || {})}`),
  getTenantGrowthTrend: (period: string = '30d', dataPoints: number = 30) =>
    apiFetch<GrowthTrend[]>(`/analytics/tenants/growth?period=${period}&dataPoints=${dataPoints}`),

  // Revenue Analytics
  getRevenueAnalytics: (params?: DateRangeParams) =>
    apiFetch<RevenueAnalytics>(`/analytics/revenue?${buildQueryString(params || {})}`),
  getRevenueByPlan: (params?: DateRangeParams) =>
    apiFetch<Array<{ plan: string; revenue: number; tenantCount: number }>>(`/analytics/revenue/by-plan?${buildQueryString(params || {})}`),
  getRevenueTrend: (period: string = '12m') =>
    apiFetch<Array<{ period: string; revenue: number; growth: number }>>(`/analytics/revenue/trend?period=${period}`),

  // Usage Analytics
  getUsageAnalytics: (params?: DateRangeParams) =>
    apiFetch<UsageAnalytics>(`/analytics/usage?${buildQueryString(params || {})}`),
  getApiUsageByEndpoint: (params?: DateRangeParams & { limit?: number }) =>
    apiFetch<Array<{ endpoint: string; method: string; count: number; avgTime: number }>>(`/analytics/usage/api?${buildQueryString(params || {})}`),

  // Engagement
  getEngagementMetrics: (params?: DateRangeParams) =>
    apiFetch<EngagementMetrics>(`/analytics/engagement?${buildQueryString(params || {})}`),
  getFeatureUsage: (params?: DateRangeParams) =>
    apiFetch<Array<{ feature: string; usageCount: number; uniqueUsers: number; trend: number }>>(`/analytics/engagement/features?${buildQueryString(params || {})}`),

  // Geographic Distribution
  getGeographicDistribution: () =>
    apiFetch<Array<{ country: string; region: string; tenantCount: number; userCount: number }>>('/analytics/geographic'),

  // Churn Analytics
  getTenantChurn: (period: string = '30d') =>
    apiFetch<GrowthTrend[]>(`/analytics/tenants/churn?period=${period}`),

  // User Metrics
  getUserMetrics: (params?: DateRangeParams) =>
    apiFetch<{ totalUsers: number; activeUsers: number; newUsers: number; churnedUsers: number }>(`/analytics/users?${buildQueryString(params || {})}`),
  getUserActivity: (period: string = '30d') =>
    apiFetch<Array<{ date: string; activeUsers: number; sessions: number }>>(`/analytics/users/activity?period=${period}`),
  getUserHeatmap: (params?: DateRangeParams) =>
    apiFetch<Array<{ hour: number; day: number; count: number }>>(`/analytics/users/heatmap?${buildQueryString(params || {})}`),

  // Module & Feature Usage
  getModuleUsageAnalytics: () =>
    apiFetch<Array<{ moduleCode: string; moduleName: string; activeCount: number; totalAssigned: number }>>('/analytics/usage/modules'),
  getFeatureAdoption: () =>
    apiFetch<Array<{ feature: string; adoptionRate: number; trend: number }>>('/analytics/usage/features'),

  // Financial Metrics
  getFinancialMetrics: (params?: DateRangeParams) =>
    apiFetch<{ mrr: number; arr: number; ltv: number; cac: number; churnRate: number }>(`/analytics/financial?${buildQueryString(params || {})}`),
  getFinancialRevenue: (period: string = '12m') =>
    apiFetch<Array<{ period: string; revenue: number }>>(`/analytics/financial/revenue?period=${period}`),
  getFinancialByPlan: () =>
    apiFetch<Array<{ plan: string; revenue: number; percentage: number }>>('/analytics/financial/by-plan'),

  // System Metrics (Analytics)
  getSystemAnalytics: () =>
    apiFetch<{ cpuUsage: number; memoryUsage: number; diskUsage: number; uptime: number }>('/analytics/system'),
  getSystemApiCallsTrend: (period: string = '24h') =>
    apiFetch<Array<{ timestamp: string; count: number }>>(`/analytics/system/api-calls?period=${period}`),
  getSystemErrorsTrend: (period: string = '24h') =>
    apiFetch<Array<{ timestamp: string; count: number; rate: number }>>(`/analytics/system/errors?period=${period}`),

  // Snapshots
  getAnalyticsSnapshots: (params?: { startDate?: string; endDate?: string }) =>
    apiFetch<Array<{ id: string; date: string; metrics: Record<string, number> }>>(`/analytics/snapshots?${buildQueryString(params || {})}`),
};

// ============================================================================
// Reports API
// ============================================================================

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

export const reportsApi = {
  // Report Definitions
  getReportDefinitions: () => apiFetch<ReportDefinition[]>('/reports/definitions'),
  getReportDefinition: (id: string) => apiFetch<ReportDefinition>(`/reports/definitions/${id}`),
  createReportDefinition: (data: Omit<ReportDefinition, 'id' | 'createdAt' | 'lastRunAt'>) =>
    apiFetch<ReportDefinition>('/reports/definitions', { method: 'POST', body: JSON.stringify(data) }),
  updateReportDefinition: (id: string, data: Partial<ReportDefinition>) =>
    apiFetch<ReportDefinition>(`/reports/definitions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteReportDefinition: (id: string) =>
    apiFetch<void>(`/reports/definitions/${id}`, { method: 'DELETE' }),

  // Report Execution
  generateReport: (reportId: string, format: ReportFormat, filters?: Record<string, unknown>) =>
    apiFetch<ReportExecution>('/reports/generate', {
      method: 'POST',
      body: JSON.stringify({ reportId, format, filters })
    }),
  getReportExecutions: (params?: { reportId?: string; status?: ReportStatus } & PaginationParams) =>
    apiFetch<PaginatedResult<ReportExecution>>(`/reports/executions?${buildQueryString(params || {})}`),
  getReportExecution: (id: string) => apiFetch<ReportExecution>(`/reports/executions/${id}`),
  downloadReport: (executionId: string) =>
    `${ADMIN_API_URL}/reports/executions/${executionId}/download`,

  // Quick Reports
  getTenantsReport: (format: ReportFormat, filters?: Record<string, unknown>) =>
    apiFetch<ReportExecution>('/reports/quick/tenants', { method: 'POST', body: JSON.stringify({ format, filters }) }),
  getUsersReport: (format: ReportFormat, filters?: Record<string, unknown>) =>
    apiFetch<ReportExecution>('/reports/quick/users', { method: 'POST', body: JSON.stringify({ format, filters }) }),
  getRevenueReport: (format: ReportFormat, filters?: Record<string, unknown>) =>
    apiFetch<ReportExecution>('/reports/quick/revenue', { method: 'POST', body: JSON.stringify({ format, filters }) }),
  getAuditReport: (format: ReportFormat, filters?: Record<string, unknown>) =>
    apiFetch<ReportExecution>('/reports/quick/audit', { method: 'POST', body: JSON.stringify({ format, filters }) }),
};

// ============================================================================
// Database Management API
// ============================================================================

export interface TenantSchema {
  tenantId: string;
  tenantName: string;
  schemaName: string;
  status: 'active' | 'suspended' | 'archived' | 'migration_pending';
  tableCount: number;
  sizeBytes: number;
  rowCount: number;
  lastMigrationAt?: string;
  currentVersion: string;
  createdAt: string;
}

export interface SchemaMigration {
  id: string;
  version: string;
  name: string;
  description?: string;
  type: 'schema' | 'data' | 'index' | 'rollback';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';
  appliedToSchemas: string[];
  failedSchemas: string[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
  sql?: string;
  rollbackSql?: string;
  createdBy: string;
  createdAt: string;
}

export interface DatabaseBackup {
  id: string;
  type: 'full' | 'incremental' | 'schema_only' | 'data_only';
  status: 'pending' | 'running' | 'completed' | 'failed';
  tenantId?: string;
  schemaName?: string;
  sizeBytes?: number;
  location: string;
  compressionType?: string;
  encryptionKey?: string;
  startedAt: string;
  completedAt?: string;
  expiresAt?: string;
  error?: string;
  createdBy: string;
}

export interface DatabaseStats {
  totalSize: string;
  tableCount: number;
  indexCount: number;
  connectionPool: {
    total: number;
    active: number;
    idle: number;
    waiting: number;
  };
  replication?: {
    status: string;
    lag: number;
    replicas: number;
  };
  performance: {
    avgQueryTime: number;
    slowQueries: number;
    cacheHitRatio: number;
    deadlocks: number;
  };
}

export interface SlowQuery {
  query: string;
  duration: number;
  calls: number;
  avgDuration: number;
  schema?: string;
  timestamp: string;
}

export const databaseApi = {
  // Schema Management
  getSchemas: (params?: { status?: string; search?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<TenantSchema>>(`/database/schemas?${buildQueryString(params || {})}`),
  getSchema: (tenantId: string) => apiFetch<TenantSchema>(`/database/schemas/${tenantId}`),
  createSchema: (tenantId: string) =>
    apiFetch<TenantSchema>('/database/schemas', { method: 'POST', body: JSON.stringify({ tenantId }) }),
  deleteSchema: (tenantId: string, options?: { backup?: boolean; force?: boolean }) =>
    apiFetch<void>(`/database/schemas/${tenantId}?${buildQueryString(options || {})}`, { method: 'DELETE' }),
  resetSchema: (tenantId: string) =>
    apiFetch<TenantSchema>(`/database/schemas/${tenantId}/reset`, { method: 'POST' }),
  optimizeSchema: (tenantId: string) =>
    apiFetch<{ success: boolean; improvements: string[] }>(`/database/schemas/${tenantId}/optimize`, { method: 'POST' }),
  analyzeSchema: (tenantId: string) =>
    apiFetch<{ tables: Array<{ name: string; rows: number; size: string; indexes: number }> }>(`/database/schemas/${tenantId}/analyze`),

  // Migrations
  getMigrations: (params?: { status?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<SchemaMigration>>(`/database/migrations?${buildQueryString(params || {})}`),
  getMigration: (id: string) => apiFetch<SchemaMigration>(`/database/migrations/${id}`),
  createMigration: (data: { name: string; description?: string; type: string; sql: string; rollbackSql?: string; createdBy: string }) =>
    apiFetch<SchemaMigration>('/database/migrations', { method: 'POST', body: JSON.stringify(data) }),
  runMigration: (id: string, schemaIds?: string[]) =>
    apiFetch<SchemaMigration>(`/database/migrations/${id}/run`, { method: 'POST', body: JSON.stringify({ schemaIds }) }),
  rollbackMigration: (id: string) =>
    apiFetch<SchemaMigration>(`/database/migrations/${id}/rollback`, { method: 'POST' }),
  getPendingMigrations: () => apiFetch<SchemaMigration[]>('/database/migrations/pending'),

  // Backups
  getBackups: (params?: { type?: string; status?: string; tenantId?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<DatabaseBackup>>(`/database/backups?${buildQueryString(params || {})}`),
  getBackup: (id: string) => apiFetch<DatabaseBackup>(`/database/backups/${id}`),
  createBackup: (data: { type: string; tenantId?: string; schemaName?: string; createdBy: string }) =>
    apiFetch<DatabaseBackup>('/database/backups', { method: 'POST', body: JSON.stringify(data) }),
  restoreBackup: (id: string, targetSchema?: string) =>
    apiFetch<{ success: boolean; message: string }>(`/database/backups/${id}/restore`, {
      method: 'POST',
      body: JSON.stringify({ targetSchema })
    }),
  deleteBackup: (id: string) => apiFetch<void>(`/database/backups/${id}`, { method: 'DELETE' }),
  scheduleBackup: (data: { type: string; schedule: string; retentionDays: number; createdBy: string }) =>
    apiFetch<{ id: string; schedule: string }>('/database/backups/schedule', { method: 'POST', body: JSON.stringify(data) }),

  // Monitoring
  getDatabaseStats: () => apiFetch<DatabaseStats>('/database/monitoring/stats'),
  getSlowQueries: (params?: { threshold?: number; limit?: number } & DateRangeParams) =>
    apiFetch<SlowQuery[]>(`/database/monitoring/slow-queries?${buildQueryString(params || {})}`),
  getConnectionStats: () =>
    apiFetch<{ active: number; idle: number; waiting: number; max: number; history: Array<{ time: string; connections: number }> }>('/database/monitoring/connections'),
  getTableStats: (schemaName?: string) =>
    apiFetch<Array<{ table: string; rows: number; size: string; deadTuples: number; lastVacuum?: string }>>(`/database/monitoring/tables${schemaName ? `?schema=${schemaName}` : ''}`),
  runVacuum: (schemaName?: string, tableName?: string) =>
    apiFetch<{ success: boolean }>('/database/monitoring/vacuum', { method: 'POST', body: JSON.stringify({ schemaName, tableName }) }),
  runAnalyze: (schemaName?: string) =>
    apiFetch<{ success: boolean }>('/database/monitoring/analyze', { method: 'POST', body: JSON.stringify({ schemaName }) }),
};

// ============================================================================
// Support API (Tickets, Messaging, Announcements, Onboarding)
// ============================================================================

export type TicketStatus = 'open' | 'in_progress' | 'waiting_customer' | 'waiting_internal' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'critical';
export type TicketCategory = 'technical' | 'billing' | 'feature_request' | 'bug_report' | 'bug' | 'general' | 'account';

export interface TicketAttachmentInfo {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  uploadedAt?: string;
}

export interface SupportTicket {
  id: string;
  ticketNumber: string;
  tenantId: string;
  tenantName?: string;
  createdBy: string;
  createdByName?: string;
  createdByEmail?: string;
  subject: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo?: string;
  assignedToName?: string;
  tags?: string[];
  firstResponseAt?: string;
  resolvedAt?: string;
  closedAt?: string;
  dueAt?: string;
  slaResponseMinutes?: number;
  slaResolutionMinutes?: number;
  slaBreached?: boolean;
  satisfactionRating?: number;
  satisfactionFeedback?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type TicketCommentAuthorType = 'admin' | 'tenant_user' | 'system';

export interface TicketComment {
  id: string;
  ticketId: string;
  authorId: string;
  authorType: TicketCommentAuthorType;
  authorName?: string;
  content: string;
  isInternal: boolean;
  attachments?: TicketAttachmentInfo[];
  emailSent?: boolean;
  createdAt: string;
}

export interface TicketReply {
  id: string;
  ticketId: string;
  content: string;
  isInternal: boolean;
  createdBy: string;
  createdByEmail: string;
  createdByRole: 'customer' | 'support' | 'admin';
  attachments: Array<{ id: string; filename: string; url: string }>;
  createdAt: string;
}

export interface TicketStats {
  total: number;
  open: number;
  inProgress: number;
  waitingCustomer?: number;
  resolved: number;
  closed?: number;
  avgFirstResponseMinutes?: number;
  avgResolutionMinutes?: number;
  avgResponseTime?: number;
  avgResolutionTime?: number;
  slaBreachCount?: number;
  avgSatisfactionRating?: number;
  satisfactionScore?: number;
  byCategory?: Array<{ category: string; count: number }>;
  byPriority?: Array<{ priority: string; count: number }>;
}

export type MessageSenderType = 'super_admin' | 'tenant_admin' | 'system';
export type MessageStatus = 'sent' | 'delivered' | 'read';
export type ThreadStatus = 'open' | 'closed' | 'archived';

export interface MessageAttachment {
  id: string;
  filename: string;
  url: string;
  size: number;
  mimeType: string;
}

export interface Message {
  id: string;
  threadId: string;
  senderId: string;
  senderType: MessageSenderType;
  senderName: string;
  content: string;
  status: MessageStatus;
  isInternal: boolean;
  attachments: MessageAttachment[] | null;
  readAt: string | null;
  createdAt: string;
}

export interface MessageThread {
  id: string;
  tenantId: string;
  tenantName?: string;
  subject: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageBy: string | null;
  status: ThreadStatus;
  messageCount: number;
  unreadCountAdmin: number;
  unreadCountTenant: number;
  createdBy: string;
  createdByAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AnnouncementType = 'info' | 'warning' | 'critical' | 'maintenance' | 'success';
export type AnnouncementStatus = 'draft' | 'scheduled' | 'published' | 'expired' | 'cancelled';

export interface AnnouncementTarget {
  tenantIds?: string[];
  excludeTenantIds?: string[];
  plans?: string[];
  modules?: string[];
  regions?: string[];
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
  status: AnnouncementStatus;
  isGlobal: boolean;
  targetCriteria?: AnnouncementTarget;
  createdBy?: string;
  createdByName?: string;
  publishAt?: string;
  expiresAt?: string;
  requiresAcknowledgment: boolean;
  viewCount: number;
  acknowledgmentCount: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface OnboardingStep {
  id: string;
  code: string;
  name: string;
  description: string;
  order: number;
  isRequired: boolean;
  estimatedMinutes: number;
  helpUrl?: string;
  videoUrl?: string;
}

export interface TenantOnboarding {
  tenantId: string;
  tenantName: string;
  status: 'not_started' | 'in_progress' | 'completed' | 'stalled';
  completedSteps: string[];
  currentStep?: string;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt?: string;
  assignedTo?: string;
  notes?: string;
}

export const supportApi = {
  // Tickets
  getTickets: (params?: {
    status?: TicketStatus[];
    priority?: TicketPriority[];
    category?: TicketCategory[];
    tenantId?: string;
    assignedTo?: string;
    search?: string;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<SupportTicket>>(`/support/tickets?${buildQueryString(params || {})}`),
  getTicket: (id: string) => apiFetch<SupportTicket>(`/support/tickets/${id}`),
  getTicketReplies: (ticketId: string) => apiFetch<TicketReply[]>(`/support/tickets/${ticketId}/replies`),
  createTicket: (data: { subject: string; description: string; category: TicketCategory; priority: TicketPriority; tenantId: string; createdBy: string }) =>
    apiFetch<SupportTicket>('/support/tickets', { method: 'POST', body: JSON.stringify(data) }),
  updateTicket: (id: string, data: Partial<{ status: TicketStatus; priority: TicketPriority; assignedTo: string; tags: string[] }>) =>
    apiFetch<SupportTicket>(`/support/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  addReply: (ticketId: string, data: { content: string; isInternal?: boolean; createdBy: string }) =>
    apiFetch<TicketReply>(`/support/tickets/${ticketId}/replies`, { method: 'POST', body: JSON.stringify(data) }),
  assignTicket: (id: string, assignedTo: string, assignedToName: string) =>
    apiFetch<SupportTicket>(`/support/tickets/${id}/assign`, { method: 'POST', body: JSON.stringify({ assignedTo, assignedToName }) }),
  closeTicket: (id: string, resolution?: string) =>
    apiFetch<SupportTicket>(`/support/tickets/${id}/close`, { method: 'POST', body: JSON.stringify({ resolution }) }),
  getTicketStats: () => apiFetch<TicketStats>('/support/tickets/stats'),
  getTicketStatsByCategory: () =>
    apiFetch<Array<{ category: string; count: number; avgResolutionTime: number }>>('/support/tickets/stats/by-category'),
  getTicketStatsByPriority: () =>
    apiFetch<Array<{ priority: string; count: number; avgResolutionTime: number }>>('/support/tickets/stats/by-priority'),
  getUnassignedTickets: (params?: PaginationParams) =>
    apiFetch<PaginatedResult<SupportTicket>>(`/support/tickets/unassigned?${buildQueryString(params || {})}`),
  getSlaRiskTickets: () =>
    apiFetch<Array<{ id: string; subject: string; priority: string; hoursUntilBreach: number; tenantName: string }>>('/support/tickets/sla-risk'),
  submitSatisfaction: (ticketId: string, data: { rating: number; feedback?: string; submittedBy: string }) =>
    apiFetch<{ success: boolean }>(`/support/tickets/${ticketId}/satisfaction`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getTicketTeam: () => apiFetch<Array<{ id: string; name: string; activeTickets: number }>>('/support/tickets/team'),
  getTicketComments: (ticketId: string) => apiFetch<Array<{ id: string; ticketId: string; authorId: string; authorName: string; authorType: string; content: string; isInternal: boolean; attachments: unknown[]; createdAt: string }>>(`/support/tickets/${ticketId}/comments`),
  addTicketComment: (ticketId: string, data: { content: string; isInternal?: boolean }) =>
    apiFetch<unknown>(`/support/tickets/${ticketId}/comments`, { method: 'POST', body: JSON.stringify(data) }),
  updateTicketStatus: (ticketId: string, status: string, changedByName?: string) =>
    apiFetch<unknown>(`/support/tickets/${ticketId}/status`, { method: 'POST', body: JSON.stringify({ status, changedByName }) }),
  updateTicketPriority: (ticketId: string, priority: string, changedByName?: string) =>
    apiFetch<unknown>(`/support/tickets/${ticketId}/priority`, { method: 'POST', body: JSON.stringify({ priority, changedByName }) }),

  // Messaging - Backend: /support/messages
  getMessageThreads: (params?: { tenantId?: string; status?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<MessageThread>>(`/support/messages/threads?${buildQueryString(params || {})}`),
  getThread: (threadId: string) => apiFetch<MessageThread>(`/support/messages/threads/${threadId}`),
  getThreadMessages: (threadId: string) => apiFetch<Message[]>(`/support/messages/threads/${threadId}/messages`),
  createThread: (data: { tenantId: string; subject: string; content: string; senderName: string }) =>
    apiFetch<MessageThread>('/support/messages/threads', { method: 'POST', body: JSON.stringify(data) }),
  sendMessage: (threadId: string, data: { content: string; senderName: string }) =>
    apiFetch<Message>(`/support/messages/threads/${threadId}/messages`, { method: 'POST', body: JSON.stringify(data) }),
  markAsRead: (threadId: string) =>
    apiFetch<void>(`/support/messages/threads/${threadId}/read`, { method: 'POST' }),
  archiveThread: (threadId: string) =>
    apiFetch<void>(`/support/messages/threads/${threadId}/archive`, { method: 'POST' }),
  closeThread: (threadId: string) =>
    apiFetch<void>(`/support/messages/threads/${threadId}/close`, { method: 'POST' }),
  reopenThread: (threadId: string) =>
    apiFetch<void>(`/support/messages/threads/${threadId}/reopen`, { method: 'POST' }),
  sendBulkMessage: (data: { subject: string; content: string; tenantIds?: string[]; sendEmail: boolean }) =>
    apiFetch<void>('/support/messages/bulk', { method: 'POST', body: JSON.stringify(data) }),
  getUnreadCount: () => apiFetch<{ unreadCount: number }>('/support/messages/unread-count'),
  getMessagingStats: () => apiFetch<Record<string, unknown>>('/support/messages/stats'),

  // Announcements
  getAnnouncements: (params?: { type?: string; isPublished?: boolean } & PaginationParams) =>
    apiFetch<PaginatedResult<Announcement>>(`/support/announcements?${buildQueryString(params || {})}`),
  getAnnouncement: (id: string) => apiFetch<Announcement>(`/support/announcements/${id}`),
  createAnnouncement: (data: Omit<Announcement, 'id' | 'viewCount' | 'acknowledgedCount' | 'createdAt' | 'updatedAt'>) =>
    apiFetch<Announcement>('/support/announcements', { method: 'POST', body: JSON.stringify(data) }),
  updateAnnouncement: (id: string, data: Partial<Announcement>) =>
    apiFetch<Announcement>(`/support/announcements/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  publishAnnouncement: (id: string) =>
    apiFetch<Announcement>(`/support/announcements/${id}/publish`, { method: 'POST' }),
  unpublishAnnouncement: (id: string) =>
    apiFetch<Announcement>(`/support/announcements/${id}/unpublish`, { method: 'POST' }),
  deleteAnnouncement: (id: string) =>
    apiFetch<void>(`/support/announcements/${id}`, { method: 'DELETE' }),

  // Onboarding - Backend: /support/onboarding
  getOnboardingSteps: () => apiFetch<OnboardingStep[]>('/support/onboarding/steps'),
  getTenantOnboardings: (params?: { status?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<TenantOnboarding>>(`/support/onboarding?${buildQueryString(params || {})}`),
  getTenantOnboarding: (tenantId: string) => apiFetch<TenantOnboarding>(`/support/onboarding/${tenantId}`),
  initializeOnboarding: (tenantId: string, tenantName: string) =>
    apiFetch<TenantOnboarding>('/support/onboarding/initialize', {
      method: 'POST',
      body: JSON.stringify({ tenantId, tenantName })
    }),
  completeOnboardingStep: (tenantId: string, stepId: string) =>
    apiFetch<TenantOnboarding>(`/support/onboarding/${tenantId}/step/${stepId}/complete`, { method: 'POST' }),
  skipOnboardingStep: (tenantId: string, stepId: string) =>
    apiFetch<TenantOnboarding>(`/support/onboarding/${tenantId}/step/${stepId}/skip`, { method: 'POST' }),
  skipOnboarding: (tenantId: string) =>
    apiFetch<TenantOnboarding>(`/support/onboarding/${tenantId}/skip`, { method: 'POST' }),
  assignOnboardingGuide: (tenantId: string, guideId: string, guideName: string) =>
    apiFetch<TenantOnboarding>(`/support/onboarding/${tenantId}/assign-guide`, {
      method: 'POST',
      body: JSON.stringify({ guideId, guideName })
    }),
  getOnboardingStats: () =>
    apiFetch<{ notStarted: number; inProgress: number; completed: number; stalled: number; avgCompletionDays: number }>('/support/onboarding/stats'),
  getTenantsNeedingAttention: () => apiFetch<TenantOnboarding[]>('/support/onboarding/needs-attention'),
  getTrainingResources: (category?: string) =>
    apiFetch<Array<{ id: string; title: string; type: string; category: string; url: string }>>(`/support/onboarding/resources/all${category ? `?category=${category}` : ''}`),
};

// ============================================================================
// Security API
// ============================================================================

export type SecurityEventSeverity = 'low' | 'medium' | 'high' | 'critical';
export type SecurityEventType = 'login_failure' | 'suspicious_activity' | 'permission_violation' | 'data_breach' | 'api_abuse' | 'brute_force';

export interface ActivityLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  tenantId?: string;
  userId: string;
  userEmail: string;
  ipAddress: string;
  userAgent: string;
  location?: { country: string; city: string };
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface AuditTrailEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  performedBy: string;
  performedByEmail: string;
  reason?: string;
  timestamp: string;
}

export interface RetentionPolicy {
  id: string;
  name: string;
  entityType: string;
  retentionDays: number;
  archiveAfterDays?: number;
  isActive: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface ComplianceReport {
  id: string;
  type: 'gdpr' | 'hipaa' | 'soc2' | 'iso27001' | 'custom';
  status: 'compliant' | 'non_compliant' | 'partial' | 'pending_review';
  findings: Array<{ area: string; status: string; details: string }>;
  score: number;
  generatedAt: string;
  validUntil: string;
}

export interface DataSubjectRequest {
  id: string;
  type: 'access' | 'rectification' | 'erasure' | 'portability' | 'restriction';
  status: 'pending' | 'in_progress' | 'completed' | 'rejected';
  subjectEmail: string;
  subjectName?: string;
  tenantId?: string;
  requestedAt: string;
  dueDate: string;
  completedAt?: string;
  handledBy?: string;
  notes?: string;
}

export interface SecurityEvent {
  id: string;
  type: SecurityEventType;
  severity: SecurityEventSeverity;
  title: string;
  description: string;
  sourceIp?: string;
  userId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  isResolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt: string;
}

export interface SecurityIncident {
  id: string;
  title: string;
  description: string;
  severity: SecurityEventSeverity;
  status: 'open' | 'investigating' | 'contained' | 'resolved' | 'closed';
  affectedTenants: string[];
  affectedUsers: number;
  rootCause?: string;
  resolution?: string;
  timeline: Array<{ action: string; timestamp: string; performedBy: string }>;
  assignedTo?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ThreatIndicator {
  id: string;
  type: 'ip' | 'domain' | 'email' | 'hash';
  value: string;
  threatLevel: SecurityEventSeverity;
  description?: string;
  source: string;
  lastSeenAt: string;
  isBlocked: boolean;
  createdAt: string;
}

export const securityApi = {
  // Activity Logs
  getActivityLogs: (params?: {
    action?: string;
    entityType?: string;
    userId?: string;
    tenantId?: string;
    ipAddress?: string;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<ActivityLog>>(`/security/activities?${buildQueryString(params || {})}`),
  getActivityLog: (id: string) => apiFetch<ActivityLog>(`/security/activities/${id}`),
  getUserActivities: (userId: string, params?: PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<ActivityLog>>(`/security/activities/user/${userId}?${buildQueryString(params || {})}`),
  getEntityActivities: (entityType: string, entityId: string, params?: PaginationParams) =>
    apiFetch<PaginatedResult<ActivityLog>>(`/security/activities/entity/${entityType}/${entityId}?${buildQueryString(params || {})}`),
  exportActivityLogs: (format: 'csv' | 'json', params?: DateRangeParams) =>
    apiFetch<{ url: string }>(`/security/activities/export?format=${format}&${buildQueryString(params || {})}`),

  // Audit Trail
  getAuditTrail: (params?: {
    entityType?: string;
    performedBy?: string;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<AuditTrailEntry>>(`/security/audit?${buildQueryString(params || {})}`),
  getEntityAuditTrail: (entityType: string, entityId: string) =>
    apiFetch<AuditTrailEntry[]>(`/security/audit/entity/${entityType}/${entityId}`),

  // Retention Policies
  getRetentionPolicies: () => apiFetch<RetentionPolicy[]>('/security/audit/retention-policies'),
  createRetentionPolicy: (data: Omit<RetentionPolicy, 'id' | 'lastRunAt' | 'nextRunAt'>) =>
    apiFetch<RetentionPolicy>('/security/audit/retention-policies', { method: 'POST', body: JSON.stringify(data) }),
  updateRetentionPolicy: (id: string, data: Partial<RetentionPolicy>) =>
    apiFetch<RetentionPolicy>(`/security/audit/retention-policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteRetentionPolicy: (id: string) =>
    apiFetch<void>(`/security/audit/retention-policies/${id}`, { method: 'DELETE' }),
  runRetentionPolicy: (id: string) =>
    apiFetch<{ deletedCount: number; archivedCount: number }>(`/security/audit/retention-policies/${id}/run`, { method: 'POST' }),

  // Compliance
  getComplianceReports: () => apiFetch<ComplianceReport[]>('/security/compliance/reports'),
  generateComplianceReport: (type: string) =>
    apiFetch<ComplianceReport>('/security/compliance/reports/generate', { method: 'POST', body: JSON.stringify({ type }) }),
  getComplianceDashboard: () =>
    apiFetch<{ overallScore: number; byArea: Array<{ area: string; score: number; status: string }> }>('/security/compliance/dashboard'),

  // Data Subject Requests (GDPR)
  getDataRequests: (params?: { status?: string; type?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<DataSubjectRequest>>(`/security/compliance/data-requests?${buildQueryString(params || {})}`),
  getDataRequest: (id: string) => apiFetch<DataSubjectRequest>(`/security/compliance/data-requests/${id}`),
  createDataRequest: (data: Omit<DataSubjectRequest, 'id' | 'status' | 'requestedAt' | 'dueDate'>) =>
    apiFetch<DataSubjectRequest>('/security/compliance/data-requests', { method: 'POST', body: JSON.stringify(data) }),
  processDataRequest: (id: string, action: 'approve' | 'reject', handledBy: string, notes?: string) =>
    apiFetch<DataSubjectRequest>(`/security/compliance/data-requests/${id}/process`, {
      method: 'POST',
      body: JSON.stringify({ action, handledBy, notes })
    }),

  // Security Events & Incidents
  getSecurityEvents: (params?: {
    type?: SecurityEventType[];
    severity?: SecurityEventSeverity[];
    isResolved?: boolean;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<SecurityEvent>>(`/security/monitoring/events?${buildQueryString(params || {})}`),
  getSecurityEvent: (id: string) => apiFetch<SecurityEvent>(`/security/monitoring/events/${id}`),
  resolveSecurityEvent: (id: string, resolvedBy: string, notes?: string) =>
    apiFetch<SecurityEvent>(`/security/monitoring/events/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolvedBy, notes }) }),

  getSecurityIncidents: (params?: { status?: string; severity?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<SecurityIncident>>(`/security/monitoring/incidents?${buildQueryString(params || {})}`),
  getSecurityIncident: (id: string) => apiFetch<SecurityIncident>(`/security/monitoring/incidents/${id}`),
  createSecurityIncident: (data: Omit<SecurityIncident, 'id' | 'timeline' | 'createdAt'>) =>
    apiFetch<SecurityIncident>('/security/monitoring/incidents', { method: 'POST', body: JSON.stringify(data) }),
  updateSecurityIncident: (id: string, data: Partial<SecurityIncident>) =>
    apiFetch<SecurityIncident>(`/security/monitoring/incidents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  addIncidentTimeline: (id: string, action: string, performedBy: string) =>
    apiFetch<SecurityIncident>(`/security/monitoring/incidents/${id}/timeline`, { method: 'POST', body: JSON.stringify({ action, performedBy }) }),

  // Threat Intelligence
  getThreatIndicators: (params?: { type?: string; isBlocked?: boolean } & PaginationParams) =>
    apiFetch<PaginatedResult<ThreatIndicator>>(`/security/monitoring/threat-intelligence?${buildQueryString(params || {})}`),
  addThreatIndicator: (data: Omit<ThreatIndicator, 'id' | 'lastSeenAt' | 'createdAt'>) =>
    apiFetch<ThreatIndicator>('/security/monitoring/threat-intelligence', { method: 'POST', body: JSON.stringify(data) }),
  blockThreatIndicator: (id: string) =>
    apiFetch<ThreatIndicator>(`/security/monitoring/threat-intelligence/${id}/block`, { method: 'POST' }),
  unblockThreatIndicator: (id: string) =>
    apiFetch<ThreatIndicator>(`/security/monitoring/threat-intelligence/${id}/unblock`, { method: 'POST' }),

  // Security Dashboard
  getSecurityDashboard: () =>
    apiFetch<{
      threatLevel: SecurityEventSeverity;
      activeIncidents: number;
      unresolvedEvents: number;
      blockedThreats: number;
      recentEvents: SecurityEvent[];
      topThreats: Array<{ type: string; count: number }>;
    }>('/security/monitoring/dashboard'),
};

// ============================================================================
// System Settings API (Feature Toggles, Maintenance, Performance, Errors, Jobs)
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
  scope: 'global' | 'tenant' | 'service';
  type: 'scheduled' | 'emergency' | 'rolling';
  status: MaintenanceStatus;
  tenantId?: string;
  affectedServices?: Array<{ name: string; status: string }>;
  scheduledStart: string;
  scheduledEnd?: string;
  actualStart?: string;
  actualEnd?: string;
  userMessage?: string;
  allowReadOnlyAccess: boolean;
  bypassForSuperAdmins: boolean;
  createdBy: string;
  createdAt: string;
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
  createMaintenanceWindow: (data: Omit<MaintenanceWindow, 'id' | 'status' | 'actualStart' | 'actualEnd' | 'createdAt'>) =>
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
    apiFetch<{
      totalJobs: number;
      pendingJobs: number;
      runningJobs: number;
      completedToday: number;
      failedToday: number;
      avgDuration: number;
      queues: JobQueue[];
      recentJobs: BackgroundJob[];
    }>('/system/jobs/dashboard'),
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

// ============================================================================
// Impersonation API
// ============================================================================

export interface ImpersonationPermission {
  id: string;
  tenantId: string;
  tenantName: string;
  grantedBy: string;
  grantedByEmail: string;
  grantedAt: string;
  expiresAt?: string;
  maxSessionDuration: number;
  allowedActions: string[];
  isActive: boolean;
  reason?: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface ImpersonationSession {
  id: string;
  adminId: string;
  adminEmail: string;
  tenantId: string;
  tenantName: string;
  originalUserId?: string;
  impersonatedUserId?: string;
  status: 'active' | 'ended' | 'expired' | 'revoked';
  sessionToken: string;
  startedAt: string;
  endedAt?: string;
  expiresAt: string;
  lastActivityAt: string;
  ipAddress: string;
  userAgent?: string;
  actionsPerformed: number;
}

export interface ImpersonationAction {
  id: string;
  sessionId: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export const impersonationApi = {
  // Permissions
  getPermissions: (params?: { tenantId?: string; isActive?: boolean } & PaginationParams) =>
    apiFetch<PaginatedResult<ImpersonationPermission>>(`/impersonation/permissions?${buildQueryString(params || {})}`),
  getPermission: (id: string) => apiFetch<ImpersonationPermission>(`/impersonation/permissions/${id}`),
  grantPermission: (data: {
    tenantId: string;
    grantedBy: string;
    expiresAt?: string;
    maxSessionDuration?: number;
    allowedActions?: string[];
    reason?: string;
  }) =>
    apiFetch<ImpersonationPermission>('/impersonation/permissions', { method: 'POST', body: JSON.stringify(data) }),
  updatePermission: (id: string, data: Partial<ImpersonationPermission>) =>
    apiFetch<ImpersonationPermission>(`/impersonation/permissions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  revokePermission: (id: string, revokedBy: string, reason?: string) =>
    apiFetch<ImpersonationPermission>(`/impersonation/permissions/${id}/revoke`, { method: 'POST', body: JSON.stringify({ revokedBy, reason }) }),
  checkPermission: (tenantId: string, adminId: string) =>
    apiFetch<{ hasPermission: boolean; permission?: ImpersonationPermission }>(`/impersonation/permissions/check?tenantId=${tenantId}&adminId=${adminId}`),

  // Sessions
  getSessions: (params?: { adminId?: string; tenantId?: string; status?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<ImpersonationSession>>(`/impersonation/sessions?${buildQueryString(params || {})}`),
  getSession: (id: string) => apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}`),
  startSession: (data: { tenantId: string; adminId: string; impersonatedUserId?: string; reason?: string }) =>
    apiFetch<ImpersonationSession>('/impersonation/sessions/start', { method: 'POST', body: JSON.stringify(data) }),
  endSession: (id: string) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/end`, { method: 'POST' }),
  extendSession: (id: string, additionalMinutes: number) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/extend`, { method: 'POST', body: JSON.stringify({ additionalMinutes }) }),
  revokeSession: (id: string, revokedBy: string, reason?: string) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/revoke`, { method: 'POST', body: JSON.stringify({ revokedBy, reason }) }),
  getActiveSessions: () => apiFetch<ImpersonationSession[]>('/impersonation/sessions/active'),
  getSessionActions: (sessionId: string) => apiFetch<ImpersonationAction[]>(`/impersonation/sessions/${sessionId}/actions`),
  logAction: (sessionId: string, data: Omit<ImpersonationAction, 'id' | 'sessionId' | 'timestamp'>) =>
    apiFetch<ImpersonationAction>(`/impersonation/sessions/${sessionId}/actions`, { method: 'POST', body: JSON.stringify(data) }),

  // Dashboard
  getImpersonationStats: () =>
    apiFetch<{
      activeSessions: number;
      totalSessions: number;
      activePermissions: number;
      topAdmins: Array<{ adminId: string; email: string; sessionCount: number }>;
      recentSessions: ImpersonationSession[];
    }>('/impersonation/stats'),
};

// ============================================================================
// Debug Tools API
// ============================================================================

export type DebugSessionType = 'query_inspection' | 'api_log_viewing' | 'cache_inspection' | 'feature_flag_override' | 'performance_profiling';

export interface DebugSession {
  id: string;
  adminId: string;
  tenantId: string;
  sessionType: DebugSessionType;
  isActive: boolean;
  configuration?: Record<string, unknown>;
  filters?: Record<string, unknown>;
  maxResults: number;
  expiresAt?: string;
  createdAt: string;
}

export interface CapturedQuery {
  id: string;
  debugSessionId?: string;
  tenantId: string;
  queryType: 'select' | 'insert' | 'update' | 'delete' | 'transaction';
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
  timestamp: string;
}

export interface CapturedApiCall {
  id: string;
  debugSessionId?: string;
  tenantId: string;
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
  hasError: boolean;
  errorMessage?: string;
  timestamp: string;
}

export interface CacheEntry {
  id: string;
  tenantId?: string;
  key: string;
  value?: unknown;
  sizeBytes?: number;
  ttlSeconds?: number;
  expiresAt?: string;
  hitCount: number;
  lastAccessedAt?: string;
  cacheStore?: string;
  tags?: string[];
}

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
  createdAt: string;
}

export const debugApi = {
  // Debug Sessions
  getSessions: (params?: { tenantId?: string; sessionType?: string; isActive?: boolean } & PaginationParams) =>
    apiFetch<PaginatedResult<DebugSession>>(`/debug/sessions?${buildQueryString(params || {})}`),
  getSession: (id: string) => apiFetch<DebugSession>(`/debug/sessions/${id}`),
  startSession: (data: {
    tenantId: string;
    adminId: string;
    sessionType: DebugSessionType;
    configuration?: Record<string, unknown>;
    filters?: Record<string, unknown>;
    maxResults?: number;
    expiresAt?: string;
  }) =>
    apiFetch<DebugSession>('/debug/sessions', { method: 'POST', body: JSON.stringify(data) }),
  endSession: (id: string) =>
    apiFetch<DebugSession>(`/debug/sessions/${id}/end`, { method: 'POST' }),

  // Query Inspector
  getCapturedQueries: (params?: {
    tenantId?: string;
    queryType?: string;
    isSlowQuery?: boolean;
    hasError?: boolean;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<CapturedQuery>>(`/debug/queries?${buildQueryString(params || {})}`),
  getQueryExplain: (queryId: string) =>
    apiFetch<{ plan: Record<string, unknown> }>(`/debug/queries/${queryId}/explain`),
  getSlowQueryAnalysis: (tenantId: string, threshold?: number) =>
    apiFetch<{
      slowQueries: CapturedQuery[];
      summary: { avgDuration: number; maxDuration: number; totalQueries: number };
      recommendations: string[];
    }>(`/debug/queries/slow-analysis?tenantId=${tenantId}${threshold ? `&threshold=${threshold}` : ''}`),

  // API Log Viewer
  getCapturedApiCalls: (params?: {
    tenantId?: string;
    method?: string;
    endpoint?: string;
    statusCode?: number;
    hasError?: boolean;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<CapturedApiCall>>(`/debug/api-calls?${buildQueryString(params || {})}`),
  getApiCallDetails: (id: string) => apiFetch<CapturedApiCall>(`/debug/api-calls/${id}`),
  getApiUsageSummary: (tenantId: string, period?: string) =>
    apiFetch<{
      totalCalls: number;
      byEndpoint: Array<{ endpoint: string; count: number; avgDuration: number }>;
      byStatus: Array<{ status: number; count: number }>;
      errorRate: number;
    }>(`/debug/api-calls/summary?tenantId=${tenantId}${period ? `&period=${period}` : ''}`),

  // Cache Inspector
  getCacheEntries: (params?: { tenantId?: string; cacheStore?: string; keyPattern?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<CacheEntry>>(`/debug/cache?${buildQueryString(params || {})}`),
  getCacheEntry: (key: string) => apiFetch<CacheEntry>(`/debug/cache/${encodeURIComponent(key)}`),
  invalidateCacheEntry: (key: string) =>
    apiFetch<void>(`/debug/cache/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  invalidateCacheByPattern: (pattern: string, tenantId?: string) =>
    apiFetch<{ invalidated: number }>('/debug/cache/invalidate', { method: 'POST', body: JSON.stringify({ pattern, tenantId }) }),
  getCacheStats: (tenantId?: string) =>
    apiFetch<{
      totalEntries: number;
      totalSize: number;
      hitRate: number;
      missRate: number;
      byStore: Array<{ store: string; entries: number; size: number }>;
    }>(`/debug/cache/stats${tenantId ? `?tenantId=${tenantId}` : ''}`),

  // Feature Flag Overrides
  getFeatureOverrides: (params?: { tenantId?: string; isActive?: boolean } & PaginationParams) =>
    apiFetch<PaginatedResult<FeatureFlagOverride>>(`/debug/feature-overrides?${buildQueryString(params || {})}`),
  getFeatureOverride: (id: string) => apiFetch<FeatureFlagOverride>(`/debug/feature-overrides/${id}`),
  createFeatureOverride: (data: {
    tenantId: string;
    featureKey: string;
    overrideValue: unknown;
    adminId: string;
    reason?: string;
    expiresAt?: string;
  }) =>
    apiFetch<FeatureFlagOverride>('/debug/feature-overrides', { method: 'POST', body: JSON.stringify(data) }),
  revertFeatureOverride: (id: string, revertedBy: string) =>
    apiFetch<FeatureFlagOverride>(`/debug/feature-overrides/${id}/revert`, { method: 'POST', body: JSON.stringify({ revertedBy }) }),
  getActiveOverridesForTenant: (tenantId: string) =>
    apiFetch<FeatureFlagOverride[]>(`/debug/feature-overrides/tenant/${tenantId}/active`),
};

// ============================================================================
// Settings API (Extended)
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

export const settingsApi = {
  // System Settings
  getAll: () => apiFetch<Record<string, SystemSetting[]>>('/settings'),
  getByCategory: (category: string) => apiFetch<SystemSetting[]>(`/settings/category/${category}`),
  get: (key: string) => apiFetch<SystemSetting>(`/settings/${key}`),
  update: (key: string, value: unknown, updatedBy?: string) =>
    apiFetch<SystemSetting>(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value, updatedBy }) }),
  bulkUpdate: (settings: Array<{ key: string; value: unknown }>, updatedBy?: string) =>
    apiFetch<SystemSetting[]>('/settings/bulk', { method: 'PUT', body: JSON.stringify({ settings, updatedBy }) }),

  // Config Endpoints
  getEmailConfig: () => apiFetch<Record<string, unknown>>('/settings/config/email'),
  updateEmailConfig: (config: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>('/settings/config/email', { method: 'PUT', body: JSON.stringify(config) }),
  testEmailConfig: (to: string) =>
    apiFetch<{ success: boolean; message: string }>('/settings/config/email/test', { method: 'POST', body: JSON.stringify({ to }) }),
  getSecurityConfig: () => apiFetch<Record<string, unknown>>('/settings/config/security'),
  updateSecurityConfig: (config: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>('/settings/config/security', { method: 'PUT', body: JSON.stringify(config) }),
  getBillingConfig: () => apiFetch<Record<string, unknown>>('/settings/config/billing'),
  updateBillingConfig: (config: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>('/settings/config/billing', { method: 'PUT', body: JSON.stringify(config) }),
  getRateLimits: () => apiFetch<Record<string, unknown>>('/settings/config/rate-limits'),
  updateRateLimits: (config: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>('/settings/config/rate-limits', { method: 'PUT', body: JSON.stringify(config) }),
  getSystemInfo: () => apiFetch<Record<string, unknown>>('/settings/system/info'),

  // Tenant Configuration
  getTenantConfig: (tenantId: string) => apiFetch<TenantConfiguration>(`/settings/tenant/${tenantId}`),
  updateTenantConfig: (tenantId: string, config: Partial<TenantConfiguration>) =>
    apiFetch<TenantConfiguration>(`/settings/tenant/${tenantId}`, { method: 'PUT', body: JSON.stringify(config) }),
  createTenantApiKey: (tenantId: string, data: { name: string; scopes: string[]; expiresAt?: string }) =>
    apiFetch<{ apiKey: string; id: string }>(`/settings/tenant/${tenantId}/api-keys`, { method: 'POST', body: JSON.stringify(data) }),
  revokeTenantApiKey: (tenantId: string, keyId: string) =>
    apiFetch<void>(`/settings/tenant/${tenantId}/api-keys/${keyId}`, { method: 'DELETE' }),
  createWebhook: (tenantId: string, data: { url: string; events: string[] }) =>
    apiFetch<{ id: string; secret: string }>(`/settings/tenant/${tenantId}/webhooks`, { method: 'POST', body: JSON.stringify(data) }),
  deleteWebhook: (tenantId: string, webhookId: string) =>
    apiFetch<void>(`/settings/tenant/${tenantId}/webhooks/${webhookId}`, { method: 'DELETE' }),
  testWebhook: (tenantId: string, webhookId: string) =>
    apiFetch<{ success: boolean; statusCode: number; responseTime: number }>(`/settings/tenant/${tenantId}/webhooks/${webhookId}/test`, { method: 'POST' }),

  // Email Templates
  getEmailTemplates: () => apiFetch<EmailTemplate[]>('/settings/email-templates'),
  getEmailTemplate: (id: string) => apiFetch<EmailTemplate>(`/settings/email-templates/${id}`),
  getEmailTemplateByCode: (code: string) => apiFetch<EmailTemplate>(`/settings/email-templates/code/${code}`),
  createEmailTemplate: (data: Omit<EmailTemplate, 'id' | 'createdAt' | 'updatedAt'>) =>
    apiFetch<EmailTemplate>('/settings/email-templates', { method: 'POST', body: JSON.stringify(data) }),
  updateEmailTemplate: (id: string, data: Partial<EmailTemplate>) =>
    apiFetch<EmailTemplate>(`/settings/email-templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteEmailTemplate: (id: string) =>
    apiFetch<void>(`/settings/email-templates/${id}`, { method: 'DELETE' }),
  previewEmailTemplate: (id: string, sampleData: Record<string, unknown>) =>
    apiFetch<{ html: string; text: string; subject: string }>(`/settings/email-templates/${id}/preview`, { method: 'POST', body: JSON.stringify({ sampleData }) }),
  sendTestEmail: (id: string, to: string, sampleData: Record<string, unknown>) =>
    apiFetch<{ success: boolean }>(`/settings/email-templates/${id}/test`, { method: 'POST', body: JSON.stringify({ to, sampleData }) }),

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

// ============================================================================
// Tenants API (Extended)
// ============================================================================

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  description?: string;
  domain?: string;
  tier: TenantTier;
  status: TenantStatus;
  userCount: number;
  farmCount: number;
  sensorCount: number;
  limits?: TenantLimits;
  settings?: TenantSettings;
  primaryContact?: TenantContact;
  billingContact?: TenantContact;
  billingEmail?: string;
  country?: string;
  region?: string;
  trialEndsAt?: string;
  suspendedAt?: string;
  suspendedReason?: string;
  suspendedBy?: string;
  lastActivityAt?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  version?: number;
}

export interface TenantLimits {
  maxUsers: number;
  maxFarms: number;
  maxPonds: number;
  maxSensors: number;
  maxAlertRules: number;
  dataRetentionDays: number;
  apiRateLimit: number;
  storageGb: number;
}

export interface TenantSettings {
  timezone: string;
  locale: string;
  currency: string;
  dateFormat: string;
  measurementSystem: string;
  notificationPreferences: {
    email: boolean;
    sms: boolean;
    push: boolean;
    slack: boolean;
  };
  features: string[];
}

export interface TenantContact {
  name: string;
  email: string;
  phone?: string;
  role: string;
}

export interface TenantStats {
  total: number;
  active: number;
  suspended: number;
  pending: number;
  byTier: Record<TenantTier, number>;
}

export interface TenantDetail extends Tenant {
  userStats?: {
    total: number;
    active: number;
    inactive: number;
    byRole: Record<string, number>;
    recentlyActive: number;
    newUsersLast30Days: number;
  };
  resourceUsage?: {
    storage: { usedGb: number; limitGb: number; percentage: number };
    users: { count: number; limit: number; percentage: number };
    farms: { count: number; limit: number; percentage: number };
    sensors: { count: number; limit: number; percentage: number };
    apiCalls: { last24h: number; last7d: number; limit: number };
  };
  modules?: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    isActive: boolean;
    assignedAt: string;
  }>;
  recentActivities?: TenantActivity[];
  notes?: TenantNote[];
  billing?: {
    currentPlan: string;
    monthlyAmount: number;
    currency: string;
    billingCycle: string;
    paymentStatus: string;
    nextBillingDate: string | null;
    lastPaymentDate: string | null;
    lastPaymentAmount: number | null;
  };
}

export interface TenantActivity {
  id: string;
  tenantId: string;
  activityType: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  performedBy?: string;
  performedByEmail?: string;
  createdAt: string;
}

export interface TenantNote {
  id: string;
  tenantId: string;
  content: string;
  category: string;
  isPinned: boolean;
  createdBy: string;
  createdByEmail?: string;
  createdAt: string;
}

/**
 * Module quantity configuration for pricing calculation
 */
export interface ModuleQuantityConfig {
  moduleId: string;
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  employees?: number;
}

export interface CreateTenantDto {
  name: string;
  slug?: string;
  tier?: TenantTier;
  description?: string;
  domain?: string;
  primaryContact?: TenantContact;
  billingContact?: TenantContact;
  billingEmail?: string;
  country?: string;
  region?: string;
  trialDays?: number;
  maxUsers?: number;
  limits?: Partial<TenantLimits>;
  settings?: Partial<TenantSettings>;
  /**
   * Module IDs to assign to the tenant during creation
   * Super Admin selects which modules the tenant will have access to
   */
  moduleIds?: string[];
  /**
   * Optional quantity configuration per module for pricing calculation
   */
  moduleQuantities?: ModuleQuantityConfig[];
  /**
   * Billing cycle preference: monthly, quarterly, semi_annual, annual
   */
  billingCycle?: 'monthly' | 'quarterly' | 'semi_annual' | 'annual';
}

export interface UpdateTenantDto {
  name?: string;
  description?: string;
  domain?: string;
  tier?: TenantTier;
  primaryContact?: TenantContact;
  billingContact?: TenantContact;
  billingEmail?: string;
  country?: string;
  region?: string;
  limits?: Partial<TenantLimits>;
  settings?: Partial<TenantSettings>;
}

export const tenantsApi = {
  list: (params?: { status?: string; tier?: string; search?: string; page?: number; limit?: number }) =>
    apiFetch<PaginatedResult<Tenant>>(`/tenants?${buildQueryString(params || {})}`),
  getById: (id: string) => apiFetch<Tenant>(`/tenants/${id}`),
  getDetail: (id: string) => apiFetch<TenantDetail>(`/tenants/${id}/detail`),
  getBySlug: (slug: string) => apiFetch<Tenant>(`/tenants/slug/${slug}`),
  getStats: () => apiFetch<TenantStats>('/tenants/stats'),
  getUsage: (id: string) => apiFetch<Record<string, unknown>>(`/tenants/${id}/usage`),
  getActivities: (id: string, page?: number, limit?: number) =>
    apiFetch<PaginatedResult<TenantActivity>>(`/tenants/${id}/activities?page=${page || 1}&limit=${limit || 20}`),
  getNotes: (id: string, category?: string) =>
    apiFetch<TenantNote[]>(`/tenants/${id}/notes${category ? `?category=${category}` : ''}`),
  createNote: (id: string, data: { content: string; category?: string; isPinned?: boolean }) =>
    apiFetch<TenantNote>(`/tenants/${id}/notes`, { method: 'POST', body: JSON.stringify(data) }),
  updateNote: (tenantId: string, noteId: string, data: { content?: string; isPinned?: boolean; category?: string }) =>
    apiFetch<TenantNote>(`/tenants/${tenantId}/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteNote: (tenantId: string, noteId: string) =>
    apiFetch<void>(`/tenants/${tenantId}/notes/${noteId}`, { method: 'DELETE' }),
  create: (data: CreateTenantDto) =>
    apiFetch<Tenant>('/tenants', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: UpdateTenantDto) =>
    apiFetch<Tenant>(`/tenants/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  suspend: (id: string, reason: string) =>
    apiFetch<Tenant>(`/tenants/${id}/suspend`, { method: 'PATCH', body: JSON.stringify({ reason }) }),
  activate: (id: string) => apiFetch<Tenant>(`/tenants/${id}/activate`, { method: 'PATCH' }),
  deactivate: (id: string, reason: string) =>
    apiFetch<Tenant>(`/tenants/${id}/deactivate`, { method: 'PATCH', body: JSON.stringify({ reason }) }),
  archive: (id: string) => apiFetch<void>(`/tenants/${id}`, { method: 'DELETE' }),
  search: (q: string, limit?: number) =>
    apiFetch<Tenant[]>(`/tenants/search?q=${encodeURIComponent(q)}&limit=${limit || 20}`),
  getApproachingLimits: (threshold?: number) =>
    apiFetch<Tenant[]>(`/tenants/approaching-limits?threshold=${threshold || 80}`),
  getExpiringTrials: (withinDays?: number) =>
    apiFetch<Tenant[]>(`/tenants/expiring-trials?withinDays=${withinDays || 7}`),
  bulkSuspend: (tenantIds: string[], reason: string) =>
    apiFetch<{ success: string[]; failed: string[] }>('/tenants/bulk/suspend', {
      method: 'POST',
      body: JSON.stringify({ tenantIds, reason }),
    }),
  bulkActivate: (tenantIds: string[]) =>
    apiFetch<{ success: string[]; failed: string[] }>('/tenants/bulk/activate', {
      method: 'POST',
      body: JSON.stringify({ tenantIds }),
    }),
};

// ============================================================================
// Users API
// ============================================================================

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  tenantId: string | null;
  tenantName: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface UserStats {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  usersByRole: Array<{ role: string; count: number }>;
  usersByTenant: Array<{ tenantId: string; tenantName: string; count: number }>;
  newUsersLast30Days: number;
  loginsLast24Hours: number;
}

export interface CreateUserDto {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  role: string;
  tenantId?: string;
}

export interface InviteUserDto {
  tenantId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  moduleIds?: string[];
  primaryModuleId?: string;
  message?: string;
  invitedBy: string;
}

export interface Permission {
  code: string;
  name: string;
  description: string;
  category: string;
}

export interface RoleTemplate {
  code: string;
  name: string;
  description: string;
  level: number;
  permissions: string[];
  isSystem: boolean;
  color: string;
  icon: string;
}

export interface RoleHierarchyItem {
  code: string;
  name: string;
  description: string;
  level: number;
  permissions: string[];
  isSystem: boolean;
  color: string;
  icon: string;
  userCount?: number;
  children?: RoleHierarchyItem[];
}

export interface UserLimitCheckResult {
  canCreate: boolean;
  currentCount: number;
  limit: number;
  remaining: number;
  message?: string;
}

export const usersApi = {
  list: (params?: { tenantId?: string; role?: string; status?: string; search?: string; page?: number; limit?: number }) =>
    apiFetch<PaginatedResult<User>>(`/users?${buildQueryString(params || {})}`),
  getById: (id: string) => apiFetch<User>(`/users/${id}`),
  getStats: () => apiFetch<UserStats>('/users/stats'),
  getByTenant: (tenantId: string, page?: number, limit?: number) =>
    apiFetch<PaginatedResult<User>>(`/users/by-tenant/${tenantId}?page=${page || 1}&limit=${limit || 20}`),
  getRecentActivity: (limit?: number) => apiFetch<User[]>(`/users/recent-activity?limit=${limit || 50}`),
  getUserActivity: (userId: string, limit?: number) =>
    apiFetch<unknown[]>(`/users/${userId}/activity?limit=${limit || 50}`),
  getUserSessions: (userId: string) => apiFetch<unknown[]>(`/users/${userId}/sessions`),
  create: (data: CreateUserDto) =>
    apiFetch<User>('/users', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<CreateUserDto & { isActive?: boolean }>) =>
    apiFetch<User>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  activate: (id: string) => apiFetch<User>(`/users/${id}/activate`, { method: 'PATCH' }),
  deactivate: (id: string) => apiFetch<User>(`/users/${id}/deactivate`, { method: 'PATCH' }),
  resetPassword: (id: string, newPassword: string) =>
    apiFetch<{ success: boolean }>(`/users/${id}/reset-password`, { method: 'PATCH', body: JSON.stringify({ newPassword }) }),
  forceLogout: (id: string) => apiFetch<{ success: boolean; count: number }>(`/users/${id}/force-logout`, { method: 'PATCH' }),
  delete: (id: string) => apiFetch<void>(`/users/${id}`, { method: 'DELETE' }),
  invite: (data: InviteUserDto) =>
    apiFetch<{ success: boolean; userId: string; invitationId: string; invitationToken: string }>('/users/invite', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  checkTenantLimit: (tenantId: string) =>
    apiFetch<UserLimitCheckResult>(`/users/tenant/${tenantId}/limit`),
  getRoleTemplates: () => apiFetch<RoleTemplate[]>('/users/roles/templates'),
  getAssignableRoles: (roleCode: string) =>
    apiFetch<RoleTemplate[]>(`/users/roles/assignable/${roleCode}`),
  getPermissions: () => apiFetch<Permission[]>('/users/roles/permissions'),
  getPermissionsByCategory: () =>
    apiFetch<Record<string, Permission[]>>('/users/roles/permissions/grouped'),
  getRoleHierarchy: () => apiFetch<RoleHierarchyItem[]>('/users/roles/hierarchy'),
  canAssignRole: (assignerRole: string, targetRole: string) =>
    apiFetch<{ allowed: boolean; reason?: string }>(`/users/roles/can-assign?assignerRole=${assignerRole}&targetRole=${targetRole}`),
  getRolePermissions: (roleCode: string) =>
    apiFetch<string[]>(`/users/roles/${roleCode}/permissions`),
};

// ============================================================================
// Modules API
// ============================================================================

export interface SystemModule {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultRoute: string;
  icon: string | null;
  isCore: boolean;
  isActive: boolean;
  price: number;
  tenantsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModuleStats {
  totalModules: number;
  activeModules: number;
  coreModules: number;
  totalAssignments: number;
  moduleUsage: Array<{ moduleId: string; moduleName: string; tenantsCount: number }>;
}

export interface TenantModuleAssignment {
  id: string;
  tenantId: string;
  tenantName: string;
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  assignedAt: string;
  expiresAt: string | null;
}

export const modulesApi = {
  list: (params?: { isActive?: boolean; isCore?: boolean; search?: string; page?: number; limit?: number }) =>
    apiFetch<PaginatedResult<SystemModule>>(`/modules?${buildQueryString(params || {})}`),
  getById: (id: string) => apiFetch<SystemModule>(`/modules/${id}`),
  getByCode: (code: string) => apiFetch<SystemModule>(`/modules/code/${code}`),
  getStats: () => apiFetch<ModuleStats>('/modules/stats'),
  getModuleTenants: (moduleId: string, page?: number, limit?: number) =>
    apiFetch<PaginatedResult<unknown>>(`/modules/${moduleId}/tenants?page=${page || 1}&limit=${limit || 50}`),
  getAllAssignments: (params?: { tenantId?: string; moduleId?: string; page?: number; limit?: number }) =>
    apiFetch<PaginatedResult<TenantModuleAssignment>>(`/modules/assignments?${buildQueryString(params || {})}`),
  create: (data: { code: string; name: string; description?: string; defaultRoute: string; icon?: string; isCore?: boolean; price?: number }) =>
    apiFetch<SystemModule>('/modules', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<{ name: string; description: string; defaultRoute: string; icon: string; isActive: boolean; price: number }>) =>
    apiFetch<SystemModule>(`/modules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  activate: (id: string) => apiFetch<SystemModule>(`/modules/${id}/activate`, { method: 'PATCH' }),
  deactivate: (id: string) => apiFetch<SystemModule>(`/modules/${id}/deactivate`, { method: 'PATCH' }),
  delete: (id: string) => apiFetch<void>(`/modules/${id}`, { method: 'DELETE' }),
  assignToTenant: (tenantId: string, moduleId: string, options?: { quantities?: ModuleQuantities; configuration?: Record<string, unknown>; expiresAt?: string }) =>
    apiFetch<TenantModuleAssignment>('/modules/assignments', {
      method: 'POST',
      body: JSON.stringify({
        tenantId,
        moduleId,
        quantities: options?.quantities,
        configuration: options?.configuration,
        expiresAt: options?.expiresAt,
      }),
    }),
  removeFromTenant: (tenantId: string, moduleId: string) =>
    apiFetch<void>(`/modules/assignments/${tenantId}/${moduleId}`, { method: 'DELETE' }),
};

// ============================================================================
// Audit API
// ============================================================================

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  tenantId: string | null;
  performedBy: string;
  performedByEmail: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  metadata: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface AuditLogStats {
  totalLogs: number;
  last24Hours: number;
  bySeverity: Array<{ severity: string; count: number }>;
  byAction: Array<{ action: string; count: number }>;
  topUsers: Array<{ userId: string; email: string; count: number }>;
}

export const auditApi = {
  query: (params?: {
    action?: string;
    entityType?: string;
    entityId?: string;
    tenantId?: string;
    performedBy?: string;
    severity?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) => apiFetch<PaginatedResult<AuditLog>>(`/audit-logs?${buildQueryString(params || {})}`),
  getEntityHistory: (entityType: string, entityId: string, limit?: number) =>
    apiFetch<AuditLog[]>(`/audit-logs/entity/${entityType}/${entityId}?limit=${limit || 100}`),
  getUserActivity: (userId: string, startDate?: string, endDate?: string, limit?: number) =>
    apiFetch<AuditLog[]>(`/audit-logs/user/${userId}?${buildQueryString({ startDate, endDate, limit })}`),
  getSecurityLogs: (tenantId?: string, limit?: number) =>
    apiFetch<AuditLog[]>(`/audit-logs/security?${buildQueryString({ tenantId, limit })}`),
  getStatistics: (tenantId?: string, startDate?: string, endDate?: string) =>
    apiFetch<AuditLogStats>(`/audit-logs/statistics?${buildQueryString({ tenantId, startDate, endDate })}`),
};

// ============================================================================
// Billing API
// ============================================================================

export enum PlanTier {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
  CUSTOM = 'custom',
}

export enum BillingCycle {
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  SEMI_ANNUAL = 'semi_annual',
  ANNUAL = 'annual',
}

export enum SubscriptionStatus {
  TRIAL = 'trial',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELLED = 'cancelled',
  SUSPENDED = 'suspended',
  EXPIRED = 'expired',
}

export enum DiscountType {
  PERCENTAGE = 'percentage',
  FIXED_AMOUNT = 'fixed_amount',
  FREE_TRIAL_EXTENSION = 'free_trial_extension',
  FREE_MONTHS = 'free_months',
}

export enum DiscountAppliesTo {
  ALL_PLANS = 'all_plans',
  SPECIFIC_PLANS = 'specific_plans',
  UPGRADES_ONLY = 'upgrades_only',
  NEW_CUSTOMERS_ONLY = 'new_customers_only',
}

export enum DiscountDuration {
  ONCE = 'once',
  FOREVER = 'forever',
  REPEATING = 'repeating',
}

export interface PlanPricing {
  basePrice: number;
  perUserPrice: number;
  perFarmPrice: number;
  perModulePrice: number;
  discountPercent?: number;
}

export interface PlanLimits {
  maxUsers: number;
  maxFarms: number;
  maxSensors: number;
  maxPonds: number;
  storageGB: number;
  apiCallsPerMonth: number;
  dataRetentionDays: number;
  customReports: boolean;
  advancedAnalytics: boolean;
  apiAccess: boolean;
  whiteLabeling: boolean;
  ssoEnabled: boolean;
  prioritySupport: boolean;
  [key: string]: number | boolean;
}

export interface PlanFeatures {
  coreFeatures: string[];
  advancedFeatures: string[];
  premiumFeatures: string[];
}

export interface PlanDefinition {
  id: string;
  code: string;
  name: string;
  description?: string;
  shortDescription?: string;
  tier: PlanTier;
  visibility: string;
  isActive: boolean;
  isRecommended: boolean;
  sortOrder: number;
  badge?: string;
  limits: PlanLimits;
  pricing: {
    monthly: PlanPricing;
    quarterly: PlanPricing;
    semiAnnual: PlanPricing;
    annual: PlanPricing;
  };
  features: PlanFeatures;
  trialDays?: number;
  gracePeriodDays?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DiscountCode {
  id: string;
  code: string;
  name: string;
  description?: string;
  discountType: DiscountType;
  discountValue: number;
  appliesTo: DiscountAppliesTo;
  duration: DiscountDuration;
  durationInMonths?: number;
  isActive: boolean;
  validFrom?: string;
  validUntil?: string;
  maxRedemptions?: number;
  maxRedemptionsPerTenant?: number;
  currentRedemptions: number;
  campaignId?: string;
  campaignName?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscountStats {
  totalCodes: number;
  activeCodes: number;
  expiredCodes: number;
  totalRedemptions: number;
  totalDiscountAmount: number;
  topCodes: Array<{
    code: string;
    redemptions: number;
    totalDiscount: number;
  }>;
}

export interface CreateDiscountCodeDto {
  code: string;
  name: string;
  description?: string;
  discountType: DiscountType;
  discountValue: number;
  appliesTo: DiscountAppliesTo;
  duration: DiscountDuration;
  durationInMonths?: number;
  validFrom?: string;
  validUntil?: string;
  maxRedemptions?: number;
  maxRedemptionsPerTenant?: number;
  campaignId?: string;
  campaignName?: string;
  createdBy: string;
}

export interface SubscriptionOverview {
  id: string;
  tenantId: string;
  tenantName: string;
  planTier: string;
  planName: string;
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  monthlyPrice: number;
  autoRenew: boolean;
  trialEndDate?: string;
  cancelledAt?: string;
  createdAt: string;
}

export interface SubscriptionStats {
  totalSubscriptions: number;
  byStatus: Record<string, number>;
  byPlanTier: Record<string, number>;
  byBillingCycle: Record<string, number>;
  mrr: number;
  arr: number;
  churnRate: number;
  averageRevenuePerUser: number;
  trialConversionRate: number;
  expiringThisMonth: number;
  pastDueCount: number;
  totalRevenue: number;
}

export interface InvoiceOverview {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  tenantName: string;
  tenantEmail?: string;
  amount: number;
  amountPaid: number;
  amountDue: number;
  status: string;
  currency: string;
  dueDate: string;
  paidAt?: string | null;
  issueDate: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

export interface InvoiceStats {
  totalInvoices: number;
  totalAmount: number;
  totalPaid: number;
  totalPending: number;
  totalOverdue: number;
  byStatus: Record<string, { count: number; amount: number }>;
  byCurrency: Record<string, number>;
  avgPaymentTime: number;
  overdueRate: number;
  paidThisMonth: number;
  pendingThisMonth: number;
}

export const billingApi = {
  // Plans
  getPlans: (includeInactive = false) =>
    apiFetch<PlanDefinition[]>(`/billing/plans?includeInactive=${includeInactive}`),
  getPublicPlans: () => apiFetch<PlanDefinition[]>('/billing/plans/public'),
  getPlanById: (id: string) => apiFetch<PlanDefinition>(`/billing/plans/${id}`),
  getPlanByCode: (code: string) => apiFetch<PlanDefinition>(`/billing/plans/code/${code}`),
  createPlan: (data: Partial<PlanDefinition>) =>
    apiFetch<PlanDefinition>('/billing/plans', { method: 'POST', body: JSON.stringify(data) }),
  updatePlan: (id: string, data: Partial<PlanDefinition>) =>
    apiFetch<PlanDefinition>(`/billing/plans/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deprecatePlan: (id: string, updatedBy: string) =>
    apiFetch<PlanDefinition>(`/billing/plans/${id}/deprecate`, { method: 'POST', body: JSON.stringify({ updatedBy }) }),
  comparePlans: (currentPlanId: string, newPlanId: string) =>
    apiFetch<Record<string, unknown>>('/billing/plans/compare', { method: 'POST', body: JSON.stringify({ currentPlanId, newPlanId }) }),
  seedPlans: (createdBy: string) =>
    apiFetch<{ success: boolean }>('/billing/plans/seed', { method: 'POST', body: JSON.stringify({ createdBy }) }),
  getPlanByTier: (tier: string) =>
    apiFetch<PlanDefinition>(`/billing/plans/tier/${tier}`),
  getDefaultLimitsForTier: (tier: string) =>
    apiFetch<{ users: number; farms: number; sensors: number; storage: number; apiCallsPerDay: number }>(`/billing/plans/defaults/${tier}`),

  // Discount Codes
  getDiscountCodes: (options?: { isActive?: boolean; includeExpired?: boolean }) =>
    apiFetch<DiscountCode[]>(`/billing/discounts?${buildQueryString(options || {})}`),
  getDiscountStats: () => apiFetch<DiscountStats>('/billing/discounts/stats'),
  getDiscountById: (id: string) => apiFetch<DiscountCode>(`/billing/discounts/${id}`),
  getDiscountByCode: (code: string) => apiFetch<{ found: boolean; discount?: DiscountCode }>(`/billing/discounts/code/${code}`),
  createDiscountCode: (data: Partial<DiscountCode>) =>
    apiFetch<DiscountCode>('/billing/discounts', { method: 'POST', body: JSON.stringify(data) }),
  updateDiscountCode: (id: string, data: Partial<DiscountCode>) =>
    apiFetch<DiscountCode>(`/billing/discounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deactivateDiscountCode: (id: string, updatedBy: string) =>
    apiFetch<DiscountCode>(`/billing/discounts/${id}/deactivate`, { method: 'POST', body: JSON.stringify({ updatedBy }) }),
  validateDiscountCode: (code: string, tenantId: string, planId?: string, orderAmount?: number) =>
    apiFetch<{ valid: boolean; discountCode?: DiscountCode; discountAmount?: number }>('/billing/discounts/validate', {
      method: 'POST',
      body: JSON.stringify({ code, tenantId, planId, orderAmount }),
    }),
  generateUniqueCode: (prefix?: string, length?: number) =>
    apiFetch<{ code: string }>('/billing/discounts/generate-code', { method: 'POST', body: JSON.stringify({ prefix, length }) }),
  applyDiscount: (tenantId: string, discountCodeId: string, appliedBy: string) =>
    apiFetch<{ success: boolean; redemptionId: string }>('/billing/discounts/apply', {
      method: 'POST',
      body: JSON.stringify({ tenantId, discountCodeId, appliedBy }),
    }),
  bulkCreateDiscounts: (data: { codes: Array<Partial<DiscountCode>>; createdBy: string }) =>
    apiFetch<{ created: number; codes: DiscountCode[] }>('/billing/discounts/bulk-create', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getDiscountRedemptions: (discountId: string) =>
    apiFetch<Array<{ id: string; tenantId: string; tenantName: string; redeemedAt: string; amount: number }>>(`/billing/discounts/${discountId}/redemptions`),
  getTenantRedemptions: (tenantId: string) =>
    apiFetch<Array<{ id: string; discountCode: string; redeemedAt: string; amount: number }>>(`/billing/tenant/${tenantId}/redemptions`),

  // Subscriptions
  createSubscription: (data: CreateSubscriptionDto) =>
    apiFetch<CreateSubscriptionResult>('/billing/subscriptions', { method: 'POST', body: JSON.stringify(data) }),
  getSubscriptions: (filters?: {
    status?: SubscriptionStatus[];
    planTier?: PlanTier[];
    search?: string;
    limit?: number;
    offset?: number;
  }) => apiFetch<{ subscriptions: SubscriptionOverview[]; total: number }>(`/billing/subscriptions?${buildQueryString(filters || {})}`),
  getSubscriptionStats: () => apiFetch<SubscriptionStats>('/billing/subscriptions/stats'),
  getSubscriptionReminders: () =>
    apiFetch<Array<{ tenantId: string; tenantName: string; daysUntilExpiry: number; type: 'trial' | 'subscription' }>>('/billing/subscriptions/reminders'),
  getSubscriptionByTenant: (tenantId: string) =>
    apiFetch<SubscriptionOverview | null>(`/billing/subscriptions/tenant/${tenantId}`),
  changePlan: (request: { tenantId: string; currentPlanId: string; newPlanId: string; changedBy: string }) =>
    apiFetch<Record<string, unknown>>('/billing/subscriptions/change-plan', { method: 'POST', body: JSON.stringify(request) }),
  cancelSubscription: (tenantId: string, reason: string, cancelledBy: string) =>
    apiFetch<{ success: boolean }>(`/billing/subscriptions/tenant/${tenantId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason, cancelledBy }),
    }),
  reactivateSubscription: (tenantId: string, reactivatedBy: string) =>
    apiFetch<{ success: boolean }>(`/billing/subscriptions/tenant/${tenantId}/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ reactivatedBy }),
    }),
  extendTrial: (tenantId: string, additionalDays: number, extendedBy: string) =>
    apiFetch<{ success: boolean; newTrialEnd: string }>(`/billing/subscriptions/tenant/${tenantId}/extend-trial`, {
      method: 'POST',
      body: JSON.stringify({ additionalDays, extendedBy }),
    }),
  processRenewals: () =>
    apiFetch<{ processed: number; failed: number; renewals: Array<{ tenantId: string; success: boolean; message?: string }> }>('/billing/subscriptions/process-renewals', {
      method: 'POST',
    }),

  // Invoices
  getInvoices: (params?: { status?: string; search?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.append('status', params.status);
    if (params?.search) searchParams.append('search', params.search);
    if (params?.limit) searchParams.append('limit', String(params.limit));
    if (params?.offset) searchParams.append('offset', String(params.offset));
    return apiFetch<{ invoices: InvoiceOverview[]; total: number }>(
      `/billing/invoices?${searchParams.toString()}`
    );
  },
  getInvoiceStats: () =>
    apiFetch<InvoiceStats>('/billing/invoices/stats'),
  getInvoiceById: (invoiceId: string) =>
    apiFetch<InvoiceOverview>(`/billing/invoices/${invoiceId}`),
  markInvoicePaid: (invoiceId: string, paidAmount: number, markedBy: string) =>
    apiFetch<{ success: boolean; invoice: InvoiceOverview }>(`/billing/invoices/${invoiceId}/mark-paid`, {
      method: 'POST',
      body: JSON.stringify({ paidAmount, markedBy }),
    }),
  voidInvoice: (invoiceId: string, reason: string, voidedBy: string) =>
    apiFetch<{ success: boolean }>(`/billing/invoices/${invoiceId}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason, voidedBy }),
    }),

  // Module Pricing
  getModulePricings: () =>
    apiFetch<ModulePricing[]>('/billing/module-pricing'),
  getModulePricingByCode: (moduleCode: string) =>
    apiFetch<ModulePricing | null>(`/billing/module-pricing/code/${moduleCode}`),
  getModulePricingWithModules: () =>
    apiFetch<ModulePricingWithModule[]>('/billing/module-pricing/with-modules'),
  setModulePricing: (data: SetModulePricingDto) =>
    apiFetch<ModulePricing>('/billing/module-pricing', { method: 'POST', body: JSON.stringify(data) }),
  updateModulePricing: (pricingId: string, data: Partial<SetModulePricingDto>) =>
    apiFetch<ModulePricing>(`/billing/module-pricing/${pricingId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deactivateModulePricing: (pricingId: string) =>
    apiFetch<{ success: boolean }>(`/billing/module-pricing/${pricingId}/deactivate`, { method: 'POST' }),
  seedModulePricing: (moduleIdMap: Record<string, string>) =>
    apiFetch<{ success: boolean; seededCount: number }>('/billing/module-pricing/seed', {
      method: 'POST',
      body: JSON.stringify({ moduleIdMap }),
    }),

  // Pricing Calculator
  calculatePricing: (request: QuoteRequest) =>
    apiFetch<PricingCalculation>('/billing/pricing/calculate', { method: 'POST', body: JSON.stringify(request) }),
  getQuickEstimate: (moduleCodes: string[], tier: PlanTier, quantities?: ModuleQuantities) =>
    apiFetch<{ monthlyTotal: number; annualTotal: number }>('/billing/pricing/quick-estimate', {
      method: 'POST',
      body: JSON.stringify({ moduleCodes, tier, quantities }),
    }),
  comparePricing: (config1: QuoteRequest, config2: QuoteRequest) =>
    apiFetch<PricingComparisonResult>('/billing/pricing/compare', {
      method: 'POST',
      body: JSON.stringify({ config1, config2 }),
    }),

  // Custom Plans
  getCustomPlans: (filter?: CustomPlanFilter) =>
    apiFetch<PaginatedCustomPlans>(`/billing/custom-plans?${buildQueryString((filter || {}) as Record<string, unknown>)}`),
  getCustomPlan: (planId: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}`),
  getCustomPlanByTenant: (tenantId: string) =>
    apiFetch<CustomPlan | null>(`/billing/custom-plans/tenant/${tenantId}`),
  createCustomPlan: (data: CreateCustomPlanDto) =>
    apiFetch<CustomPlan>('/billing/custom-plans', { method: 'POST', body: JSON.stringify(data) }),
  updateCustomPlan: (planId: string, data: UpdateCustomPlanDto) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}`, { method: 'PUT', body: JSON.stringify(data) }),
  submitCustomPlanForApproval: (planId: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}/submit`, { method: 'POST' }),
  approveCustomPlan: (planId: string, approverId: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}/approve`, { method: 'POST', body: JSON.stringify({ approverId }) }),
  rejectCustomPlan: (planId: string, reason: string, rejectedBy: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}/reject`, { method: 'POST', body: JSON.stringify({ reason, rejectedBy }) }),
  activateCustomPlan: (planId: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}/activate`, { method: 'POST' }),
  deleteCustomPlan: (planId: string) =>
    apiFetch<{ success: boolean }>(`/billing/custom-plans/${planId}`, { method: 'DELETE' }),
  cloneCustomPlan: (planId: string, newTenantId: string) =>
    apiFetch<CustomPlan>(`/billing/custom-plans/${planId}/clone`, { method: 'POST', body: JSON.stringify({ newTenantId }) }),
};

// ============================================================================
// Module Pricing Types
// ============================================================================

export enum PricingMetricType {
  BASE_PRICE = 'base_price',
  PER_USER = 'per_user',
  PER_FARM = 'per_farm',
  PER_POND = 'per_pond',
  PER_SENSOR = 'per_sensor',
  PER_DEVICE = 'per_device',
  PER_GB_STORAGE = 'per_gb_storage',
  PER_API_CALL = 'per_api_call',
  PER_ALERT = 'per_alert',
  PER_REPORT = 'per_report',
  PER_SMS = 'per_sms',
  PER_EMAIL = 'per_email',
  PER_INTEGRATION = 'per_integration',
}

export interface PricingMetric {
  type: PricingMetricType;
  price: number;
  currency: string;
  description?: string;
  minQuantity?: number;
  maxQuantity?: number;
  includedQuantity?: number;
}

export interface TierMultipliers {
  [PlanTier.FREE]?: number;
  [PlanTier.STARTER]?: number;
  [PlanTier.PROFESSIONAL]?: number;
  [PlanTier.ENTERPRISE]?: number;
  [PlanTier.CUSTOM]?: number;
}

export interface ModulePricing {
  id: string;
  moduleId: string;
  moduleCode: string;
  pricingMetrics: PricingMetric[];
  tierMultipliers: TierMultipliers;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  notes: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModulePricingWithModule extends ModulePricing {
  moduleName?: string;
  moduleDescription?: string;
  moduleIcon?: string;
  isModuleActive?: boolean;
}

export interface SetModulePricingDto {
  moduleId: string;
  moduleCode: string;
  pricingMetrics: PricingMetric[];
  tierMultipliers?: TierMultipliers;
  currency?: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  notes?: string;
}

export interface ModuleQuantities {
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
}

export interface ModuleSelection {
  moduleId: string;
  moduleCode: string;
  moduleName?: string;
  quantities: ModuleQuantities;
}

export interface QuoteRequest {
  modules: ModuleSelection[];
  tier: PlanTier;
  billingCycle: BillingCycle;
  discountCode?: string;
  taxRate?: number;
}

export interface PricingLineItem {
  metric: PricingMetricType;
  metricLabel: string;
  quantity: number;
  includedQuantity: number;
  billableQuantity: number;
  unitPrice: number;
  total: number;
  tierMultiplier: number;
}

export interface ModulePriceBreakdown {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  lineItems: PricingLineItem[];
  subtotal: number;
  tierDiscount: number;
  total: number;
}

export interface PricingCalculation {
  modules: ModulePriceBreakdown[];
  subtotal: number;
  tierDiscount: number;
  discount: {
    code?: string;
    description?: string;
    amount: number;
    percent: number;
  };
  tax: number;
  taxRate: number;
  total: number;
  monthlyTotal: number;
  annualTotal: number;
  billingCycle: BillingCycle;
  billingCycleMultiplier: number;
  currency: string;
  tier: PlanTier;
  calculatedAt: string;
}

export interface PricingComparisonResult {
  config1: PricingCalculation;
  config2: PricingCalculation;
  difference: number;
  percentDifference: number;
  recommendation: string;
}

// ============================================================================
// Subscription Creation Types
// ============================================================================

export interface ModuleLineItem {
  metric: string;
  quantity: number;
  unitPrice: number;
  total: number;
  description?: string;
}

export interface SubscriptionModuleConfig {
  moduleId: string;
  moduleCode: string;
  moduleName?: string;
  quantities: ModuleQuantities;
  lineItems?: ModuleLineItem[];
  subtotal: number;
}

export interface CreateSubscriptionDto {
  tenantId: string;
  planTier?: PlanTier;
  billingCycle?: BillingCycle;
  modules: SubscriptionModuleConfig[];
  monthlyTotal: number;
  currency?: string;
  trialDays?: number;
  discountCode?: string;
  createdBy?: string;
}

export interface CreateSubscriptionResult {
  success: boolean;
  subscription: {
    id: string;
    tenantId: string;
    status: SubscriptionStatus;
    planTier: PlanTier;
    billingCycle: BillingCycle;
    monthlyPrice: number;
    trialEndDate?: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
  };
  moduleItems: Array<{
    id: string;
    moduleId: string;
    moduleCode: string;
    quantities: ModuleQuantities;
    monthlyPrice: number;
  }>;
  message: string;
}

// ============================================================================
// Custom Plan Types
// ============================================================================

export enum CustomPlanStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  ACTIVE = 'active',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

export interface CustomPlanLineItem {
  metric: string;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface CustomPlanModule {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  quantities: ModuleQuantities;
  lineItems: CustomPlanLineItem[];
  subtotal: number;
}

export interface CustomPlan {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  basePlanId?: string;
  tier: PlanTier;
  billingCycle: BillingCycle;
  modules: CustomPlanModule[];
  monthlySubtotal: number;
  discountPercent: number;
  discountAmount: number;
  discountReason?: string;
  monthlyTotal: number;
  currency: string;
  status: CustomPlanStatus;
  validFrom: string;
  validTo?: string;
  notes?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectionReason?: string;
  subscriptionId?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomPlanFilter {
  tenantId?: string;
  status?: CustomPlanStatus;
  tier?: PlanTier;
  search?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedCustomPlans {
  items: CustomPlan[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CreateCustomPlanDto {
  tenantId: string;
  name: string;
  description?: string;
  basePlanId?: string;
  tier?: PlanTier;
  billingCycle?: BillingCycle;
  modules: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    quantities: ModuleQuantities;
  }>;
  discountPercent?: number;
  discountAmount?: number;
  discountReason?: string;
  validFrom: string;
  validTo?: string;
  notes?: string;
  createdBy?: string;
}

export interface UpdateCustomPlanDto {
  name?: string;
  description?: string;
  modules?: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    quantities: ModuleQuantities;
  }>;
  discountPercent?: number;
  discountAmount?: number;
  discountReason?: string;
  validFrom?: string;
  validTo?: string;
  notes?: string;
  updatedBy?: string;
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  system: systemApi,
  analytics: analyticsApi,
  reports: reportsApi,
  database: databaseApi,
  support: supportApi,
  security: securityApi,
  systemSettings: systemSettingsApi,
  impersonation: impersonationApi,
  debug: debugApi,
  settings: settingsApi,
  tenants: tenantsApi,
  users: usersApi,
  modules: modulesApi,
  audit: auditApi,
  billing: billingApi,
};
