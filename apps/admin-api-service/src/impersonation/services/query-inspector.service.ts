import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  CapturedQuery,
  DebugSession,
  DebugSessionType,
  QueryLogType,
} from '../entities/debug-session.entity';
import { QueryInspectorResult, SlowQueryAnalysis } from './debug-tools-types';

/**
 * Query Inspector Service
 * Handles database query capture, inspection, and analysis
 * SRP: Only responsible for query profiling operations
 */
@Injectable()
export class QueryInspectorService {
  private readonly logger = new Logger(QueryInspectorService.name);
  private queryBuffer: CapturedQuery[] = [];
  private readonly BUFFER_SIZE = 100;

  constructor(
    @InjectRepository(CapturedQuery)
    private readonly queryRepo: Repository<CapturedQuery>,
    @InjectRepository(DebugSession)
    private readonly debugSessionRepo: Repository<DebugSession>,
  ) {}

  /**
   * Capture a query for debugging
   */
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
      await this.flushBuffer();
    }
  }

  /**
   * Inspect captured queries with filters
   */
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
    await this.flushBuffer();

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

  /**
   * Get query explain plan
   */
  async getQueryExplainPlan(queryId: string): Promise<Record<string, unknown> | null> {
    const query = await this.queryRepo.findOne({ where: { id: queryId } });
    return query?.explainPlan || null;
  }

  /**
   * Analyze slow queries
   */
  async getSlowQueryAnalysis(tenantId: string, threshold?: number): Promise<SlowQueryAnalysis> {
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

  /**
   * Get recent queries for dashboard
   */
  async getRecentQueries(tenantId?: string, limit: number = 10): Promise<CapturedQuery[]> {
    return this.queryRepo.find({
      where: tenantId ? { tenantId } : {},
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  /**
   * Normalize query for pattern matching
   */
  private normalizeQuery(query: string): string {
    return query
      .replace(/\s+/g, ' ')
      .replace(/\$\d+/g, '?')
      .replace(/'[^']*'/g, "'?'")
      .trim()
      .substring(0, 500);
  }

  /**
   * Check if query matches session filters
   */
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

  /**
   * Flush buffer to database
   */
  async flushBuffer(): Promise<void> {
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

  /**
   * Cleanup old query data
   */
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async cleanupOldData(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    await this.queryRepo.delete({ timestamp: LessThan(cutoff) });
    this.logger.log('Cleaned up old query data');
  }
}
