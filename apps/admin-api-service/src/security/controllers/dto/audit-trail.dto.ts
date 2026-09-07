/**
 * Request bodies for `audit-trail.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { Type, Transform } from 'class-transformer';
import {
  IsOptional,
  IsNumber,
  IsString,
  IsBoolean,
  IsIn,
  IsArray,
  IsObject,
  Min,
  Max,
} from 'class-validator';
import { ActivityCategory, ActivitySeverity } from '../../entities/security.entity';
import { ACTIVITY_LOG_SORT_FIELDS, ActivityLogSortField } from '../../sorting/activity-log-sort';

// ============================================================================
// DTOs
// ============================================================================

export class QueryAuditTrailDto {
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
  @IsString()
  performedBy?: string;

  @IsOptional()
  @IsString()
  userEmail?: string;

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
  @IsString()
  severity?: string; // Comma-separated

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  actions?: string; // Comma-separated

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
  search?: string;

  @IsOptional()
  @IsString()
  searchQuery?: string;

  @IsOptional()
  @IsString()
  tags?: string; // Comma-separated

  @IsOptional()
  @IsIn(ACTIVITY_LOG_SORT_FIELDS)
  sortBy?: ActivityLogSortField;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

export class ExportAuditTrailDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsIn(['csv', 'json', 'pdf'])
  format!: 'csv' | 'json' | 'pdf';

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  category?: ActivityCategory;

  @IsString()
  startDate!: string;

  @IsString()
  endDate!: string;

  @IsOptional()
  @IsBoolean()
  includeMetadata?: boolean;

  @IsOptional()
  @IsBoolean()
  includeChanges?: boolean;
}

export class CreateAlertRuleDto {
  @IsString()
  name!: string;

  @IsString()
  description!: string;

  @IsBoolean()
  isActive!: boolean;

  @IsObject()
  conditions!: {
    category?: ActivityCategory[];
    severity?: ActivitySeverity[];
    actions?: string[];
    entityTypes?: string[];
    successOnly?: boolean;
    failureOnly?: boolean;
    ipPatterns?: string[];
  };

  @IsArray()
  alertChannels!: ('email' | 'webhook' | 'slack' | 'sms')[];

  @IsArray()
  recipients!: string[];

  @IsNumber()
  cooldownMinutes!: number;
}

export class UpdateAuditAlertRuleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  conditions?: {
    category?: ActivityCategory[];
    severity?: ActivitySeverity[];
    actions?: string[];
    entityTypes?: string[];
    successOnly?: boolean;
    failureOnly?: boolean;
    ipPatterns?: string[];
  };

  @IsOptional()
  @IsArray()
  alertChannels?: ('email' | 'webhook' | 'slack' | 'sms')[];

  @IsOptional()
  @IsArray()
  recipients?: string[];

  @IsOptional()
  @IsNumber()
  cooldownMinutes?: number;
}
