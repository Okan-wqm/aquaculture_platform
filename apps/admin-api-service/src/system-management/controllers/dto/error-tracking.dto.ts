/**
 * Request bodies for `error-tracking.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { Transform, Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsObject,
  IsArray,
  IsNumber,
  IsBoolean,
  IsIn,
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';
import { ErrorSeverity, ErrorStatus, ErrorContext } from '../../entities/error-tracking.entity';
import { ERROR_GROUP_SORT_FIELDS, ErrorGroupSortField } from '../../sorting/error-group-sort';

// ============================================================================
// DTOs
// ============================================================================

export class QueryErrorGroupsDto {
  @IsOptional()
  @IsString()
  status?: ErrorStatus;

  @IsOptional()
  @IsString()
  severity?: ErrorSeverity;

  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  assignedTo?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isRegression?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsIn(ERROR_GROUP_SORT_FIELDS)
  sortBy?: ErrorGroupSortField;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

export class ReportErrorDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  errorType?: string;

  @IsOptional()
  @IsString()
  stackTrace?: string;

  @IsOptional()
  @IsString()
  severity?: ErrorSeverity;

  @IsOptional()
  @IsObject()
  context?: ErrorContext;

  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsString()
  environment?: string;

  @IsOptional()
  @IsString()
  release?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  ipAddress?: string;

  @IsOptional()
  @IsString()
  userAgent?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateErrorGroupDto {
  @IsOptional()
  @IsString()
  status?: ErrorStatus;

  @IsOptional()
  @IsString()
  assignedTo?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  linkedTicketUrl?: string;
}

export class ResolveErrorGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class AssignErrorGroupDto {
  @IsString()
  @MaxLength(255)
  assigneeId!: string;
}

export class MergeErrorGroupsDto {
  @IsString()
  targetId!: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  sourceIds!: string[];
}

export class UpdateErrorAlertRuleDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsObject()
  conditions?: {
    severity?: ErrorSeverity[];
    service?: string[];
    errorType?: string[];
    messagePattern?: string;
    occurrenceThreshold?: number;
    timeWindowMinutes?: number;
    userCountThreshold?: number;
  };

  @IsOptional()
  @IsArray()
  actions?: Array<{
    type: 'email' | 'slack' | 'pagerduty' | 'webhook' | 'sms';
    config: Record<string, unknown>;
  }>;

  @IsOptional()
  @IsNumber()
  cooldownMinutes?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateAlertRuleDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsObject()
  conditions!: {
    severity?: ErrorSeverity[];
    service?: string[];
    errorType?: string[];
    messagePattern?: string;
    occurrenceThreshold?: number;
    timeWindowMinutes?: number;
    userCountThreshold?: number;
  };

  @IsArray()
  actions!: Array<{
    type: 'email' | 'slack' | 'pagerduty' | 'webhook' | 'sms';
    config: Record<string, unknown>;
  }>;

  @IsOptional()
  @IsNumber()
  cooldownMinutes?: number;
}
