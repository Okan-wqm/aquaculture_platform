/**
 * Database Management API
 *
 * Backend controller'lara uyumlu API fonksiyonlari.
 * Path'ler admin-api-service controller'larindan dogrulanmistir:
 *   - schema.controller.ts: /database/schemas
 *   - migration.controller.ts: /database/migrations
 *   - monitoring.controller.ts: /database/monitoring
 */

import { apiFetch, apiFetchBlob } from '../http-client';
import type {
  PaginationParams,
  DateRangeParams,
  TenantSchema,
  SchemaMigration,
  SlowQuery,
} from '../types';
import {
  ADMIN_API_ROUTES,
  ADMIN_BINARY_ROUTES,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';

type MigrationHistoryQuery = AdminApiRouteQuery<'GET /database/migrations/history'>;
export const databaseApi = {
  // ==========================================================================
  // Schema Management (schema.controller.ts)
  // ==========================================================================

  getSchemas: (params?: { status?: string; search?: string } & PaginationParams) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/schemas'], { query: params || {} }),
  getSchema: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/schemas/:tenantId'], { path: { tenantId: tenantId } }),
  getSchemaSummary: () => apiFetch(ADMIN_API_ROUTES['GET /database/schemas/summary']),
  getSchemaInfo: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/schemas/:tenantId/info'], {
      path: { tenantId: tenantId },
    }),
  createSchema: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /database/schemas'], { body: { tenantId } }),
  deleteSchema: (tenantId: string, options?: { hardDelete?: boolean }) =>
    apiFetch(ADMIN_API_ROUTES['DELETE /database/schemas/:tenantId'], {
      path: { tenantId: tenantId },
      query: options || {},
    }),
  suspendSchema: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /database/schemas/:tenantId/suspend'], {
      path: { tenantId: tenantId },
    }),
  activateSchema: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /database/schemas/:tenantId/activate'], {
      path: { tenantId: tenantId },
    }),
  syncSchemas: (data?: { tenantId?: string; modules?: string[] }) =>
    apiFetch(ADMIN_API_ROUTES['POST /database/schemas/sync'], { body: data || {} }),
  validateSchemaIsolation: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/schemas/:tenantId/validate'], {
      path: { tenantId: tenantId },
    }),
  refreshSchemaStats: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /database/schemas/:tenantId/refresh-stats'], {
      path: { tenantId: tenantId },
    }),
  getConnectionPoolStatus: () =>
    apiFetch(ADMIN_API_ROUTES['GET /database/schemas/connections/pool']),
  getConnectionsByTenant: () =>
    apiFetch(ADMIN_API_ROUTES['GET /database/schemas/connections/by-tenant']),

  // ==========================================================================
  // Migrations (migration.controller.ts)
  // Path'ler backend'e uyumlu: /database/migrations/...
  // ==========================================================================

  /** Backend: GET /database/migrations/available */
  getAvailableMigrations: () => apiFetch(ADMIN_API_ROUTES['GET /database/migrations/available']),
  /** Backend: GET /database/migrations/summary */
  getMigrationSummary: () => apiFetch(ADMIN_API_ROUTES['GET /database/migrations/summary']),
  /** Backend: GET /database/migrations/tenant/:tenantId/pending */
  getPendingMigrationsForTenant: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/migrations/tenant/:tenantId/pending'], {
      path: { tenantId: tenantId },
    }),
  /** Backend: GET /database/migrations/tenant/:tenantId/history */
  getTenantMigrationHistory: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/migrations/tenant/:tenantId/history'], {
      path: { tenantId: tenantId },
    }),
  /** Backend: POST /database/migrations/tenant/:tenantId/run */
  runTenantMigration: (
    tenantId: string,
    data: { version: string; isDryRun?: boolean; executedBy?: string },
  ) =>
    apiFetch(ADMIN_API_ROUTES['POST /database/migrations/tenant/:tenantId/run'], {
      path: { tenantId: tenantId },
      body: data,
    }),
  /** Backend: POST /database/migrations/tenant/:tenantId/rollback */
  rollbackTenantMigration: (tenantId: string, data: { version: string; executedBy?: string }) =>
    apiFetch(ADMIN_API_ROUTES['POST /database/migrations/tenant/:tenantId/rollback'], {
      path: { tenantId: tenantId },
      body: data,
    }),
  /** Backend: POST /database/migrations/batch/run */
  runBatchMigration: (data: { version: string; isDryRun?: boolean; executedBy?: string }) =>
    apiFetch(ADMIN_API_ROUTES['POST /database/migrations/batch/run'], { body: data }),
  /** Backend: GET /database/migrations/batch/:version/status */
  getBatchMigrationStatus: (version: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/migrations/batch/:version/status'], {
      path: { version: version },
    }),
  /** Backend: GET /database/migrations/history */
  getMigrationHistory: (params: MigrationHistoryQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/migrations/history'], { query: params }),

  // ==========================================================================
  // Monitoring (monitoring.controller.ts)
  // ==========================================================================

  /** Backend: GET /database/monitoring/health */
  getDatabaseHealth: () => apiFetch(ADMIN_API_ROUTES['GET /database/monitoring/health']),
  /** Backend: GET /database/monitoring/connections */
  getConnectionStats: () => apiFetch(ADMIN_API_ROUTES['GET /database/monitoring/connections']),
  /** Backend: GET /database/monitoring/connections/by-tenant */
  getConnectionStatsByTenant: () =>
    apiFetch(ADMIN_API_ROUTES['GET /database/monitoring/connections/by-tenant']),
  /** Backend: GET /database/monitoring/slow-queries */
  getSlowQueries: (
    params?: {
      tenantId?: string;
      limit?: number;
      minTime?: number;
      grouped?: boolean;
    } & DateRangeParams,
  ) => apiFetch(ADMIN_API_ROUTES['GET /database/monitoring/slow-queries'], { query: params || {} }),
  /** Backend: GET /database/monitoring/query-performance */
  getQueryPerformanceStats: () =>
    apiFetch(ADMIN_API_ROUTES['GET /database/monitoring/query-performance']),
  /** Backend: POST /database/monitoring/analyze-query */
  analyzeQuery: (data: { query: string; schemaName?: string }) =>
    apiFetch(ADMIN_API_ROUTES['POST /database/monitoring/analyze-query'], { body: data }),
  /** Backend: GET /database/monitoring/storage */
  getTotalStorage: () => apiFetch(ADMIN_API_ROUTES['GET /database/monitoring/storage']),
  /** Backend: GET /database/monitoring/storage/by-tenant */
  getStorageByTenant: () =>
    apiFetch(ADMIN_API_ROUTES['GET /database/monitoring/storage/by-tenant']),
  /** Backend: GET /database/monitoring/index-recommendations */
  getIndexRecommendations: (schemaName?: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/monitoring/index-recommendations'], {
      query: { schemaName: schemaName },
    }),
  /** Backend: GET /database/monitoring/metrics */
  getMetricsHistory: (params?: { hours?: number; tenantId?: string; metricType?: string }) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/monitoring/metrics'], { query: params || {} }),

  // ==========================================================================
  // Explorer (SUPER_ADMIN debug tool)
  // ==========================================================================

  getExplorerSchemas: () => apiFetch(ADMIN_API_ROUTES['GET /database/explorer/schemas']),
  getExplorerTables: (schema: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/explorer/schemas/:schema/tables'], {
      path: { schema: schema },
    }),
  getExplorerTableData: (
    schema: string,
    table: string,
    params?: { page?: number; limit?: number; orderBy?: string; orderDirection?: 'ASC' | 'DESC' },
  ) =>
    apiFetch(ADMIN_API_ROUTES['GET /database/explorer/schemas/:schema/tables/:table/data'], {
      path: { schema: schema, table: table },
      query: (params || {}) as Record<string, unknown>,
    }),
  insertExplorerRow: (schema: string, table: string, data: Record<string, unknown>) =>
    apiFetch(ADMIN_API_ROUTES['POST /database/explorer/schemas/:schema/tables/:table/rows'], {
      path: { schema: schema, table: table },
      body: { data },
    }),
  updateExplorerRow: (schema: string, table: string, id: string, data: Record<string, unknown>) =>
    apiFetch(ADMIN_API_ROUTES['PUT /database/explorer/schemas/:schema/tables/:table/rows/:id'], {
      path: { schema: schema, table: table, id: id },
      body: { data },
    }),
  deleteExplorerRow: (schema: string, table: string, id: string) =>
    apiFetch(ADMIN_API_ROUTES['DELETE /database/explorer/schemas/:schema/tables/:table/rows/:id'], {
      path: { schema: schema, table: table, id: id },
    }),
  exportExplorerTable: (
    schema: string,
    table: string,
    format: 'csv' | 'json',
    orderBy?: string,
    orderDirection?: 'ASC' | 'DESC',
  ) => {
    return apiFetchBlob(
      ADMIN_BINARY_ROUTES['GET /database/explorer/schemas/:schema/tables/:table/export'],
      {
        path: { schema: schema, table: table },
        query: { format: format, orderBy: orderBy, orderDirection: orderDirection },
      },
    );
  },

  executeExplorerQuery: (sql: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /database/explorer/query'], { body: { sql } }),
};
