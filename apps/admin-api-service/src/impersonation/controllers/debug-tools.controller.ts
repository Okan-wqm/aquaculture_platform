import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';

import { DebugToolsService } from '../services/debug-tools.service';
import { DebugSessionType, QueryLogType } from '../entities/debug-session.entity';

// ============================================================================
// DTOs
// ============================================================================

class StartDebugSessionDto {
  tenantId: string;
  sessionType: DebugSessionType;
  configuration?: Record<string, unknown>;
  filters?: {
    startTime?: string;
    endTime?: string;
    queryTypes?: QueryLogType[];
    apiEndpoints?: string[];
    cacheKeys?: string[];
    minDuration?: number;
    includeErrors?: boolean;
    userId?: string;
  };
  maxResults?: number;
  durationMinutes?: number;
}

class CaptureQueryDto {
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
}

class CaptureApiCallDto {
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
}

class CreateFeatureFlagOverrideDto {
  tenantId: string;
  featureKey: string;
  originalValue: unknown;
  overrideValue: unknown;
  reason?: string;
  expiresAt?: string;
}

class CaptureSnapshotDto {
  tenantId?: string;
  key: string;
  value?: unknown;
  sizeBytes?: number;
  ttlSeconds?: number;
  expiresAt?: string;
  hitCount?: number;
  lastAccessedAt?: string;
  cacheStore?: string;
  tags?: string[];
}

// ============================================================================
// Controller
// ============================================================================

@Controller('debug')
export class DebugToolsController {
  constructor(private readonly debugToolsService: DebugToolsService) {}

  // ============================================================================
  // Dashboard
  // ============================================================================

  @Get('dashboard')
  async getDebugDashboard(@Query('tenantId') tenantId?: string) {
    return this.debugToolsService.getDebugDashboard(tenantId);
  }

  // ============================================================================
  // Debug Sessions
  // ============================================================================

  @Post('sessions')
  async startDebugSession(
    @Body() dto: StartDebugSessionDto,
    @Query('adminId') adminId: string,
  ) {
    return this.debugToolsService.startDebugSession({
      adminId,
      tenantId: dto.tenantId,
      sessionType: dto.sessionType,
      configuration: dto.configuration,
      filters: dto.filters
        ? {
            ...dto.filters,
            startTime: dto.filters.startTime ? new Date(dto.filters.startTime) : undefined,
            endTime: dto.filters.endTime ? new Date(dto.filters.endTime) : undefined,
          }
        : undefined,
      maxResults: dto.maxResults,
      durationMinutes: dto.durationMinutes,
    });
  }

  @Post('sessions/:id/end')
  async endDebugSession(@Param('id') sessionId: string) {
    return this.debugToolsService.endDebugSession(sessionId);
  }

  @Get('sessions/:id')
  async getDebugSession(@Param('id') sessionId: string) {
    return this.debugToolsService.getDebugSession(sessionId);
  }

  @Get('sessions/tenant/:tenantId')
  async getActiveSessionsForTenant(@Param('tenantId') tenantId: string) {
    return this.debugToolsService.getActiveSessionsForTenant(tenantId);
  }

  // ============================================================================
  // Query Inspector
  // ============================================================================

  @Post('queries/capture')
  @HttpCode(HttpStatus.NO_CONTENT)
  async captureQuery(@Body() dto: CaptureQueryDto) {
    await this.debugToolsService.captureQuery(dto);
  }

