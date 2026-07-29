import {
  CapturedQuery,
  CapturedApiCall,
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
 * One key as Redis describes it.
 *
 * `sizeBytes` and `idleSeconds` are nullable because `MEMORY USAGE` and
 * `OBJECT IDLETIME` are not answerable on every build or eviction policy, and a
 * key whose footprint could not be measured has an unknown size — not zero.
 */
export interface CacheKeyEntry {
  key: string;
  /** Redis type: string, hash, list, set, zset, stream — or none. */
  type: string;
  /** Seconds until expiry; -1 when the key never expires, -2 when it is gone. */
  ttlSeconds: number;
  sizeBytes: number | null;
  idleSeconds: number | null;
}

/** A key listing, scoped to the namespace it was read from. */
export interface CacheNamespaceListing {
  /** The service key prefix these keys live under, e.g. `admin:`. */
  namespace: string;
  entries: CacheKeyEntry[];
  /** How many keys matched before `limit` was applied. */
  matchedCount: number;
  truncated: boolean;
}

/** One key's stored value. `value` is populated only for string keys. */
export interface CacheKeyValue {
  key: string;
  type: string;
  ttlSeconds: number;
  sizeBytes: number | null;
  value: string | null;
}

/** Instance-wide counters Redis itself keeps. Not attributable to a namespace. */
export interface RedisInstanceStats {
  keyspaceHits: number;
  keyspaceMisses: number;
  /** Null when the instance has served no lookup yet — unmeasured, not 0%. */
  hitRatePercent: number | null;
  usedMemoryBytes: number;
  totalKeys: number;
}

/**
 * Cache statistics, with the namespace figure and the instance figures kept
 * apart.
 *
 * They answer different questions and cannot be added: `keysInNamespace` counts
 * this service's keys, `instance` describes the whole Redis. The version this
 * replaced merged a hit count with a row count into one "Hit Rate %".
 */
export interface CacheStats {
  namespace: string;
  keysInNamespace: number;
  instance: RedisInstanceStats;
}
