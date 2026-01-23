import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  CapturedApiCall,
  DebugSession,
  DebugSessionType,
} from '../entities/debug-session.entity';
import { ApiLogResult, ApiUsageSummary } from './debug-tools-types';

/**
 * API Call Inspector Service
 * Handles API call logging and inspection
 * SRP: Only responsible for API call profiling operations
 */
@Injectable()
export class ApiCallInspectorService {
  private readonly logger = new Logger(ApiCallInspectorService.name);
  private apiCallBuffer: CapturedApiCall[] = [];
  private readonly BUFFER_SIZE = 100;

  constructor(
    @InjectRepository(CapturedApiCall)
    private readonly apiCallRepo: Repository<CapturedApiCall>,
    @InjectRepository(DebugSession)
    private readonly debugSessionRepo: Repository<DebugSession>,
  ) {}

  /**
   * Capture an API call for debugging
   */
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
      await this.flushBuffer();
    }
  }

  /**
   * Inspect captured API calls with filters
   */
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
    await this.flushBuffer();

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

  /**
   * Get API call details
   */
  async getApiCallDetails(id: string): Promise<CapturedApiCall> {
    const call = await this.apiCallRepo.findOne({ where: { id } });
    if (!call) {
      throw new NotFoundException(`API call not found: ${id}`);
    }
    return call;
  }

  /**
   * Get API usage summary
   */
  async getApiUsageSummary(tenantId: string, period?: string): Promise<ApiUsageSummary> {
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

  /**
   * Get recent API calls for dashboard
   */
  async getRecentApiCalls(tenantId?: string, limit: number = 10): Promise<CapturedApiCall[]> {
    return this.apiCallRepo.find({
      where: tenantId ? { tenantId } : {},
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  /**
   * Sanitize headers by redacting sensitive values
   */
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

  /**
   * Sanitize request body by redacting sensitive fields
   */
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

  /**
   * Truncate large response bodies
   */
  private truncateResponse(body: unknown): unknown {
    if (!body) return body;
    const str = JSON.stringify(body);
    if (str.length > 10000) {
      return { truncated: true, preview: str.substring(0, 1000), originalLength: str.length };
    }
    return body;
  }

  /**
   * Check if API call matches session filters
   */
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

  /**
   * Flush buffer to database
   */
  async flushBuffer(): Promise<void> {
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

  /**
   * Cleanup old API call data
   */
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async cleanupOldData(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    await this.apiCallRepo.delete({ timestamp: LessThan(cutoff) });
    this.logger.log('Cleaned up old API call data');
  }
}
