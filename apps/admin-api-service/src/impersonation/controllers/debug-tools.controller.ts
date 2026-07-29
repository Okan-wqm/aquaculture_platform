import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { ApiTags } from '@nestjs/swagger';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { Type } from 'class-transformer';
import { Request } from 'express';
import { getAuthUserId, getAuthUser } from '../../shared/authenticated-request';

import {
  IsUUID,
  IsEnum,
  IsOptional,
  IsObject,
  IsString,
  IsNotEmpty,
  IsInt,
  IsNumber,
  IsBoolean,
  IsArray,
  MaxLength,
  Min,
  Max,
  ArrayMaxSize,
  ValidateNested,
  IsDefined,
} from 'class-validator';

import {
  CapturedApiCall,
  DebugSession,
  DebugSessionType,
  FeatureFlagOverride,
  QueryLogType,
} from '../entities/debug-session.entity';
import {
  ApiLogResult,
  ApiUsageSummary,
  CacheKeyValue,
  CacheNamespaceListing,
  CacheStats,
  DebugDashboard,
  QueryInspectorResult,
  SlowQueryAnalysis,
} from '../services/debug-tools-types';
import { DebugToolsService } from '../services/debug-tools.service';

// ============================================================================
// DTOs
// ============================================================================

class DebugSessionFiltersDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  startTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  endTime?: string;

  @IsOptional()
  @IsArray()
  @IsEnum(QueryLogType, { each: true })
  queryTypes?: QueryLogType[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  apiEndpoints?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  cacheKeys?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minDuration?: number;

  @IsOptional()
  @IsBoolean()
  includeErrors?: boolean;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

class StartDebugSessionDto {
  @IsUUID()
  tenantId!: string;

  @IsEnum(DebugSessionType)
  sessionType!: DebugSessionType;

  @IsOptional()
  @IsObject()
  configuration?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => DebugSessionFiltersDto)
  filters?: DebugSessionFiltersDto;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  maxResults?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  durationMinutes?: number;
}

class CaptureQueryDto {
  @IsUUID()
  tenantId!: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsEnum(QueryLogType)
  queryType!: QueryLogType;

  @IsNotEmpty()
  @IsString()
  @MaxLength(50000)
  query!: string;

  @IsOptional()
  @IsArray()
  parameters?: unknown[];

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  durationMs!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  rowsAffected?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  rowsReturned?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  tableName?: string;

  @IsOptional()
  @IsObject()
  explainPlan?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  hasError?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  errorMessage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  stackTrace?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  connectionSource?: string;
}

class CaptureApiCallDto {
  @IsUUID()
  tenantId!: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(10)
  method!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  endpoint!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  fullUrl?: string;

  @IsOptional()
  @IsObject()
  requestHeaders?: Record<string, string>;

  @IsOptional()
  requestBody?: unknown;

  @IsOptional()
  @IsObject()
  queryParams?: Record<string, string>;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(599)
  responseStatus!: number;

  @IsOptional()
  @IsObject()
  responseHeaders?: Record<string, string>;

  @IsOptional()
  responseBody?: unknown;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  durationMs!: number;

  @IsOptional()
  @IsString()
  @MaxLength(45)
  clientIp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  userAgent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  correlationId?: string;

  @IsOptional()
  @IsBoolean()
  hasError?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  errorMessage?: string;
}

class CreateFeatureFlagOverrideDto {
  @IsUUID()
  tenantId!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  featureKey!: string;

  @IsDefined()
  originalValue!: unknown;

  @IsDefined()
  overrideValue!: unknown;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  expiresAt?: string;
}

/**
 * Which keys to list, and how many.
 *
 * A validated class rather than loose `@Query()` primitives: the previous
 * version read `tenantId`/`debugSessionId`/`cacheStore` individually, so the
 * panel's `keyPattern` and `limit` were silently dropped by the global
 * whitelist and the service hard-coded a 500-key ceiling nobody could see.
 */