  @Get('queries')
  async inspectQueries(
    @Query('tenantId') tenantId: string,
    @Query('debugSessionId') debugSessionId?: string,
    @Query('queryType') queryType?: QueryLogType,
    @Query('tableName') tableName?: string,
    @Query('minDuration') minDuration?: number,
    @Query('hasError') hasError?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.debugToolsService.inspectQueries({
      tenantId,
      debugSessionId,
      queryType,
      tableName,
      minDuration: minDuration ? Number(minDuration) : undefined,
      hasError: hasError !== undefined ? hasError === 'true' : undefined,
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('queries/:id/explain')
  async getQueryExplainPlan(@Param('id') queryId: string) {
    return this.debugToolsService.getQueryExplainPlan(queryId);
  }

  // ============================================================================
  // API Log Viewer
  // ============================================================================

  @Post('api-calls/capture')
  @HttpCode(HttpStatus.NO_CONTENT)
  async captureApiCall(@Body() dto: CaptureApiCallDto) {
    await this.debugToolsService.captureApiCall(dto);
  }

  @Get('api-calls')
  async inspectApiCalls(
    @Query('tenantId') tenantId: string,
    @Query('debugSessionId') debugSessionId?: string,
    @Query('method') method?: string,
    @Query('endpoint') endpoint?: string,
    @Query('statusCode') statusCode?: number,
    @Query('hasError') hasError?: string,
    @Query('minDuration') minDuration?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.debugToolsService.inspectApiCalls({
      tenantId,
      debugSessionId,
      method,
      endpoint,
      statusCode: statusCode ? Number(statusCode) : undefined,
      hasError: hasError !== undefined ? hasError === 'true' : undefined,
      minDuration: minDuration ? Number(minDuration) : undefined,
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ============================================================================
  // Cache Inspector
  // ============================================================================

  @Get('cache/stats')
  async getCacheStats(@Query('tenantId') tenantId?: string) {
    return this.debugToolsService.getCacheStats(tenantId);
  }

  @Get('cache')
  async snapshotCache(
    @Query('tenantId') tenantId: string,
    @Query('debugSessionId') debugSessionId?: string,
    @Query('cacheStore') cacheStore?: string,
  ) {
    return this.debugToolsService.snapshotCache(tenantId, debugSessionId, cacheStore);
  }

  @Post('cache/capture')
  async captureCacheEntry(@Body() dto: CaptureSnapshotDto) {
    return this.debugToolsService.captureCacheEntry({
      ...dto,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      lastAccessedAt: dto.lastAccessedAt ? new Date(dto.lastAccessedAt) : undefined,
    });
  }

  @Delete('cache/:tenantId/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  async invalidateCacheKey(
    @Param('tenantId') tenantId: string,
    @Param('key') key: string,
  ) {
    await this.debugToolsService.invalidateCacheKey(tenantId, key);
  }

  @Delete('cache/:tenantId')
  async invalidateCachePattern(
    @Param('tenantId') tenantId: string,
    @Query('pattern') pattern: string,
  ) {
    const count = await this.debugToolsService.invalidateCachePattern(tenantId, pattern);
    return { invalidatedCount: count };
  }

  // ============================================================================
  // Feature Flag Override
  // ============================================================================

  @Post('feature-overrides')
  async createFeatureFlagOverride(
    @Body() dto: CreateFeatureFlagOverrideDto,
    @Query('adminId') adminId: string,
  ) {
    return this.debugToolsService.createFeatureFlagOverride({
      ...dto,
      adminId,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
  }

  @Post('feature-overrides/:id/revert')
  async revertFeatureFlagOverride(
    @Param('id') overrideId: string,
    @Query('adminId') revertedBy: string,
  ) {
    return this.debugToolsService.revertFeatureFlagOverride(overrideId, revertedBy);
  }

  @Get('feature-overrides/tenant/:tenantId')
  async getActiveOverridesForTenant(@Param('tenantId') tenantId: string) {
    return this.debugToolsService.getActiveOverridesForTenant(tenantId);
  }

  @Get('feature-overrides/value')
  async getFeatureFlagValue(
    @Query('tenantId') tenantId: string,
    @Query('featureKey') featureKey: string,
    @Query('defaultValue') defaultValue: string,
  ) {
    const value = await this.debugToolsService.getFeatureFlagValue(
      tenantId,
      featureKey,
      JSON.parse(defaultValue),
    );
    return { value };
  }

  @Get('feature-overrides')
  async queryOverrides(
    @Query('tenantId') tenantId?: string,
    @Query('adminId') adminId?: string,
    @Query('featureKey') featureKey?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.debugToolsService.queryOverrides({
      tenantId,
      adminId,
      featureKey,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
