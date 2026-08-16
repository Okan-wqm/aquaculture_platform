import { IsEnum, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../shared/pagination-query.dto';
import { AuditSeverity } from '../audit.entity';

/** Complete, validated query contract for GET /audit-logs. */
export class AuditLogQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  entityType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  entityId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  performedBy?: string;

  @IsOptional()
  @IsEnum(AuditSeverity)
  severity?: AuditSeverity;

  @IsOptional()
  @IsISO8601({ strict: true })
  startDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  search?: string;
}
