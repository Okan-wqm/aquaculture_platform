import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Between } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  DebugSession,
  CapturedQuery,
  CapturedApiCall,
  CacheEntrySnapshot,
  FeatureFlagOverride,
  DebugSessionType,
  QueryLogType,
} from '../entities/debug-session.entity';

// ============================================================================
// Interfaces
// ============================================================================

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

// ============================================================================
// Debug Tools Service
// ============================================================================

@Injectable()
export class DebugToolsService {
  private readonly logger = new Logger(DebugToolsService.name);
  private queryBuffer: CapturedQuery[] = [];
  private apiCallBuffer: CapturedApiCall[] = [];
  private readonly BUFFER_SIZE = 100;

  constructor(
    @InjectRepository(DebugSession)
    private readonly debugSessionRepo: Repository<DebugSession>,
    @InjectRepository(CapturedQuery)
    private readonly queryRepo: Repository<CapturedQuery>,
    @InjectRepository(CapturedApiCall)
    private readonly apiCallRepo: Repository<CapturedApiCall>,
    @InjectRepository(CacheEntrySnapshot)
    private readonly cacheSnapshotRepo: Repository<CacheEntrySnapshot>,
    @InjectRepository(FeatureFlagOverride)
    private readonly overrideRepo: Repository<FeatureFlagOverride>,
  ) {}

  // ============================================================================
  // Debug Session Management
  // ============================================================================

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
    const expiresAt = new Date(Date.now() + (data.durationMinutes || 30) * 60000);

    const session = this.debugSessionRepo.create({
      adminId: data.adminId,
      tenantId: data.tenantId,
      sessionType: data.sessionType,
      isActive: true,
      configuration: data.configuration,
      filters: data.filters,
      maxResults: data.maxResults || 1000,
      expiresAt,
    });