class ListCacheEntriesDto {
  /**
   * A Redis MATCH glob, applied inside this service's key namespace. Defaults
   * to every key rather than none, because a listing endpoint that returns
   * nothing without an argument reads exactly like an empty cache.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  keyPattern?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

class InvalidateCachePatternDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  pattern!: string;
}

/**
 * What an invalidation actually did.
 *
 * The count is the contract, not decoration: the methods this replaced logged
 * "Invalidated" and returned a hard-coded 0, so a caller that ignored the
 * number could not tell a purge from a no-op. A panel that renders it cannot
 * be lied to the same way twice.
 */
export interface CacheInvalidationResult {
  invalidated: number;
}

/** The value a feature flag resolves to for one tenant, override applied. */
export interface ResolvedFeatureFlagValue {
  value: unknown;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Impersonation')
// SECURITY (ORPHAN-HIGH-341): the debug tooling surface (debug dashboard,
// impersonation debug sessions, query inspector that echoes captured SQL,
// cache inspection) exposes cross-tenant operational data and must be
// SUPER_ADMIN-only — matching its sibling ImpersonationController. The guard
// was absent, leaving every /debug/* endpoint reachable by any caller the
// global pipeline let through.
@UseGuards(PlatformAdminGuard)
@Controller('debug')
export class DebugToolsController {
  constructor(private readonly debugToolsService: DebugToolsService) {}

  // ============================================================================
  // Dashboard
  // ============================================================================

  @Get('dashboard')
  async getDebugDashboard(@Query('tenantId') tenantId?: string): Promise<DebugDashboard> {
    return this.debugToolsService.getDebugDashboard(tenantId);
  }

  // ============================================================================
  // Debug Sessions
  // ============================================================================

