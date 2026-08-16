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
  NotFoundException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
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

import { DebugSessionType, QueryLogType } from '../entities/debug-session.entity';
import { DebugToolsService } from '../services/debug-tools.service';
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  debugToolsDebugDashboardContract,
  type DebugToolsDebugDashboardDto,
  debugToolsDebugSessionPageContract,
  type DebugToolsDebugSessionDto,
  debugToolsDebugSessionContract,
  debugToolsDebugSessionArrayContract,
  voidResponseContract,
  type VoidResponseDto,
  debugToolsQueryInspectorResultContract,
  type DebugToolsQueryInspectorResultDto,
  debugToolsGetQueryExplainPlanResponseContract,
  type DebugToolsGetQueryExplainPlanResponseDto,
  debugToolsSlowQueryAnalysisContract,
  type DebugToolsSlowQueryAnalysisDto,
  debugToolsApiLogResultContract,
  type DebugToolsApiLogResultDto,
  debugToolsApiUsageSummaryContract,
  type DebugToolsApiUsageSummaryDto,
  debugToolsCapturedApiCallContract,
  type DebugToolsCapturedApiCallDto,
  debugToolsCacheStatsContract,
  type DebugToolsCacheStatsDto,
  debugToolsCacheNamespaceListingContract,
  type DebugToolsCacheNamespaceListingDto,
  debugToolsCacheKeyValueContract,
  type DebugToolsCacheKeyValueDto,
  debugToolsCacheInvalidationReceiptContract,
  type DebugToolsCacheInvalidationReceiptDto,
  debugToolsFeatureFlagOverrideContract,
  type DebugToolsFeatureFlagOverrideDto,
  debugToolsFeatureFlagOverrideArrayContract,
  debugToolsGetFeatureFlagValueResponseContract,
  type DebugToolsGetFeatureFlagValueResponseDto,
  debugToolsQueryOverridesResponseContract,
  type DebugToolsQueryOverridesResponseDto,
} from '../contracts/admin-http-response.contract';

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

class ListCacheEntriesDto {
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

  @AdminResponseContract(debugToolsDebugDashboardContract)
  @Get('dashboard')
  async getDebugDashboard(
    @Query('tenantId') tenantId?: string,
  ): Promise<DebugToolsDebugDashboardDto> {
    return this.debugToolsService.getDebugDashboard(tenantId);
  }

  // ============================================================================
  // Debug Sessions
  // ============================================================================

