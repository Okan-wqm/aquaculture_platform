/**
 * Debug tools domain types
 */

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

export interface QueryInspectorResult {
  readonly queries: readonly CapturedQuery[];
  readonly summary: {
    readonly totalQueries: number;
    readonly totalDuration: number;
    readonly avgDuration: number;
    readonly slowQueries: number;
    readonly errorCount: number;
    readonly queryTypeBreakdown: Readonly<Record<string, number>>;
  };
}

export interface ApiLogResult {
  readonly calls: readonly CapturedApiCall[];
  readonly summary: {
    readonly totalCalls: number;
    readonly totalDuration: number;
    readonly avgDuration: number;
    readonly errorCount: number;
    readonly statusBreakdown: Readonly<Record<string, number>>;
    readonly endpointBreakdown: readonly {
      readonly endpoint: string;
      readonly count: number;
      readonly avgDuration: number;
    }[];
  };
}

export interface CacheInspectorResult {
  readonly entries: readonly CacheEntry[];
  readonly summary: {
    readonly totalKeys: number;
    readonly totalSizeBytes: number;
    readonly avgTtlSeconds: number;
    readonly expiringInHour: number;
    readonly storeBreakdown: Readonly<Record<string, number>>;
  };
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
