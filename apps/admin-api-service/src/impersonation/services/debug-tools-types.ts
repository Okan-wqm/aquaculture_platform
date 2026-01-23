import {
  CapturedQuery,
  CapturedApiCall,
  CacheEntrySnapshot,
  FeatureFlagOverride,
  DebugSession,
  QueryLogType,
} from '../entities/debug-session.entity';

/**
 * Query Inspector Result Interface
 */
export interface QueryInspectorResult {
  queries: CapturedQuery[];
  summary: {
    totalQueries: number;
    totalDuration: number;
    avgDuration: number;
    slowQueries: number;
    errorCount: number;
    queryTypeBreakdown: Record<QueryLogType, number>;
  };
}

/**
 * API Log Result Interface
 */
export interface ApiLogResult {
  calls: CapturedApiCall[];
  summary: {
    totalCalls: number;
    totalDuration: number;
    avgDuration: number;
    errorCount: number;
    statusBreakdown: Record<string, number>;
    endpointBreakdown: Array<{ endpoint: string; count: number; avgDuration: number }>;
  };
}

/**
 * Cache Inspector Result Interface
 */
export interface CacheInspectorResult {
  entries: CacheEntrySnapshot[];
  summary: {
    totalKeys: number;
    totalSizeBytes: number;
    avgTtlSeconds: number;
    expiringInHour: number;
    storeBreakdown: Record<string, number>;
  };
}

/**
 * Debug Dashboard Interface
 */
export interface DebugDashboard {
  activeSessions: DebugSession[];
  recentQueries: CapturedQuery[];
  recentApiCalls: CapturedApiCall[];
  activeOverrides: FeatureFlagOverride[];
  tenantStats: {
    tenantId: string;
    queryCount: number;
    apiCallCount: number;
    errorRate: number;
  }[];
}

/**
 * Slow Query Analysis Result
 */
export interface SlowQueryAnalysis {
  slowQueries: CapturedQuery[];
  patterns: Array<{ pattern: string; count: number; avgDuration: number }>;
  recommendations: string[];
}

/**
 * API Usage Summary Interface
 */
export interface ApiUsageSummary {
  totalCalls: number;
  avgResponseTime: number;
  errorRate: number;
  topEndpoints: Array<{ endpoint: string; count: number; avgDuration: number }>;
  statusDistribution: Record<string, number>;
}

/**
 * Cache Stats Interface
 */
export interface CacheStats {
  totalEntries: number;
  totalSize: number;
  hitRate: number;
  missRate: number;
  byStore: Array<{ store: string; entries: number; size: number }>;
}
