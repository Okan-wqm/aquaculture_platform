/**
 * Request bodies for `reports.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { IsIn, IsString, IsOptional, IsBoolean, IsObject, IsArray } from 'class-validator';
import {
  ReportType,
  ReportFormat,
  ReportDefinitionStatus,
  ReportSchedule,
} from '../../entities/analytics-snapshot.entity';

// ============================================================================
// DTOs
// ============================================================================

export class GenerateReportDto {
  @IsIn([
    'tenant_overview',
    'tenant_churn',
    'financial_revenue',
    'financial_payments',
    'usage_modules',
    'usage_features',
    'system_performance',
  ])
  type!: ReportType;

  @IsIn(['json', 'csv', 'pdf'])
  format!: ReportFormat;

  @IsString()
  startDate!: string;

  @IsString()
  endDate!: string;

  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  includeCharts?: boolean;
}

export class CreateDefinitionDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsIn([
    'tenant_overview',
    'tenant_churn',
    'financial_revenue',
    'financial_payments',
    'usage_modules',
    'usage_features',
    'system_performance',
  ])
  type!: ReportType;

  @IsOptional()
  @IsIn(['json', 'csv', 'pdf'])
  defaultFormat?: ReportFormat;

  @IsOptional()
  @IsIn(['manual', 'daily', 'weekly', 'monthly'])
  schedule?: ReportSchedule;

  @IsOptional()
  @IsObject()
  defaultFilters?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  recipients?: string[];

  @IsOptional()
  @IsBoolean()
  includeCharts?: boolean;
}

export class UpdateDefinitionDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['json', 'csv', 'pdf'])
  defaultFormat?: ReportFormat;

  @IsOptional()
  @IsIn(['active', 'inactive', 'draft'])
  status?: ReportDefinitionStatus;

  @IsOptional()
  @IsIn(['manual', 'daily', 'weekly', 'monthly'])
  schedule?: ReportSchedule;

  @IsOptional()
  @IsObject()
  defaultFilters?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  recipients?: string[];

  @IsOptional()
  @IsBoolean()
  includeCharts?: boolean;
}

export class ExecuteReportDto {
  @IsOptional()
  @IsString()
  reportId?: string;

  @IsOptional()
  @IsString()
  definitionId?: string;

  @IsOptional()
  @IsIn([
    'tenant_overview',
    'tenant_churn',
    'financial_revenue',
    'financial_payments',
    'usage_modules',
    'usage_features',
    'system_performance',
  ])
  reportType?: ReportType;

  @IsOptional()
  @IsString()
  reportName?: string;

  @IsIn(['json', 'csv', 'pdf'])
  format!: ReportFormat;

  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;
}

export class QuickReportDto {
  @IsIn(['json', 'csv', 'pdf'])
  format!: ReportFormat;

  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;
}
