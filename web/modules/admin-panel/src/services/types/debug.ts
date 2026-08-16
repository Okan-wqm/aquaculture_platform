/**
 * Debug tools domain types
 */

import type { AdminApiRouteResponse } from './generated/admin-route-contracts';

export type DebugSessionType =
  | 'query_inspection'
  | 'api_log_viewing'
  | 'cache_inspection'
  | 'feature_flag_override'
  | 'performance_profiling';

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

export type CacheEntry = AdminApiRouteResponse<'GET /debug/cache'>['entries'][number];
export type CacheNamespaceListing = AdminApiRouteResponse<'GET /debug/cache'>;
export type CacheKeyValue = AdminApiRouteResponse<'GET /debug/cache/:key'>;
export type CacheInvalidationReceipt = AdminApiRouteResponse<'DELETE /debug/cache/:key'>;
export type CacheStats = AdminApiRouteResponse<'GET /debug/cache/stats'>;

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
