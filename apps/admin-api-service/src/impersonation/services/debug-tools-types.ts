import {
  CapturedQuery,
  CapturedApiCall,
  FeatureFlagOverride,
  DebugSession,
  QueryLogType,
} from '../entities/debug-session.entity';
import type {
  DebugToolsCacheInvalidationReceiptDto,
  DebugToolsCacheKeyValueDto,
  DebugToolsCacheNamespaceListingDto,
  DebugToolsCacheStatsDto,
} from '../contracts/admin-http-response.contract';

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

/** Cache service/domain projections derive from the public response authority. */
export type CacheKeyEntry = DebugToolsCacheNamespaceListingDto['entries'][number];
export type CacheNamespaceListing = DebugToolsCacheNamespaceListingDto;
export type CacheKeyValue = DebugToolsCacheKeyValueDto;
export type CacheInvalidationReceiptV1 = DebugToolsCacheInvalidationReceiptDto;

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

export type CacheStats = DebugToolsCacheStatsDto;
