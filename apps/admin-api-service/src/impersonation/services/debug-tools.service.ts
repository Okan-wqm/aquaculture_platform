import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  DebugSession,
  CapturedQuery,
  CapturedApiCall,
  CacheEntrySnapshot,
  FeatureFlagOverride,
  DebugSessionType,
  QueryLogType,
} from '../entities/debug-session.entity';

import { DebugSessionService } from './debug-session.service';
import { QueryInspectorService } from './query-inspector.service';
import { ApiCallInspectorService } from './api-call-inspector.service';
import { CacheInspectorService } from './cache-inspector.service';
import { FeatureFlagDebugService } from './feature-flag-debug.service';

import {
  QueryInspectorResult,
  ApiLogResult,
  CacheInspectorResult,
  DebugDashboard,
  SlowQueryAnalysis,
  ApiUsageSummary,
  CacheStats,
} from './debug-tools-types';

// Re-export types for backward compatibility
export {
  QueryInspectorResult,
  ApiLogResult,
  CacheInspectorResult,
  DebugDashboard,
} from './debug-tools-types';

/**
 * Debug Tools Service - Facade
 *
 * This service acts as a facade for backward compatibility,
 * delegating to specialized services following SRP:
 * - DebugSessionService: Session lifecycle management
 * - QueryInspectorService: Query profiling & analysis
 * - ApiCallInspectorService: API logging & analysis
 * - CacheInspectorService: Cache monitoring
 * - FeatureFlagDebugService: Feature flag overrides
 */
@Injectable()
export class DebugToolsService {
  private readonly logger = new Logger(DebugToolsService.name);

  constructor(
    @InjectRepository(CapturedQuery)
    private readonly queryRepo: Repository<CapturedQuery>,
    @InjectRepository(CapturedApiCall)
    private readonly apiCallRepo: Repository<CapturedApiCall>,
    @InjectRepository(FeatureFlagOverride)
    private readonly overrideRepo: Repository<FeatureFlagOverride>,
    private readonly sessionService: DebugSessionService,
    private readonly queryInspector: QueryInspectorService,
    private readonly apiCallInspector: ApiCallInspectorService,
    private readonly cacheInspector: CacheInspectorService,
    private readonly featureFlagDebug: FeatureFlagDebugService,
  ) {}

  // ==================== Debug Session Management ====================

  async startDebugSession(data: {
    adminId: string;
    tenantId: string;
    sessionType: DebugSessionType;
    configuration?: Record<string, unknown>;
    filters?: {
      startTime?: Date;
      endTime?: Date;
      queryTypes?: QueryLogType[];
      apiEndpoints?: string[];
      cacheKeys?: string[];
      minDuration?: number;
      includeErrors?: boolean;
      userId?: string;
    };
    maxResults?: number;
    durationMinutes?: number;
  }): Promise<DebugSession> {
    return this.sessionService.startDebugSession(data);
  }

  async endDebugSession(sessionId: string): Promise<DebugSession> {
    return this.sessionService.endDebugSession(sessionId);
  }

  async getDebugSession(sessionId: string): Promise<DebugSession> {
    return this.sessionService.getDebugSession(sessionId);
  }

  async getActiveSessionsForTenant(tenantId: string): Promise<DebugSession[]> {
    return this.sessionService.getActiveSessionsForTenant(tenantId);
  }

