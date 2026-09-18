/**
 * Request bodies for `compliance.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { Type } from 'class-transformer';
import { IsString, IsOptional, IsBoolean, IsArray, IsNumber, IsIn } from 'class-validator';
import { DataRequestType, DataRequestStatus, ComplianceType } from '../../entities/security.entity';

// ============================================================================
// DTOs
// ============================================================================

export class CreateDataRequestDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  requestType!: DataRequestType;

  @IsString()
  complianceFramework!: ComplianceType;

  @IsString()
  tenantName!: string;

  // Fix: C6 -- requesterId removed from client input; set from JWT
  @IsString()
  requesterName!: string;

  @IsString()
  requesterEmail!: string;

  @IsString()
  description!: string;

  @IsOptional()
  @IsArray()
  dataCategories?: string[];

  @IsOptional()
  @IsString()
  specificData?: string;
}

export class UpdateDataRequestDto {
  @IsOptional()
  @IsString()
  status?: DataRequestStatus;

  @IsOptional()
  @IsString()
  assignedTo?: string;

  @IsOptional()
  @IsString()
  assignedToName?: string;

  @IsOptional()
  @IsString()
  completionNotes?: string;

  @IsOptional()
  @IsString()
  rejectionReason?: string;
}

export class VerifyIdentityDto {
  // Fix: C6 -- verifiedBy removed from client input; set from JWT
  @IsString()
  verificationMethod!: string;
}

export class CompleteDataRequestDto {
  // Fix: C6 -- completedBy removed from client input; set from JWT
  @IsString()
  completionNotes!: string;

  @IsOptional()
  @IsIn(['json', 'csv', 'pdf', 'xml'])
  deliveryFormat?: 'json' | 'csv' | 'pdf' | 'xml';

  @IsOptional()
  @IsString()
  downloadUrl?: string;

  @IsOptional()
  @IsString()
  downloadExpiresAt?: string;
}

export class QueryDataRequestsDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  requestType?: DataRequestType;

  @IsOptional()
  @IsString()
  status?: DataRequestStatus;

  @IsOptional()
  @IsString()
  complianceFramework?: ComplianceType;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  overdue?: boolean;
}

export class GenerateReportDto {
  @IsString()
  complianceType!: ComplianceType;

  @IsString()
  reportPeriodStart!: string;

  @IsString()
  reportPeriodEnd!: string;

  @IsOptional()
  @IsArray()
  includedTenants?: string[];
  // Fix: C6 -- generatedBy/generatedByName removed from client input; set from JWT
}

// WHY @Type on page/limit: query params arrive as strings ("?limit=50"); without
// class-transformer coercion the global ValidationPipe runs @IsNumber against the
// string and 400s every paginated request (ORPHAN-MEDIUM-148). QueryDataRequestsDto
// above carried the identical defect and is fixed the same way. Exported so the DTO
// coercion is unit-testable (compliance-query-reports.dto.spec.ts).
export class QueryReportsDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsString()
  complianceType?: ComplianceType;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;
}
