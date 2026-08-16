/**
 * Debug Tools API
 */

import { apiFetch } from '../http-client';
import type { PaginationParams, DebugSessionType } from '../types';
import {
  ADMIN_API_ROUTES,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';

type DebugSessionsQuery = AdminApiRouteQuery<'GET /debug/sessions'>;
type CapturedQueriesQuery = AdminApiRouteQuery<'GET /debug/queries'>;
type CapturedApiCallsQuery = AdminApiRouteQuery<'GET /debug/api-calls'>;
type CacheEntriesQuery = AdminApiRouteQuery<'GET /debug/cache'>;

export const debugApi = {
  // Debug Sessions
  getSessions: (params: DebugSessionsQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/sessions'], { query: params }),
  getSession: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/sessions/:id'], { path: { id: id } }),
  startSession: (data: {
    tenantId: string;
    adminId: string;
    sessionType: DebugSessionType;
    configuration?: Record<string, unknown>;
    filters?: Record<string, unknown>;
    maxResults?: number;
    expiresAt?: string;
  }) => apiFetch(ADMIN_API_ROUTES['POST /debug/sessions'], { body: data }),
  endSession: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /debug/sessions/:id/end'], { path: { id: id } }),

  // Query Inspector
  getCapturedQueries: (params: CapturedQueriesQuery) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/queries'], { query: params }),
  getQueryExplain: (queryId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/queries/:id/explain'], { path: { id: queryId } }),
  getSlowQueryAnalysis: (tenantId: string, threshold?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/queries/slow-analysis'], {
      query: { tenantId: tenantId, threshold: threshold },
    }),

  // API Log Viewer
  getCapturedApiCalls: (params: CapturedApiCallsQuery) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/api-calls'], { query: params }),
  getApiCallDetails: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/api-calls/:id'], { path: { id: id } }),
  getApiUsageSummary: (tenantId: string, period?: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/api-calls/summary'], {
      query: { tenantId: tenantId, period: period },
    }),

  // Cache Inspector
  listCacheEntries: (params: CacheEntriesQuery) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/cache'], { query: params }),
  getCacheEntry: (key: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/cache/:key'], { path: { key: key } }),
  invalidateCacheEntry: (key: string) =>
    apiFetch(ADMIN_API_ROUTES['DELETE /debug/cache/:key'], { path: { key: key } }),
  invalidateCacheByPattern: (pattern: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /debug/cache/invalidate'], { body: { pattern } }),
  getCacheStats: () => apiFetch(ADMIN_API_ROUTES['GET /debug/cache/stats']),

  // Feature Flag Overrides
  getFeatureOverrides: (params?: { tenantId?: string; isActive?: boolean } & PaginationParams) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/feature-overrides'], { query: params || {} }),
  getFeatureOverride: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/feature-overrides/:id'], { path: { id: id } }),
  createFeatureOverride: (data: {
    tenantId: string;
    featureKey: string;
    originalValue: unknown;
    overrideValue: unknown;
    reason?: string;
    expiresAt?: string;
  }) => apiFetch(ADMIN_API_ROUTES['POST /debug/feature-overrides'], { body: data }),
  revertFeatureOverride: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /debug/feature-overrides/:id/revert'], { path: { id: id } }),
  getActiveOverridesForTenant: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /debug/feature-overrides/tenant/:tenantId/active'], {
      path: { tenantId: tenantId },
    }),
};
