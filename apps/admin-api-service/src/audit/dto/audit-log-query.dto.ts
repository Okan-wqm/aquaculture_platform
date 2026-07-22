import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';

import { PaginationQueryDto } from '../../shared/pagination-query.dto';
import { AuditAction, AuditSeverity } from '../audit.entity';

/**
 * Single query DTO for GET /audit-logs (APA-013, RC-3).
 *
 * The handler previously mixed named `@Query('action')`… params with a bare
 * `@Query() PaginationQueryDto`. Under the global ValidationPipe's
 * `forbidNonWhitelisted`, the bare DTO received the WHOLE query object and 400'd
 * on every filter key it did not declare — so every filtered audit-log request
 * failed. Extending `PaginationQueryDto` and declaring every filter key here
 * gives the handler ONE validated query source; the filters now bind.
 */
export class AuditLogQueryDto extends PaginationQueryDto {
  // Only real backend AuditAction values are accepted — an out-of-vocabulary
  // action (e.g. the FE's old lowercase 'create'/'delete') now 400s at the
  // boundary instead of silently matching zero rows (APA-224).
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  performedBy?: string;

  @IsOptional()
  @IsEnum(AuditSeverity)
  severity?: AuditSeverity;

  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @IsOptional()
  @IsISO8601()
  endDate?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
