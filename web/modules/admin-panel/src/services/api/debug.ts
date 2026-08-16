/**
 * Debug Tools API
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  DateRangeParams,
  DebugSession,
  DebugSessionType,
  CapturedQuery,
  CapturedApiCall,
  CacheEntry,
  ApiLogResult,
  CacheInspectorResult,
  FeatureFlagOverride,
  QueryInspectorResult,
} from '../types';

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
    apiFetch<QueryInspectorResult>(`/debug/queries?${buildQueryString(params || {})}`),
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
    apiFetch<ApiLogResult>(`/debug/api-calls?${buildQueryString(params || {})}`),
  getApiCallDetails: (id: string) => apiFetch<CapturedApiCall>(`/debug/api-calls/${id}`),
  getApiUsageSummary: (tenantId: string, period?: string) =>
    apiFetch<{
      totalCalls: number;
      byEndpoint: Array<{ endpoint: string; count: number; avgDuration: number }>;
      byStatus: Array<{ status: number; count: number }>;
      errorRate: number;
    }>(`/debug/api-calls/summary?tenantId=${tenantId}${period ? `&period=${period}` : ''}`),

  // Cache Inspector
  getCacheEntries: (params?: {
    tenantId?: string;
    debugSessionId?: string;
    cacheStore?: string;
  }) => apiFetch<CacheInspectorResult>(`/debug/cache?${buildQueryString(params || {})}`),
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