  async querySessions(params: {
    tenantId?: string;
    sessionType?: DebugSessionType;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{ data: DebugSession[]; total: number; page: number; limit: number }> {
    return this.sessionService.querySessions(params);
  }

  // ==================== Query Inspector ====================

  async captureQuery(data: {
    tenantId: string;
    userId?: string;
    queryType: QueryLogType;
    query: string;
    parameters?: unknown[];
    durationMs: number;
    rowsAffected?: number;
    rowsReturned?: number;
    tableName?: string;
    explainPlan?: Record<string, unknown>;
    hasError?: boolean;
    errorMessage?: string;
    stackTrace?: string;
    connectionSource?: string;
  }): Promise<void> {
    return this.queryInspector.captureQuery(data);
  }

  async inspectQueries(params: {
    tenantId: string;
    debugSessionId?: string;
    queryType?: QueryLogType;
    tableName?: string;
    minDuration?: number;
    hasError?: boolean;
    start?: Date;
    end?: Date;
    page?: number;
    limit?: number;
  }): Promise<QueryInspectorResult> {
    return this.queryInspector.inspectQueries(params);
  }

  async getQueryExplainPlan(queryId: string): Promise<Record<string, unknown> | null> {
    return this.queryInspector.getQueryExplainPlan(queryId);
  }

  async getSlowQueryAnalysis(tenantId: string, threshold?: number): Promise<SlowQueryAnalysis> {
    return this.queryInspector.getSlowQueryAnalysis(tenantId, threshold);
  }

  // ==================== API Log Viewer ====================

  async captureApiCall(data: {
    tenantId: string;
    userId?: string;
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
    clientIp?: string;
    userAgent?: string;
    correlationId?: string;
    hasError?: boolean;
    errorMessage?: string;
  }): Promise<void> {
    return this.apiCallInspector.captureApiCall(data);
  }

  async inspectApiCalls(params: {
    tenantId: string;
    debugSessionId?: string;
    method?: string;
    endpoint?: string;
    statusCode?: number;
    hasError?: boolean;
    minDuration?: number;
    start?: Date;
    end?: Date;
    page?: number;
    limit?: number;
  }): Promise<ApiLogResult> {
    return this.apiCallInspector.inspectApiCalls(params);
  }

  async getApiCallDetails(id: string): Promise<CapturedApiCall> {
    return this.apiCallInspector.getApiCallDetails(id);
  }

  async getApiUsageSummary(tenantId: string, period?: string): Promise<ApiUsageSummary> {
    return this.apiCallInspector.getApiUsageSummary(tenantId, period);
  }

  // ==================== Cache Inspector ====================

  async snapshotCache(
    tenantId: string,
    debugSessionId?: string,
    cacheStore?: string,
  ): Promise<CacheInspectorResult> {
    return this.cacheInspector.snapshotCache(tenantId, debugSessionId, cacheStore);
  }

  async captureCacheEntry(data: {
    tenantId?: string;
    debugSessionId?: string;
    key: string;
    value?: unknown;
    sizeBytes?: number;
    ttlSeconds?: number;
    expiresAt?: Date;
    hitCount?: number;
    lastAccessedAt?: Date;
    cacheStore?: string;
    tags?: string[];
  }): Promise<CacheEntrySnapshot> {
    return this.cacheInspector.captureCacheEntry(data);
  }

  async getCacheEntry(key: string): Promise<CacheEntrySnapshot | null> {
    return this.cacheInspector.getCacheEntry(key);
  }

  async invalidateCacheByKey(key: string): Promise<void> {
    return this.cacheInspector.invalidateCacheByKey(key);
  }

  async invalidateCacheKey(tenantId: string, key: string): Promise<void> {
    return this.cacheInspector.invalidateCacheKey(tenantId, key);
  }

  async invalidateCachePattern(tenantId: string, pattern: string): Promise<number> {
    return this.cacheInspector.invalidateCachePattern(tenantId, pattern);
  }

  async getCacheStats(tenantId?: string): Promise<CacheStats> {
    return this.cacheInspector.getCacheStats(tenantId);
  }

  // ==================== Feature Flag Override ====================

  async createFeatureFlagOverride(data: {
    tenantId: string;
    featureKey: string;
    originalValue: unknown;
    overrideValue: unknown;
    adminId: string;
    reason?: string;
    expiresAt?: Date;
  }): Promise<FeatureFlagOverride> {
    return this.featureFlagDebug.createFeatureFlagOverride(data);
  }

  async revertFeatureFlagOverride(overrideId: string, revertedBy: string): Promise<FeatureFlagOverride> {
    return this.featureFlagDebug.revertFeatureFlagOverride(overrideId, revertedBy);
  }

  async getActiveOverridesForTenant(tenantId: string): Promise<FeatureFlagOverride[]> {
    return this.featureFlagDebug.getActiveOverridesForTenant(tenantId);
  }

  async getFeatureOverride(id: string): Promise<FeatureFlagOverride> {
    return this.featureFlagDebug.getFeatureOverride(id);
  }

  async getFeatureFlagValue(tenantId: string, featureKey: string, defaultValue: unknown): Promise<unknown> {
    return this.featureFlagDebug.getFeatureFlagValue(tenantId, featureKey, defaultValue);
  }

  async queryOverrides(params: {
    tenantId?: string;
    adminId?: string;
    featureKey?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{ items: FeatureFlagOverride[]; total: number }> {
    return this.featureFlagDebug.queryOverrides(params);
  }

  // ==================== Dashboard ====================

  async getDebugDashboard(tenantId?: string): Promise<DebugDashboard> {
    const [activeSessions, recentQueries, recentApiCalls, activeOverrides] = await Promise.all([
      this.sessionService.getAllActiveSessions(10),
      this.queryInspector.getRecentQueries(tenantId, 10),
      this.apiCallInspector.getRecentApiCalls(tenantId, 10),
      this.featureFlagDebug.getAllActiveOverrides(tenantId, 10),
    ]);

    // Tenant stats
    const tenantStatsRaw = await this.queryRepo
      .createQueryBuilder('q')
      .select('q.tenantId', 'tenantId')
      .addSelect('COUNT(*)', 'queryCount')
      .groupBy('q.tenantId')
      .orderBy('queryCount', 'DESC')
      .limit(10)
      .getRawMany();

    const tenantStats = tenantStatsRaw.map((t) => ({
      tenantId: t.tenantId,
      queryCount: parseInt(t.queryCount, 10),
      apiCallCount: 0,
      errorRate: 0,
    }));

    return {
      activeSessions,
      recentQueries,
      recentApiCalls,
      activeOverrides,
      tenantStats,
    };
  }
}
