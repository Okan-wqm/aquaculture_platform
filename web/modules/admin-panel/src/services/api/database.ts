/**
 * Database Management API
 *
 * Backend controller'lara uyumlu API fonksiyonlari.
 * Path'ler admin-api-service controller'larindan dogrulanmistir:
 *   - schema.controller.ts: /database/schemas
 *   - migration.controller.ts: /database/migrations
 *   - monitoring.controller.ts: /database/monitoring
 */

import { apiFetch, buildQueryString, ADMIN_API_URL } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  DateRangeParams,
  TenantSchema,
  SchemaMigration,
  DatabaseStats,
  SlowQuery,
} from '../types';

export const databaseApi = {
  // ==========================================================================
  // Schema Management (schema.controller.ts)
  // ==========================================================================

  getSchemas: (params?: { status?: string; search?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<TenantSchema>>(`/database/schemas?${buildQueryString(params || {})}`),
  getSchema: (tenantId: string) => apiFetch<TenantSchema>(`/database/schemas/${tenantId}`),
  getSchemaSummary: () =>
    apiFetch<{ total: number; active: number; suspended: number; deleted: number }>(
      '/database/schemas/summary',
    ),
  getSchemaInfo: (tenantId: string) =>
    apiFetch<{ schemaName: string; tableCount: number; sizeBytes: number; rowCount: number }>(
      `/database/schemas/${tenantId}/info`,
    ),
  createSchema: (tenantId: string) =>
    apiFetch<TenantSchema>('/database/schemas', {
      method: 'POST',
      body: JSON.stringify({ tenantId }),
    }),
  deleteSchema: (tenantId: string, options?: { hardDelete?: boolean }) =>
    apiFetch<void>(`/database/schemas/${tenantId}?${buildQueryString(options || {})}`, {
      method: 'DELETE',
    }),
  suspendSchema: (tenantId: string) =>
    apiFetch<TenantSchema>(`/database/schemas/${tenantId}/suspend`, { method: 'POST' }),
  activateSchema: (tenantId: string) =>
    apiFetch<TenantSchema>(`/database/schemas/${tenantId}/activate`, { method: 'POST' }),
  syncSchemas: (data?: { tenantId?: string; modules?: string[] }) =>
    apiFetch<{ synced: number; errors: string[] }>('/database/schemas/sync', {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),
  validateSchemaIsolation: (tenantId: string) =>
    apiFetch<{ valid: boolean; issues: string[] }>(`/database/schemas/${tenantId}/validate`),
  refreshSchemaStats: (tenantId: string) =>
    apiFetch<TenantSchema>(`/database/schemas/${tenantId}/refresh-stats`, { method: 'POST' }),
  getConnectionPoolStatus: () =>
    apiFetch<{
      total: number;
      active: number;
      idle: number;
      waiting: number;
      maxConnections: number;
    }>('/database/schemas/connections/pool'),
  getConnectionsByTenant: () =>
    apiFetch<Array<{ tenantId: string; schemaName: string; connectionCount: number }>>(
      '/database/schemas/connections/by-tenant',
    ),

  // Backend endpoint coverage: resetSchema, optimizeSchema, analyzeSchema
  resetSchema: (tenantId: string) =>
    apiFetch<TenantSchema>(`/database/schemas/${tenantId}/reset`, { method: 'POST' }),
  optimizeSchema: (tenantId: string) =>
    apiFetch<{ success: boolean; improvements: string[] }>(
      `/database/schemas/${tenantId}/optimize`,
      { method: 'POST' },
    ),
  analyzeSchema: (tenantId: string) =>
    apiFetch<{ tables: Array<{ name: string; rows: number; size: string; indexes: number }> }>(
      `/database/schemas/${tenantId}/analyze`,
    ),

  // ==========================================================================
  // Migrations (migration.controller.ts)
  // Path'ler backend'e uyumlu: /database/migrations/...
  // ==========================================================================

  /** Backend: GET /database/migrations/available */
  getAvailableMigrations: () =>
    apiFetch<
      Array<{
        version: string;
        name: string;
        description: string;
        affectedTables: string[];
        estimatedDuration: number;
        isDestructive: boolean;
        requiresDowntime: boolean;
      }>
    >('/database/migrations/available'),
  /** Backend: GET /database/migrations/summary */
  getMigrationSummary: () =>
    apiFetch<{ total: number; pending: number; completed: number; failed: number }>(
      '/database/migrations/summary',
    ),
  /** Backend: GET /database/migrations/tenant/:tenantId/pending */
  getPendingMigrationsForTenant: (tenantId: string) =>
    apiFetch<SchemaMigration[]>(`/database/migrations/tenant/${tenantId}/pending`),
  /** Backend: GET /database/migrations/tenant/:tenantId/history */
  getTenantMigrationHistory: (tenantId: string) =>
    apiFetch<SchemaMigration[]>(`/database/migrations/tenant/${tenantId}/history`),
  /** Backend: POST /database/migrations/tenant/:tenantId/run */
  runTenantMigration: (
    tenantId: string,
    data: { version: string; isDryRun?: boolean; executedBy?: string },
  ) =>
    apiFetch<SchemaMigration>(`/database/migrations/tenant/${tenantId}/run`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** Backend: POST /database/migrations/tenant/:tenantId/rollback */
  rollbackTenantMigration: (tenantId: string, data: { version: string; executedBy?: string }) =>
    apiFetch<SchemaMigration>(`/database/migrations/tenant/${tenantId}/rollback`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** Backend: POST /database/migrations/batch/run */
  runBatchMigration: (data: { version: string; isDryRun?: boolean; executedBy?: string }) =>
    apiFetch<{
      totalSchemas: number;
      completed: number;
      failed: number;
      results: Array<{ tenantId: string; status: string }>;
    }>('/database/migrations/batch/run', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** Backend: GET /database/migrations/batch/:version/status */
  getBatchMigrationStatus: (version: string) =>
    apiFetch<{
      version: string;
      totalSchemas: number;
      completed: number;
      failed: number;
      status: string;
    }>(`/database/migrations/batch/${version}/status`),
  /** Backend: GET /database/migrations/history */
  getMigrationHistory: (params?: { status?: string; version?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<SchemaMigration>>(
      `/database/migrations/history?${buildQueryString(params || {})}`,
    ),

  // Legacy wrappers for older page integrations.
  getMigrations: (params?: { status?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<SchemaMigration>>(
      `/database/migrations/history?${buildQueryString(params || {})}`,
    ),
  getMigration: (id: string) => apiFetch<SchemaMigration>(`/database/migrations/${id}`),
  createMigration: (data: {
    name: string;
    description?: string;
    type: string;
    sql: string;
    rollbackSql?: string;
    createdBy: string;
  }) =>
    apiFetch<SchemaMigration>('/database/migrations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  runMigration: (id: string, schemaIds?: string[]) =>
    apiFetch<SchemaMigration>(`/database/migrations/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ schemaIds }),
    }),
  rollbackMigration: (id: string) =>
    apiFetch<SchemaMigration>(`/database/migrations/${id}/rollback`, { method: 'POST' }),
  getPendingMigrations: () => apiFetch<SchemaMigration[]>('/database/migrations/pending'),

  // ==========================================================================
  // Monitoring (monitoring.controller.ts)
  // ==========================================================================

  /** Backend: GET /database/monitoring/health */
  getDatabaseHealth: () =>
    apiFetch<{
      status: string;
      score: number;
      checks: Array<{ name: string; status: string; value: string | number; message: string }>;
      recommendations: string[];
    }>('/database/monitoring/health'),
  /** Backend: GET /database/monitoring/connections */
  getConnectionStats: () =>
    apiFetch<{
      total: number;
      active: number;
      idle: number;
      waiting: number;
      maxConnections: number;
      utilizationPercent: number;
    }>('/database/monitoring/connections'),
  /** Backend: GET /database/monitoring/connections/by-tenant */
  getConnectionStatsByTenant: () =>
    apiFetch<Array<{ tenantId: string; schemaName: string; active: number; idle: number }>>(
      '/database/monitoring/connections/by-tenant',
    ),
  /** Backend: GET /database/monitoring/slow-queries */
  getSlowQueries: (
    params?: {
      tenantId?: string;
      limit?: number;
      minTime?: number;
      grouped?: boolean;
    } & DateRangeParams,
  ) =>
    apiFetch<
      Array<{ query: string; count: number; avgTime: number; maxTime?: number; schema?: string }>
    >(`/database/monitoring/slow-queries?${buildQueryString(params || {})}`),
  /** Backend: GET /database/monitoring/query-performance */
  getQueryPerformanceStats: () =>
    apiFetch<{
      avgQueryTime: number;
      slowQueries: number;
      cacheHitRatio: number;
      deadlocks: number;
    }>('/database/monitoring/query-performance'),
  /** Backend: POST /database/monitoring/analyze-query */
  analyzeQuery: (data: { query: string; schemaName?: string }) =>
    apiFetch<{ plan: string; cost: number; rows: number }>('/database/monitoring/analyze-query', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** Backend: GET /database/monitoring/storage */
  getTotalStorage: () =>
    apiFetch<{ totalSizeBytes: number; dataSizeBytes: number; indexSizeBytes: number }>(
      '/database/monitoring/storage',
    ),
  /** Backend: GET /database/monitoring/storage/by-tenant */
  getStorageByTenant: () =>
    apiFetch<
      Array<{
        tenantId: string;
        schemaName: string;
        totalSizeBytes: number;
        dataSizeBytes: number;
        indexSizeBytes: number;
        tableCount: number;
      }>
    >('/database/monitoring/storage/by-tenant'),
  /** Backend: GET /database/monitoring/index-recommendations */
  getIndexRecommendations: (schemaName?: string) =>
    apiFetch<
      Array<{
        tableName: string;
        columns: string[];
        indexType: string;
        reason: string;
        estimatedImpact: string;
        createStatement: string;
      }>
    >(`/database/monitoring/index-recommendations${schemaName ? `?schemaName=${schemaName}` : ''}`),
  /** Backend: GET /database/monitoring/metrics */
  getMetricsHistory: (params?: { hours?: number; tenantId?: string; metricType?: string }) =>
    apiFetch<Array<{ timestamp: string; metricType: string; value: number }>>(
      `/database/monitoring/metrics?${buildQueryString(params || {})}`,
    ),

  // Backend endpoint coverage: getDatabaseStats, getTableStats, runVacuum, runAnalyze
  getDatabaseStats: () => apiFetch<DatabaseStats>('/database/monitoring/stats'),
  getTableStats: (schemaName?: string) =>
    apiFetch<
      Array<{ table: string; rows: number; size: string; deadTuples: number; lastVacuum?: string }>
    >(`/database/monitoring/tables${schemaName ? `?schema=${schemaName}` : ''}`),
  runVacuum: (schemaName?: string, tableName?: string) =>
    apiFetch<{ success: boolean }>('/database/monitoring/vacuum', {
      method: 'POST',
      body: JSON.stringify({ schemaName, tableName }),
    }),
  runAnalyze: (schemaName?: string) =>
    apiFetch<{ success: boolean }>('/database/monitoring/analyze', {
      method: 'POST',
      body: JSON.stringify({ schemaName }),
    }),

  // ==========================================================================
  // Explorer (SUPER_ADMIN debug tool)
  // ==========================================================================

  getExplorerSchemas: () => apiFetch<string[]>('/database/explorer/schemas'),
  getExplorerTables: (schema: string) =>
    apiFetch<
      Array<{
        tableName: string;
        schemaName: string;
        rowCount: number;
        sizeBytes: number;
        columns: Array<{
          columnName: string;
          dataType: string;
          isNullable: boolean;
          columnDefault: string | null;
          isPrimaryKey: boolean;
          isForeignKey: boolean;
          foreignKeyTable?: string;
          foreignKeyColumn?: string;
          isSensitive?: boolean;
        }>;
      }>
    >(`/database/explorer/schemas/${schema}/tables`),
  getExplorerTableData: (
    schema: string,
    table: string,
    params?: { page?: number; limit?: number; orderBy?: string; orderDirection?: 'ASC' | 'DESC' },
  ) =>
    apiFetch<{
      tableName: string;
      columns: Array<{
        columnName: string;
        dataType: string;
        isNullable: boolean;
        columnDefault: string | null;
        isPrimaryKey: boolean;
        isForeignKey: boolean;
        foreignKeyTable?: string;
        foreignKeyColumn?: string;
        isSensitive?: boolean;
      }>;
      rows: Record<string, unknown>[];
      totalRows: number;
      page: number;
      limit: number;
      totalPages: number;
    }>(
      `/database/explorer/schemas/${schema}/tables/${table}/data?${buildQueryString((params || {}) as Record<string, unknown>)}`,
    ),
  insertExplorerRow: (schema: string, table: string, data: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>(`/database/explorer/schemas/${schema}/tables/${table}/rows`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),
  updateExplorerRow: (schema: string, table: string, id: string, data: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>(
      `/database/explorer/schemas/${schema}/tables/${table}/rows/${id}`,
      { method: 'PUT', body: JSON.stringify({ data }) },
    ),
  deleteExplorerRow: (schema: string, table: string, id: string) =>
    apiFetch<void>(`/database/explorer/schemas/${schema}/tables/${table}/rows/${id}`, {
      method: 'DELETE',
    }),
  exportExplorerTable: (
    schema: string,
    table: string,
    format: 'csv' | 'json',
    orderBy?: string,
    orderDirection?: 'ASC' | 'DESC',
  ) => {
    const params = new URLSearchParams({ format });
    if (orderBy) {
      params.set('orderBy', orderBy);
      params.set('orderDirection', orderDirection || 'ASC');
    }
    return `${ADMIN_API_URL}/database/explorer/schemas/${schema}/tables/${table}/export?${params}`;
  },
};
