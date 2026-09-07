/**
 * Request bodies for `activity-log.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { Type, Transform } from 'class-transformer';
import { IsOptional, IsNumber, IsString, IsIn, IsBoolean, Min, Max } from 'class-validator';
import { ActivityCategory, ActivitySeverity } from '../../entities/security.entity';
import { ACTIVITY_LOG_SORT_FIELDS, ActivityLogSortField } from '../../sorting/activity-log-sort';

// ============================================================================
// DTOs
// ============================================================================

export class QueryActivitiesDto {
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
  @IsIn([
    'user_action',
    'system_event',
    'api_call',
    'data_access',
    'security_event',
    'configuration',
    'authentication',
  ])
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
  @IsIn(ACTIVITY_LOG_SORT_FIELDS)
  sortBy?: ActivityLogSortField;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

export class ActivityStatsQueryDto {
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
