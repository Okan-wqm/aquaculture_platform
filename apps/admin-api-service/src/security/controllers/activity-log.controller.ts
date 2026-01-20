/**
 * Activity Log Controller
 *
 * Endpoints for activity logging, queries, and statistics.
 */

import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { IsOptional, IsNumber, IsString, IsIn, IsBoolean, Min, Max } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ActivityLoggingService, ActivityQueryOptions, ActivityStats } from '../services/activity-logging.service';
import { ActivityLog, ActivityCategory, ActivitySeverity } from '../entities/security.entity';

// ============================================================================
// DTOs
// ============================================================================

class QueryActivitiesDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsIn(['user_action', 'system_event', 'api_call', 'data_access', 'security_event', 'configuration', 'authentication'])
  category?: ActivityCategory;

  @IsOptional()
  @IsIn(['debug', 'info', 'warning', 'error', 'critical'])
  severity?: ActivitySeverity;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  ipAddress?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  success?: boolean;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsString()
  searchQuery?: string;

  @IsOptional()
  @IsString()
  tags?: string;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

class LogActivityDto {
  @IsIn(['user_action', 'system_event', 'api_call', 'data_access', 'security_event', 'configuration', 'authentication'])
  category: ActivityCategory;

  @IsString()
  action: string;

  @IsString()
  description: string;

  @IsOptional()
  @IsIn(['debug', 'info', 'warning', 'error', 'critical'])
  severity?: ActivitySeverity;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  tenantName?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  userName?: string;

  @IsOptional()
  @IsString()
  userEmail?: string;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  entityName?: string;

  @IsString()
  ipAddress: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsString()
  correlationId?: string;

  @IsOptional()
  previousValue?: Record<string, unknown>;

  @IsOptional()
  newValue?: Record<string, unknown>;

  @IsOptional()
  metadata?: Record<string, unknown>;

  @IsOptional()
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  success?: boolean;

  @IsOptional()
  @IsString()
  errorMessage?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  duration?: number;
}

class ActivityStatsQueryDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('security/activities')
export class ActivityLogController {
  constructor(private readonly activityService: ActivityLoggingService) {}

  /**
   * Query activity logs
   */
  @Get()
  async queryActivities(
    @Query() query: QueryActivitiesDto,
  ): Promise<{
    data: ActivityLog[];
    total: number;
    page: number;
    limit: number;
  }> {
    const options: ActivityQueryOptions = {
      page: query.page ? parseInt(String(query.page), 10) : 1,
      limit: query.limit ? parseInt(String(query.limit), 10) : 50,
      tenantId: query.tenantId,
      userId: query.userId,
      category: query.category,
      severity: query.severity,
      action: query.action,
      entityType: query.entityType,
      entityId: query.entityId,
      ipAddress: query.ipAddress,
      success: query.success !== undefined ? query.success === true || query.success === 'true' as unknown as boolean : undefined,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      searchQuery: query.searchQuery,
      tags: query.tags ? query.tags.split(',') : undefined,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    };

    return this.activityService.queryActivities(options);
  }

  /**
   * Get activity by ID
   */
  @Get(':id')
  async getActivity(@Param('id') id: string): Promise<ActivityLog | null> {
    return this.activityService.getActivityById(id);
  }

  /**
   * Get activities for entity
   */
  @Get('entity/:entityType/:entityId')
  async getActivitiesForEntity(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('limit') limit?: number,
  ): Promise<ActivityLog[]> {
    return this.activityService.getActivitiesForEntity(
      entityType,
      entityId,
      limit ? parseInt(String(limit), 10) : 50,
    );
  }

  /**
   * Log activity manually (for external services)
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async logActivity(@Body() dto: LogActivityDto): Promise<{ success: boolean }> {
    await this.activityService.logActivityImmediate(dto);
    return { success: true };
  }

  /**
   * Get activity statistics
   */
  @Get('stats/overview')
  async getActivityStats(
    @Query() query: ActivityStatsQueryDto,
  ): Promise<ActivityStats> {
    return this.activityService.getActivityStats({
      tenantId: query.tenantId,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
    });
  }

  /**
   * Get login attempts for IP
   */
  @Get('login-attempts/:ipAddress')
  async getLoginAttempts(
    @Param('ipAddress') ipAddress: string,
    @Query('minutes') minutes?: number,
  ) {
    return this.activityService.getRecentLoginAttempts(
      ipAddress,
      minutes ? parseInt(String(minutes), 10) : 15,
    );
  }

  /**
   * Get active sessions for user
   */
  @Get('sessions/user/:userId')
  async getUserSessions(@Param('userId') userId: string) {
    return this.activityService.getActiveSessionsForUser(userId);
  }

  /**
   * Terminate user sessions
   */
  @Post('sessions/user/:userId/terminate')
  @HttpCode(HttpStatus.OK)
  async terminateUserSessions(
    @Param('userId') userId: string,
    @Body() body: { reason: 'logout' | 'forced' | 'security'; terminatedBy?: string },
  ) {
    const count = await this.activityService.terminateAllUserSessions(
      userId,
      body.reason,
      body.terminatedBy,
    );
    return { terminated: count };
  }
}