  @Get('sessions')
  async getSessions(
    @Query('tenantId') tenantId?: string,
    @Query('sessionType') sessionType?: DebugSessionType,
    @Query('isActive') isActive?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<IStandardPaginatedResult<DebugSession>> {
    return this.debugToolsService.querySessions({
      tenantId,
      sessionType,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('sessions')
  async startDebugSession(
    @Body() dto: StartDebugSessionDto,
    // Fix: C6 -- JWT-based identity, client-supplied adminId kaldırıldı
    @Req() req: Request,
  ): Promise<DebugSession> {
    const adminId = getAuthUserId(req);
    if (!adminId) {
      throw new UnauthorizedException('User not authenticated');
    }
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
  async endDebugSession(@Param('id') sessionId: string): Promise<DebugSession> {
    return this.debugToolsService.endDebugSession(sessionId);
  }

  @Get('sessions/:id')
  async getDebugSession(@Param('id') sessionId: string): Promise<DebugSession> {
    return this.debugToolsService.getDebugSession(sessionId);
  }

  @Get('sessions/tenant/:tenantId')
  async getActiveSessionsForTenant(@Param('tenantId') tenantId: string): Promise<DebugSession[]> {
    return this.debugToolsService.getActiveSessionsForTenant(tenantId);
  }

  // ============================================================================
  // Query Inspector
  // ============================================================================

  @Post('queries/capture')
  @HttpCode(HttpStatus.NO_CONTENT)
  async captureQuery(@Body() dto: CaptureQueryDto): Promise<void> {
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
  ): Promise<QueryInspectorResult> {
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
  async getQueryExplainPlan(@Param('id') queryId: string): Promise<Record<string, unknown> | null> {
    return this.debugToolsService.getQueryExplainPlan(queryId);
  }

  @Get('queries/slow-analysis')
  async getSlowQueryAnalysis(
    @Query('tenantId') tenantId: string,
    @Query('threshold') threshold?: number,
  ): Promise<SlowQueryAnalysis> {
    return this.debugToolsService.getSlowQueryAnalysis(
      tenantId,
      threshold ? Number(threshold) : undefined,
    );
  }

  // ============================================================================
  // API Log Viewer
  // ============================================================================

  @Post('api-calls/capture')
  @HttpCode(HttpStatus.NO_CONTENT)
  async captureApiCall(@Body() dto: CaptureApiCallDto): Promise<void> {
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
  ): Promise<ApiLogResult> {
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

  @Get('api-calls/summary')
  async getApiUsageSummary(
    @Query('tenantId') tenantId: string,
    @Query('period') period?: string,
  ): Promise<ApiUsageSummary> {
    return this.debugToolsService.getApiUsageSummary(tenantId, period);
  }

  @Get('api-calls/:id')
  async getApiCallDetails(@Param('id') id: string): Promise<CapturedApiCall> {
    return this.debugToolsService.getApiCallDetails(id);
  }

  // ============================================================================
  // Cache Inspector
  //
  // These address Redis. The routes they replaced read a snapshot table nothing
  // wrote and invalidated nothing, and two of them were unreachable besides:
  // `DELETE cache/:tenantId/:key` was declared before `DELETE cache/tenant/:tenantId`,
  // and Nest matches in declaration order, so the parameterized pair swallowed
  // the literal one. Both are gone — there is one key-scoped delete and one
  // pattern-scoped delete, which is what the namespace supports.
  // ============================================================================

  @Get('cache/stats')
  async getCacheStats(): Promise<CacheStats> {
    return this.debugToolsService.getCacheStats();
  }

  @Get('cache')
  async listCacheEntries(@Query() dto: ListCacheEntriesDto): Promise<CacheNamespaceListing> {
    return this.debugToolsService.listCacheEntries(dto.keyPattern ?? '*', dto.limit ?? 100);
  }

  @Get('cache/:key')
  async getCacheEntry(@Param('key') key: string): Promise<CacheKeyValue | null> {
    // No decodeURIComponent: Express already decoded the path segment, and
    // decoding twice turned a key containing a literal `%` into a different key.
    return this.debugToolsService.getCacheEntry(key);
  }

  @Delete('cache/:key')
  async invalidateCacheKey(@Param('key') key: string): Promise<CacheInvalidationResult> {
    // Not 204: the caller needs to know whether the key was there. The version
    // this replaced returned an empty 204 from a method that did nothing.
    return { invalidated: await this.debugToolsService.invalidateCacheKey(key) };
  }

  @Post('cache/invalidate')
  async invalidateCacheByPattern(
    @Body() dto: InvalidateCachePatternDto,
  ): Promise<CacheInvalidationResult> {
    return { invalidated: await this.debugToolsService.invalidateCachePattern(dto.pattern) };
  }

  // ============================================================================
  // Feature Flag Override
  // ============================================================================

  @Post('feature-overrides')
  async createFeatureFlagOverride(
    @Body() dto: CreateFeatureFlagOverrideDto,
    // Fix: C6 -- JWT-based identity, client-supplied adminId kaldırıldı
    @Req() req: Request,
  ): Promise<FeatureFlagOverride> {
    const adminId = getAuthUserId(req);
    if (!adminId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.debugToolsService.createFeatureFlagOverride({
      ...dto,
      adminId,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
  }

  @Post('feature-overrides/:id/revert')
  async revertFeatureFlagOverride(
    @Param('id') overrideId: string,
    // Fix: C6 -- JWT-based identity, client-supplied adminId kaldırıldı
    @Req() req: Request,
  ): Promise<FeatureFlagOverride> {
    const revertedBy = getAuthUserId(req);
    if (!revertedBy) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.debugToolsService.revertFeatureFlagOverride(overrideId, revertedBy);
  }

  @Get('feature-overrides/tenant/:tenantId')
  async getOverridesForTenant(@Param('tenantId') tenantId: string): Promise<FeatureFlagOverride[]> {
    return this.debugToolsService.getActiveOverridesForTenant(tenantId);
  }

  @Get('feature-overrides/tenant/:tenantId/active')
  async getActiveOverridesForTenant(@Param('tenantId') tenantId: string): Promise<FeatureFlagOverride[]> {
    return this.debugToolsService.getActiveOverridesForTenant(tenantId);
  }

  /**
   * Declared before the `feature-overrides/:id` route — NestJS matches in
   * declaration order, so this static segment must precede its parameterized
   * sibling, or the id route swallows the `value` request (RC-6
   * route-shadowing, APA-307/APA-313).
   */
  @Get('feature-overrides/value')
  async getFeatureFlagValue(
    @Query('tenantId') tenantId: string,
    @Query('featureKey') featureKey: string,
    @Query('defaultValue') defaultValue: string,
  ): Promise<ResolvedFeatureFlagValue> {
    // H24 fix: Sanitize JSON.parse to prevent prototype pollution
    // Only accept primitive values (string, number, boolean, null)
    let parsed: unknown;
    try {
      parsed = JSON.parse(defaultValue);
    } catch {
      parsed = defaultValue; // fallback to raw string if not valid JSON
    }
    if (parsed !== null && typeof parsed === 'object') {
      // Reject objects/arrays to prevent prototype pollution
      parsed = String(defaultValue);
    }

    const value = await this.debugToolsService.getFeatureFlagValue(
      tenantId,
      featureKey,
      parsed,
    );
    return { value };
  }

  @Get('feature-overrides/:id')
  async getFeatureOverride(@Param('id') id: string): Promise<FeatureFlagOverride> {
    return this.debugToolsService.getFeatureOverride(id);
  }

  @Get('feature-overrides')
  async queryOverrides(
    @Query('tenantId') tenantId?: string,
    @Query('featureKey') featureKey?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    // Fix: C6 -- JWT-based identity, client-supplied adminId kaldırıldı
    @Req() req?: Request,
  ): Promise<IStandardPaginatedResult<FeatureFlagOverride>> {
    const adminId = req ? getAuthUserId(req) : undefined;
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
