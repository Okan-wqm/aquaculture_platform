/**
 * Activity Log Controller
 *
 * Endpoints for activity logging, queries, and statistics.
 */

import {
  ActivityStatsQueryDto,
  QueryActivitiesDto,
} from './dto/activity-log.dto';
import { Destructive, RequiresCapability } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
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
import { ApiTags } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';

import { IsOptional, IsNumber, IsString, IsIn, IsBoolean, Min, Max } from 'class-validator';

import { CurrentUser, CurrentUserData } from '../../decorators/current-user.decorator';
import { ActivityLog, ActivityCategory, ActivitySeverity } from '../entities/security.entity';
import { ActivityLoggingService, ActivityQueryOptions, ActivityStats } from '../services/activity-logging.service';
import { ACTIVITY_LOG_SORT_FIELDS, ActivityLogSortField } from '../sorting/activity-log-sort';

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Security')
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
      success: query.success !== undefined ? query.success === true || String(query.success) === 'true' : undefined,
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
}