  @AdminResponseContract(debugToolsDebugSessionPageContract)
  @Get('sessions')
  async getSessions(
    @Query('tenantId') tenantId?: string,
    @Query('sessionType') sessionType?: DebugSessionType,
    @Query('isActive') isActive?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<IStandardPaginatedResult<DebugToolsDebugSessionDto>> {
    return this.debugToolsService.querySessions({
      tenantId,
      sessionType,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @AdminResponseContract(debugToolsDebugSessionContract)
  @Post('sessions')
  async startDebugSession(
    @Body() dto: StartDebugSessionDto,
    // Fix: C6 -- JWT-based identity, client-supplied adminId kaldırıldı
    @Req() req: Request,
  ): Promise<DebugToolsDebugSessionDto> {
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

  @AdminResponseContract(debugToolsDebugSessionContract)
  @Post('sessions/:id/end')
  async endDebugSession(@Param('id') sessionId: string): Promise<DebugToolsDebugSessionDto> {
    return this.debugToolsService.endDebugSession(sessionId);
  }

  @AdminResponseContract(debugToolsDebugSessionContract)
  @Get('sessions/:id')
  async getDebugSession(@Param('id') sessionId: string): Promise<DebugToolsDebugSessionDto> {
    return this.debugToolsService.getDebugSession(sessionId);
  }

  @AdminResponseContract(debugToolsDebugSessionArrayContract)
  @Get('sessions/tenant/:tenantId')
  async getActiveSessionsForTenant(
    @Param('tenantId') tenantId: string,
  ): Promise<DebugToolsDebugSessionDto[]> {
    return this.debugToolsService.getActiveSessionsForTenant(tenantId);
  }

  // ============================================================================
  // Query Inspector
  // ============================================================================

  @AdminResponseContract(voidResponseContract)
  @Post('queries/capture')
  @HttpCode(HttpStatus.NO_CONTENT)
  async captureQuery(@Body() dto: CaptureQueryDto): Promise<void> {
    await this.debugToolsService.captureQuery(dto);
  }

  @AdminResponseContract(debugToolsQueryInspectorResultContract)
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
  ): Promise<DebugToolsQueryInspectorResultDto> {
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

  @AdminResponseContract(debugToolsGetQueryExplainPlanResponseContract)
  @Get('queries/:id/explain')
  async getQueryExplainPlan(
    @Param('id') queryId: string,
  ): Promise<DebugToolsGetQueryExplainPlanResponseDto> {
    return this.debugToolsService.getQueryExplainPlan(queryId);
  }

  @AdminResponseContract(debugToolsSlowQueryAnalysisContract)
  @Get('queries/slow-analysis')
  async getSlowQueryAnalysis(
    @Query('tenantId') tenantId: string,
    @Query('threshold') threshold?: number,
  ): Promise<DebugToolsSlowQueryAnalysisDto> {
    return this.debugToolsService.getSlowQueryAnalysis(
      tenantId,
      threshold ? Number(threshold) : undefined,
    );
  }

  // ============================================================================
  // API Log Viewer
  // ============================================================================

  @AdminResponseContract(voidResponseContract)
  @Post('api-calls/capture')
  @HttpCode(HttpStatus.NO_CONTENT)
  async captureApiCall(@Body() dto: CaptureApiCallDto): Promise<void> {
    await this.debugToolsService.captureApiCall(dto);
  }

  @AdminResponseContract(debugToolsApiLogResultContract)
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
  ): Promise<DebugToolsApiLogResultDto> {
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

  @AdminResponseContract(debugToolsApiUsageSummaryContract)
  @Get('api-calls/summary')
  async getApiUsageSummary(
    @Query('tenantId') tenantId: string,
    @Query('period') period?: string,
  ): Promise<DebugToolsApiUsageSummaryDto> {
    return this.debugToolsService.getApiUsageSummary(tenantId, period);
  }

  @AdminResponseContract(debugToolsCapturedApiCallContract)
  @Get('api-calls/:id')
  async getApiCallDetails(@Param('id') id: string): Promise<DebugToolsCapturedApiCallDto> {
    return this.debugToolsService.getApiCallDetails(id);
  }

  // ============================================================================
  // Cache Inspector
  // ============================================================================

  @AdminResponseContract(debugToolsCacheStatsContract)
  @Get('cache/stats')
  async getCacheStats(): Promise<DebugToolsCacheStatsDto> {
    return this.debugToolsService.getCacheStats();
  }

  @AdminResponseContract(debugToolsCacheNamespaceListingContract)
  @Get('cache')
  async listCacheEntries(
    @Query() query: ListCacheEntriesDto,
  ): Promise<DebugToolsCacheNamespaceListingDto> {
    return this.debugToolsService.listCacheEntries(query.keyPattern ?? '*', query.limit ?? 500);
  }

  @AdminResponseContract(debugToolsCacheKeyValueContract)
  @Get('cache/:key')
  async getCacheEntry(@Param('key') key: string): Promise<DebugToolsCacheKeyValueDto> {
    const decodedKey = decodeURIComponent(key);
    const entry = await this.debugToolsService.getCacheEntry(decodedKey);
    if (entry === null) {
      throw new NotFoundException(`Cache entry ${decodedKey} not found`);
    }
    return entry;
  }

  @AdminResponseContract(debugToolsCacheInvalidationReceiptContract)
  @Delete('cache/:key')
  async invalidateCacheByKey(
    @Param('key') key: string,
  ): Promise<DebugToolsCacheInvalidationReceiptDto> {
    return this.debugToolsService.invalidateCacheKey(decodeURIComponent(key));
  }

  @AdminResponseContract(debugToolsCacheInvalidationReceiptContract)
  @Post('cache/invalidate')
  async invalidateCacheByPattern(
    @Body() dto: InvalidateCachePatternDto,
  ): Promise<DebugToolsCacheInvalidationReceiptDto> {
    return this.debugToolsService.invalidateCachePattern(dto.pattern);
  }

  // ============================================================================
  // Feature Flag Override
  // ============================================================================

  @AdminResponseContract(debugToolsFeatureFlagOverrideContract)
  @Post('feature-overrides')
  async createFeatureFlagOverride(
    @Body() dto: CreateFeatureFlagOverrideDto,
    // Fix: C6 -- JWT-based identity, client-supplied adminId kaldırıldı
    @Req() req: Request,
  ): Promise<DebugToolsFeatureFlagOverrideDto> {
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

  @AdminResponseContract(debugToolsFeatureFlagOverrideContract)
  @Post('feature-overrides/:id/revert')
  async revertFeatureFlagOverride(
    @Param('id') overrideId: string,
    // Fix: C6 -- JWT-based identity, client-supplied adminId kaldırıldı
    @Req() req: Request,
  ): Promise<DebugToolsFeatureFlagOverrideDto> {
    const revertedBy = getAuthUserId(req);
    if (!revertedBy) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.debugToolsService.revertFeatureFlagOverride(overrideId, revertedBy);
  }

  @AdminResponseContract(debugToolsFeatureFlagOverrideArrayContract)
  @Get('feature-overrides/tenant/:tenantId')
  async getOverridesForTenant(
    @Param('tenantId') tenantId: string,
  ): Promise<DebugToolsFeatureFlagOverrideDto[]> {
    return this.debugToolsService.getActiveOverridesForTenant(tenantId);
  }

  @AdminResponseContract(debugToolsFeatureFlagOverrideArrayContract)
  @Get('feature-overrides/tenant/:tenantId/active')
  async getActiveOverridesForTenant(
    @Param('tenantId') tenantId: string,
  ): Promise<DebugToolsFeatureFlagOverrideDto[]> {
    return this.debugToolsService.getActiveOverridesForTenant(tenantId);
  }

  @AdminResponseContract(debugToolsGetFeatureFlagValueResponseContract)
  @Get('feature-overrides/value')
  async getFeatureFlagValue(
    @Query('tenantId') tenantId: string,
    @Query('featureKey') featureKey: string,
    @Query('defaultValue') defaultValue: string,
  ): Promise<DebugToolsGetFeatureFlagValueResponseDto> {
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

    const value = await this.debugToolsService.getFeatureFlagValue(tenantId, featureKey, parsed);
    return { value };
  }

  @AdminResponseContract(debugToolsFeatureFlagOverrideContract)
  @Get('feature-overrides/:id')
  async getFeatureOverride(@Param('id') id: string): Promise<DebugToolsFeatureFlagOverrideDto> {
    return this.debugToolsService.getFeatureOverride(id);
  }

  @AdminResponseContract(debugToolsQueryOverridesResponseContract)
  @Get('feature-overrides')
  async queryOverrides(
    @Query('tenantId') tenantId?: string,
    @Query('featureKey') featureKey?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    // Fix: C6 -- JWT-based identity, client-supplied adminId kaldırıldı
    @Req() req?: Request,
  ): Promise<DebugToolsQueryOverridesResponseDto> {
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