    const saved = await this.debugSessionRepo.save(session);
    this.logger.log(`Started debug session: ${saved.sessionType} for tenant ${data.tenantId}`);
    return saved;
  }

  async endDebugSession(sessionId: string): Promise<DebugSession> {
    const session = await this.debugSessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException(`Debug session not found: ${sessionId}`);
    }

    session.isActive = false;
    return this.debugSessionRepo.save(session);
  }

  async getDebugSession(sessionId: string): Promise<DebugSession> {
    const session = await this.debugSessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException(`Debug session not found: ${sessionId}`);
    }
    return session;
  }

  async getActiveSessionsForTenant(tenantId: string): Promise<DebugSession[]> {
    return this.debugSessionRepo.find({
      where: { tenantId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  async querySessions(params: {
    tenantId?: string;
    sessionType?: DebugSessionType;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{ data: DebugSession[]; total: number; page: number; limit: number }> {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const query = this.debugSessionRepo.createQueryBuilder('s');

    if (params.tenantId) {
      query.andWhere('s.tenantId = :tenantId', { tenantId: params.tenantId });
    }
    if (params.sessionType) {
      query.andWhere('s.sessionType = :sessionType', { sessionType: params.sessionType });
    }
    if (params.isActive !== undefined) {
      query.andWhere('s.isActive = :isActive', { isActive: params.isActive });
    }

    query.orderBy('s.createdAt', 'DESC');
    query.skip(skip).take(limit);

    const [data, total] = await query.getManyAndCount();

    return { data, total, page, limit };
  }

  // ============================================================================
  // Query Inspector
  // ============================================================================

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
    // Find active debug sessions for this tenant
    const sessions = await this.debugSessionRepo.find({
      where: {
        tenantId: data.tenantId,
        sessionType: DebugSessionType.QUERY_INSPECTION,
        isActive: true,
      },
    });

    const captured = this.queryRepo.create({
      tenantId: data.tenantId,
      userId: data.userId,
      queryType: data.queryType,
      query: data.query,
      parameters: data.parameters,
      normalizedQuery: this.normalizeQuery(data.query),
      durationMs: data.durationMs,
      rowsAffected: data.rowsAffected,
      rowsReturned: data.rowsReturned,
      tableName: data.tableName,
      explainPlan: data.explainPlan,
      isSlowQuery: data.durationMs > 100,
      hasError: data.hasError || false,
      errorMessage: data.errorMessage,
      stackTrace: data.stackTrace,
      connectionSource: data.connectionSource,
      timestamp: new Date(),
    });

    // Link to active sessions
    for (const session of sessions) {
      if (this.matchesFilters(captured, session.filters)) {
        captured.debugSessionId = session.id;
      }
    }

    this.queryBuffer.push(captured);

    if (this.queryBuffer.length >= this.BUFFER_SIZE) {
      await this.flushQueryBuffer();
    }
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
    await this.flushQueryBuffer();

    const query = this.queryRepo.createQueryBuilder('q');

    query.where('q.tenantId = :tenantId', { tenantId: params.tenantId });

    if (params.debugSessionId) {
      query.andWhere('q.debugSessionId = :debugSessionId', { debugSessionId: params.debugSessionId });
    }
    if (params.queryType) {
      query.andWhere('q.queryType = :queryType', { queryType: params.queryType });
    }
    if (params.tableName) {
      query.andWhere('q.tableName = :tableName', { tableName: params.tableName });
    }
    if (params.minDuration) {
      query.andWhere('q.durationMs >= :minDuration', { minDuration: params.minDuration });
    }
    if (params.hasError !== undefined) {
      query.andWhere('q.hasError = :hasError', { hasError: params.hasError });
    }
    if (params.start) {
      query.andWhere('q.timestamp >= :start', { start: params.start });
    }
    if (params.end) {
      query.andWhere('q.timestamp <= :end', { end: params.end });
    }

    query.orderBy('q.timestamp', 'DESC');

    const page = params.page || 1;
    const limit = params.limit || 100;
    query.skip((page - 1) * limit).take(limit);

    const queries = await query.getMany();

    // Calculate summary
    const summaryQuery = this.queryRepo
      .createQueryBuilder('q')
      .select('COUNT(*)', 'totalQueries')
      .addSelect('SUM(q.durationMs)', 'totalDuration')
      .addSelect('AVG(q.durationMs)', 'avgDuration')
      .addSelect('SUM(CASE WHEN q.isSlowQuery THEN 1 ELSE 0 END)', 'slowQueries')
      .addSelect('SUM(CASE WHEN q.hasError THEN 1 ELSE 0 END)', 'errorCount')
      .where('q.tenantId = :tenantId', { tenantId: params.tenantId });

    if (params.start) {
      summaryQuery.andWhere('q.timestamp >= :start', { start: params.start });
    }
    if (params.end) {
      summaryQuery.andWhere('q.timestamp <= :end', { end: params.end });
    }

    const summaryRaw = await summaryQuery.getRawOne();

    const typeBreakdownRaw = await this.queryRepo
      .createQueryBuilder('q')
      .select('q.queryType', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('q.tenantId = :tenantId', { tenantId: params.tenantId })
      .groupBy('q.queryType')
      .getRawMany();

    const queryTypeBreakdown: Record<QueryLogType, number> = {
      [QueryLogType.SELECT]: 0,
      [QueryLogType.INSERT]: 0,
      [QueryLogType.UPDATE]: 0,
      [QueryLogType.DELETE]: 0,
      [QueryLogType.TRANSACTION]: 0,
      [QueryLogType.SCHEMA]: 0,
    };

    for (const item of typeBreakdownRaw) {
      queryTypeBreakdown[item.type as QueryLogType] = parseInt(item.count, 10);
    }

    return {
      queries,
      summary: {
        totalQueries: parseInt(summaryRaw?.totalQueries, 10) || 0,
        totalDuration: parseFloat(summaryRaw?.totalDuration) || 0,
        avgDuration: parseFloat(summaryRaw?.avgDuration) || 0,
        slowQueries: parseInt(summaryRaw?.slowQueries, 10) || 0,
        errorCount: parseInt(summaryRaw?.errorCount, 10) || 0,
        queryTypeBreakdown,
      },
    };
  }

  async getQueryExplainPlan(queryId: string): Promise<Record<string, unknown> | null> {
    const query = await this.queryRepo.findOne({ where: { id: queryId } });
    return query?.explainPlan || null;
  }

  async getSlowQueryAnalysis(
    tenantId: string,
    threshold?: number,
  ): Promise<{
    slowQueries: CapturedQuery[];
    patterns: Array<{ pattern: string; count: number; avgDuration: number }>;
    recommendations: string[];
  }> {
    const thresholdMs = threshold || 100;

    // Get slow queries
    const slowQueries = await this.queryRepo.find({
      where: {
        tenantId,
        isSlowQuery: true,
      },
      order: { durationMs: 'DESC' },
      take: 50,
    });

    // Analyze patterns
    const patternStats: Record<string, { count: number; totalDuration: number }> = {};
    for (const query of slowQueries) {
      const pattern = query.normalizedQuery || 'unknown';
      if (!patternStats[pattern]) {
        patternStats[pattern] = { count: 0, totalDuration: 0 };
      }
      patternStats[pattern].count++;
      patternStats[pattern].totalDuration += query.durationMs;
    }

    const patterns = Object.entries(patternStats)
      .map(([pattern, stats]) => ({
        pattern: pattern.substring(0, 100),
        count: stats.count,
        avgDuration: Math.round(stats.totalDuration / stats.count),
      }))
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, 10);

    // Generate recommendations
    const recommendations: string[] = [];
    if (slowQueries.length > 20) {
      recommendations.push('High number of slow queries detected. Consider reviewing database indexes.');
    }
    const selectQueries = slowQueries.filter(q => q.queryType === QueryLogType.SELECT);
    if (selectQueries.length > 10) {
      recommendations.push('Many slow SELECT queries. Consider adding appropriate indexes or optimizing queries.');
    }
    if (patterns.some(p => p.avgDuration > 500)) {
      recommendations.push('Some query patterns have very high average duration. Review execution plans.');
    }

    return { slowQueries, patterns, recommendations };
  }

  private normalizeQuery(query: string): string {
    return query
      .replace(/\s+/g, ' ')
      .replace(/\$\d+/g, '?')
      .replace(/'[^']*'/g, "'?'")
      .trim()
      .substring(0, 500);
  }

  // ============================================================================
  // API Log Viewer
  // ============================================================================

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
    // Find active debug sessions for this tenant
    const sessions = await this.debugSessionRepo.find({
      where: {
        tenantId: data.tenantId,
        sessionType: DebugSessionType.API_LOG_VIEWING,
        isActive: true,
      },
    });

    const captured = this.apiCallRepo.create({
      tenantId: data.tenantId,
      userId: data.userId,
      method: data.method,
      endpoint: data.endpoint,
      fullUrl: data.fullUrl,
      requestHeaders: this.sanitizeHeaders(data.requestHeaders),
      requestBody: this.sanitizeBody(data.requestBody),
      queryParams: data.queryParams,
      responseStatus: data.responseStatus,
      responseHeaders: data.responseHeaders,
      responseBody: this.truncateResponse(data.responseBody),
      durationMs: data.durationMs,
      clientIp: data.clientIp,
      userAgent: data.userAgent,
      correlationId: data.correlationId,
      hasError: data.hasError || data.responseStatus >= 400,
      errorMessage: data.errorMessage,
      timestamp: new Date(),
    });

    // Link to active sessions
    for (const session of sessions) {
      if (this.matchesApiFilters(captured, session.filters)) {
        captured.debugSessionId = session.id;
      }
    }

    this.apiCallBuffer.push(captured);

    if (this.apiCallBuffer.length >= this.BUFFER_SIZE) {
      await this.flushApiCallBuffer();
    }
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
    await this.flushApiCallBuffer();

    const query = this.apiCallRepo.createQueryBuilder('a');

    query.where('a.tenantId = :tenantId', { tenantId: params.tenantId });

    if (params.debugSessionId) {
      query.andWhere('a.debugSessionId = :debugSessionId', { debugSessionId: params.debugSessionId });
    }
    if (params.method) {
      query.andWhere('a.method = :method', { method: params.method });
    }
    if (params.endpoint) {
      query.andWhere('a.endpoint LIKE :endpoint', { endpoint: `%${params.endpoint}%` });
    }
    if (params.statusCode) {
      query.andWhere('a.responseStatus = :statusCode', { statusCode: params.statusCode });
    }
    if (params.hasError !== undefined) {
      query.andWhere('a.hasError = :hasError', { hasError: params.hasError });
    }
    if (params.minDuration) {
      query.andWhere('a.durationMs >= :minDuration', { minDuration: params.minDuration });
    }
    if (params.start) {
      query.andWhere('a.timestamp >= :start', { start: params.start });
    }
    if (params.end) {
      query.andWhere('a.timestamp <= :end', { end: params.end });
    }

    query.orderBy('a.timestamp', 'DESC');

    const page = params.page || 1;
    const limit = params.limit || 100;
    query.skip((page - 1) * limit).take(limit);

    const calls = await query.getMany();

    // Calculate summary
    const summaryQuery = this.apiCallRepo
      .createQueryBuilder('a')
      .select('COUNT(*)', 'totalCalls')
      .addSelect('SUM(a.durationMs)', 'totalDuration')
      .addSelect('AVG(a.durationMs)', 'avgDuration')
      .addSelect('SUM(CASE WHEN a.hasError THEN 1 ELSE 0 END)', 'errorCount')
      .where('a.tenantId = :tenantId', { tenantId: params.tenantId });

    if (params.start) {
      summaryQuery.andWhere('a.timestamp >= :start', { start: params.start });
    }
    if (params.end) {
      summaryQuery.andWhere('a.timestamp <= :end', { end: params.end });
    }

    const summaryRaw = await summaryQuery.getRawOne();

    // Status breakdown
    const statusBreakdownRaw = await this.apiCallRepo
      .createQueryBuilder('a')
      .select('a.responseStatus', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('a.tenantId = :tenantId', { tenantId: params.tenantId })
      .groupBy('a.responseStatus')
      .getRawMany();

    const statusBreakdown: Record<string, number> = {};
    for (const item of statusBreakdownRaw) {
      statusBreakdown[item.status] = parseInt(item.count, 10);
    }

    // Endpoint breakdown
    const endpointBreakdownRaw = await this.apiCallRepo
      .createQueryBuilder('a')
      .select('a.endpoint', 'endpoint')
      .addSelect('COUNT(*)', 'count')
      .addSelect('AVG(a.durationMs)', 'avgDuration')
      .where('a.tenantId = :tenantId', { tenantId: params.tenantId })
      .groupBy('a.endpoint')
      .orderBy('count', 'DESC')
      .limit(20)
      .getRawMany();

    return {
      calls,
      summary: {
        totalCalls: parseInt(summaryRaw?.totalCalls, 10) || 0,
        totalDuration: parseFloat(summaryRaw?.totalDuration) || 0,
        avgDuration: parseFloat(summaryRaw?.avgDuration) || 0,
        errorCount: parseInt(summaryRaw?.errorCount, 10) || 0,
        statusBreakdown,
        endpointBreakdown: endpointBreakdownRaw.map((e) => ({
          endpoint: e.endpoint,
          count: parseInt(e.count, 10),
          avgDuration: parseFloat(e.avgDuration) || 0,
        })),
      },
    };
  }

  private sanitizeHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
    if (!headers) return undefined;

    const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key', 'x-auth-token'];
    const sanitized = { ...headers };

    for (const key of Object.keys(sanitized)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      }
    }

    return sanitized;
  }

  private sanitizeBody(body: unknown): unknown {
    if (!body || typeof body !== 'object') return body;

    const sensitiveFields = ['password', 'token', 'secret', 'apiKey', 'creditCard'];
    const sanitized = JSON.parse(JSON.stringify(body));

    const sanitizeObject = (obj: Record<string, unknown>) => {
      for (const key of Object.keys(obj)) {
        if (sensitiveFields.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
          obj[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          sanitizeObject(obj[key] as Record<string, unknown>);
        }
      }
    };

    sanitizeObject(sanitized);
    return sanitized;
  }

  private truncateResponse(body: unknown): unknown {
    if (!body) return body;
    const str = JSON.stringify(body);
    if (str.length > 10000) {
      return { truncated: true, preview: str.substring(0, 1000), originalLength: str.length };
    }
    return body;
  }

  async getApiCallDetails(id: string): Promise<CapturedApiCall> {
    const call = await this.apiCallRepo.findOne({ where: { id } });
    if (!call) {
      throw new NotFoundException(`API call not found: ${id}`);
    }
    return call;
  }

  async getApiUsageSummary(
    tenantId: string,
    period?: string,
  ): Promise<{
    totalCalls: number;
    avgResponseTime: number;
    errorRate: number;
    topEndpoints: Array<{ endpoint: string; count: number; avgDuration: number }>;
    statusDistribution: Record<string, number>;
  }> {
    const query = this.apiCallRepo.createQueryBuilder('a');
    query.where('a.tenantId = :tenantId', { tenantId });

    // Apply period filter
    if (period) {
      const now = new Date();
      let startDate: Date;
      switch (period) {
        case '1h':
          startDate = new Date(now.getTime() - 60 * 60 * 1000);
          break;
        case '24h':
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case '7d':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      }
      query.andWhere('a.timestamp >= :startDate', { startDate });
    }

    const summaryRaw = await query
      .select('COUNT(*)', 'totalCalls')
      .addSelect('AVG(a.durationMs)', 'avgResponseTime')
      .addSelect('SUM(CASE WHEN a.hasError THEN 1 ELSE 0 END)', 'errorCount')
      .getRawOne();

    const totalCalls = parseInt(summaryRaw?.totalCalls, 10) || 0;
    const errorCount = parseInt(summaryRaw?.errorCount, 10) || 0;

    // Top endpoints
    const topEndpointsRaw = await this.apiCallRepo
      .createQueryBuilder('a')
      .select('a.endpoint', 'endpoint')
      .addSelect('COUNT(*)', 'count')
      .addSelect('AVG(a.durationMs)', 'avgDuration')
      .where('a.tenantId = :tenantId', { tenantId })
      .groupBy('a.endpoint')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    // Status distribution
    const statusRaw = await this.apiCallRepo
      .createQueryBuilder('a')
      .select('a.responseStatus', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('a.tenantId = :tenantId', { tenantId })
      .groupBy('a.responseStatus')
      .getRawMany();

    const statusDistribution: Record<string, number> = {};
    for (const item of statusRaw) {
      statusDistribution[item.status] = parseInt(item.count, 10);
    }

    return {
      totalCalls,
      avgResponseTime: parseFloat(summaryRaw?.avgResponseTime) || 0,
      errorRate: totalCalls > 0 ? (errorCount / totalCalls) * 100 : 0,
      topEndpoints: topEndpointsRaw.map(e => ({
        endpoint: e.endpoint,
        count: parseInt(e.count, 10),
        avgDuration: parseFloat(e.avgDuration) || 0,
      })),
      statusDistribution,
    };
  }

  // ============================================================================
  // Cache Inspector
  // ============================================================================

  async snapshotCache(
    tenantId: string,
    debugSessionId?: string,
    cacheStore?: string,
  ): Promise<CacheInspectorResult> {
    // In production, this would connect to Redis/Memcached and list keys
    // For now, we'll return stored snapshots

    const query = this.cacheSnapshotRepo.createQueryBuilder('c');

    if (tenantId) {
      query.where('c.tenantId = :tenantId', { tenantId });
    }
    if (debugSessionId) {
      query.andWhere('c.debugSessionId = :debugSessionId', { debugSessionId });
    }
    if (cacheStore) {
      query.andWhere('c.cacheStore = :cacheStore', { cacheStore });
    }

    query.orderBy('c.capturedAt', 'DESC').limit(500);

    const entries = await query.getMany();

    const now = new Date();
    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

    const storeBreakdown: Record<string, number> = {};
    let totalSizeBytes = 0;
    let totalTtl = 0;
    let expiringInHour = 0;

    for (const entry of entries) {
      totalSizeBytes += entry.sizeBytes || 0;
      totalTtl += entry.ttlSeconds || 0;

      if (entry.expiresAt && entry.expiresAt <= inOneHour) {
        expiringInHour++;
      }

      const store = entry.cacheStore || 'default';
      storeBreakdown[store] = (storeBreakdown[store] || 0) + 1;
    }

    return {
      entries,
      summary: {
        totalKeys: entries.length,
        totalSizeBytes,
        avgTtlSeconds: entries.length > 0 ? totalTtl / entries.length : 0,
        expiringInHour,
        storeBreakdown,
      },
    };
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
    const snapshot = this.cacheSnapshotRepo.create({
      ...data,
      capturedAt: new Date(),
    });

    return this.cacheSnapshotRepo.save(snapshot);
  }

  async getCacheEntry(key: string): Promise<CacheEntrySnapshot | null> {
    const entry = await this.cacheSnapshotRepo.findOne({
      where: { key },
      order: { capturedAt: 'DESC' },
    });
    return entry;
  }

  async invalidateCacheByKey(key: string): Promise<void> {
    // In production, this would invalidate the actual cache key
    this.logger.log(`[Cache] Invalidated key: ${key}`);
  }

  async invalidateCacheKey(tenantId: string, key: string): Promise<void> {
    // In production, this would invalidate the actual cache key
    this.logger.log(`[Cache] Invalidated key: ${key} for tenant: ${tenantId}`);
  }

  async invalidateCachePattern(tenantId: string, pattern: string): Promise<number> {
    // In production, this would use SCAN and DEL on Redis
    this.logger.log(`[Cache] Invalidated pattern: ${pattern} for tenant: ${tenantId}`);
    return 0;
  }

  // ============================================================================
  // Feature Flag Override
  // ============================================================================

  async createFeatureFlagOverride(data: {
    tenantId: string;
    featureKey: string;
    originalValue: unknown;
    overrideValue: unknown;
    adminId: string;
    reason?: string;
    expiresAt?: Date;
  }): Promise<FeatureFlagOverride> {
    // Check for existing override
    const existing = await this.overrideRepo.findOne({
      where: { tenantId: data.tenantId, featureKey: data.featureKey, isActive: true },
    });

    if (existing) {
      throw new BadRequestException(
        `Override already exists for feature '${data.featureKey}' on tenant '${data.tenantId}'`,
      );
    }

    const override = this.overrideRepo.create({
      ...data,
      isActive: true,
      appliedAt: new Date(),
    });

    const saved = await this.overrideRepo.save(override);

    this.logger.log(
      `Created feature flag override: ${data.featureKey} = ${JSON.stringify(data.overrideValue)} for tenant ${data.tenantId}`,
    );

    return saved;
  }

  async revertFeatureFlagOverride(overrideId: string, revertedBy: string): Promise<FeatureFlagOverride> {
    const override = await this.overrideRepo.findOne({ where: { id: overrideId } });
    if (!override) {
      throw new NotFoundException(`Override not found: ${overrideId}`);
    }

    override.isActive = false;
    override.revertedAt = new Date();
    override.revertedBy = revertedBy;

    const saved = await this.overrideRepo.save(override);

    this.logger.log(`Reverted feature flag override: ${override.featureKey} for tenant ${override.tenantId}`);

    return saved;
  }

  async getActiveOverridesForTenant(tenantId: string): Promise<FeatureFlagOverride[]> {
    return this.overrideRepo.find({
      where: { tenantId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  async getFeatureOverride(id: string): Promise<FeatureFlagOverride> {
    const override = await this.overrideRepo.findOne({ where: { id } });
    if (!override) {
      throw new NotFoundException(`Feature override not found: ${id}`);
    }
    return override;
  }

  async getFeatureFlagValue(tenantId: string, featureKey: string, defaultValue: unknown): Promise<unknown> {
    const override = await this.overrideRepo.findOne({
      where: { tenantId, featureKey, isActive: true },
    });

    if (override) {
      // Check expiration
      if (override.expiresAt && override.expiresAt < new Date()) {
        await this.revertFeatureFlagOverride(override.id, 'system');
        return defaultValue;
      }
      return override.overrideValue;
    }

    return defaultValue;
  }

  async queryOverrides(params: {
    tenantId?: string;
    adminId?: string;
    featureKey?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{ items: FeatureFlagOverride[]; total: number }> {
    const query = this.overrideRepo.createQueryBuilder('o');

    if (params.tenantId) {
      query.andWhere('o.tenantId = :tenantId', { tenantId: params.tenantId });
    }
    if (params.adminId) {
      query.andWhere('o.adminId = :adminId', { adminId: params.adminId });
    }
    if (params.featureKey) {
      query.andWhere('o.featureKey = :featureKey', { featureKey: params.featureKey });
    }
    if (params.isActive !== undefined) {
      query.andWhere('o.isActive = :isActive', { isActive: params.isActive });
    }

    query.orderBy('o.createdAt', 'DESC');

    const page = params.page || 1;
    const limit = params.limit || 20;
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return { items, total };
  }

  // ============================================================================
  // Dashboard
  // ============================================================================

  async getDebugDashboard(tenantId?: string): Promise<DebugDashboard> {
    const activeSessions = await this.debugSessionRepo.find({
      where: tenantId ? { tenantId, isActive: true } : { isActive: true },
      order: { createdAt: 'DESC' },
      take: 10,
    });

    const recentQueries = await this.queryRepo.find({
      where: tenantId ? { tenantId } : {},
      order: { timestamp: 'DESC' },
      take: 10,
    });

    const recentApiCalls = await this.apiCallRepo.find({
      where: tenantId ? { tenantId } : {},
      order: { timestamp: 'DESC' },
      take: 10,
    });

    const activeOverrides = await this.overrideRepo.find({
      where: tenantId ? { tenantId, isActive: true } : { isActive: true },
      order: { createdAt: 'DESC' },
      take: 10,
    });

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

  // ============================================================================
  // Buffer Management
  // ============================================================================

  private async flushQueryBuffer(): Promise<void> {
    if (this.queryBuffer.length === 0) return;

    const queries = [...this.queryBuffer];
    this.queryBuffer = [];

    try {
      await this.queryRepo.save(queries);
    } catch (error) {
      this.logger.error('Failed to flush query buffer', error);
      this.queryBuffer.push(...queries);
    }
  }

  private async flushApiCallBuffer(): Promise<void> {
    if (this.apiCallBuffer.length === 0) return;

    const calls = [...this.apiCallBuffer];
    this.apiCallBuffer = [];

    try {
      await this.apiCallRepo.save(calls);
    } catch (error) {
      this.logger.error('Failed to flush API call buffer', error);
      this.apiCallBuffer.push(...calls);
    }
  }

  // ============================================================================
  // Filter Matching
  // ============================================================================

  private matchesFilters(query: CapturedQuery, filters?: DebugSession['filters']): boolean {
    if (!filters) return true;

    if (filters.queryTypes && filters.queryTypes.length > 0) {
      if (!filters.queryTypes.includes(query.queryType)) return false;
    }
    if (filters.minDuration && query.durationMs < filters.minDuration) return false;
    if (filters.includeErrors === false && query.hasError) return false;
    if (filters.userId && query.userId !== filters.userId) return false;

    return true;
  }

  private matchesApiFilters(call: CapturedApiCall, filters?: DebugSession['filters']): boolean {
    if (!filters) return true;

    if (filters.apiEndpoints && filters.apiEndpoints.length > 0) {
      if (!filters.apiEndpoints.some((e) => call.endpoint.includes(e))) return false;
    }
    if (filters.minDuration && call.durationMs < filters.minDuration) return false;
    if (filters.includeErrors === false && call.hasError) return false;
    if (filters.userId && call.userId !== filters.userId) return false;

    return true;
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  @Cron(CronExpression.EVERY_MINUTE)
  async expireDebugSessions(): Promise<void> {
    const expired = await this.debugSessionRepo.find({
      where: {
        isActive: true,
        expiresAt: LessThan(new Date()),
      },
    });

    for (const session of expired) {
      session.isActive = false;
      await this.debugSessionRepo.save(session);
    }

    if (expired.length > 0) {
      this.logger.debug(`Expired ${expired.length} debug sessions`);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async expireOverrides(): Promise<void> {
    const expired = await this.overrideRepo.find({
      where: {
        isActive: true,
        expiresAt: LessThan(new Date()),
      },
    });

    for (const override of expired) {
      override.isActive = false;
      override.revertedAt = new Date();
      override.revertedBy = 'system';
      await this.overrideRepo.save(override);
    }

    if (expired.length > 0) {
      this.logger.log(`Expired ${expired.length} feature flag overrides`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async cleanupOldData(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    await Promise.all([
      this.queryRepo.delete({ timestamp: LessThan(cutoff) }),
      this.apiCallRepo.delete({ timestamp: LessThan(cutoff) }),
      this.cacheSnapshotRepo.delete({ capturedAt: LessThan(cutoff) }),
      this.debugSessionRepo.delete({ isActive: false, createdAt: LessThan(cutoff) }),
    ]);

    this.logger.log('Cleaned up old debug data');
  }

  // ============================================================================
  // Cache Stats
  // ============================================================================

  async getCacheStats(tenantId?: string): Promise<{
    totalEntries: number;
    totalSize: number;
    hitRate: number;
    missRate: number;
    byStore: Array<{ store: string; entries: number; size: number }>;
  }> {
    const query = this.cacheSnapshotRepo.createQueryBuilder('c');

    if (tenantId) {
      query.where('c.tenantId = :tenantId', { tenantId });
    }

    const entries = await query.getMany();

    const storeStats: Record<string, { entries: number; size: number }> = {};
    let totalSize = 0;
    let totalHits = 0;

    for (const entry of entries) {
      totalSize += entry.sizeBytes || 0;
      totalHits += entry.hitCount || 0;

      const store = entry.cacheStore || 'default';
      if (!storeStats[store]) {
        storeStats[store] = { entries: 0, size: 0 };
      }
      storeStats[store].entries++;
      storeStats[store].size += entry.sizeBytes || 0;
    }

    const totalEntries = entries.length;
    const hitRate = totalEntries > 0 ? (totalHits / (totalHits + totalEntries)) * 100 : 0;
    const missRate = 100 - hitRate;

    return {
      totalEntries,
      totalSize,
      hitRate: Math.round(hitRate * 10) / 10,
      missRate: Math.round(missRate * 10) / 10,
      byStore: Object.entries(storeStats).map(([store, stats]) => ({
        store,
        entries: stats.entries,
        size: stats.size,
      })),
    };
  }
}
