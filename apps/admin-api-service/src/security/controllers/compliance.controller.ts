/**
 * Compliance Controller
 *
 * Endpoints for data subject requests, compliance reports, and GDPR management.
 */

import { RequiresCapability, TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import {
  Controller,
  Get,
  Post,
  Put,
  Query,
  Param,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { Type } from 'class-transformer';
import { IsString, IsOptional, IsBoolean, IsArray, IsNumber, IsIn } from 'class-validator';
import { getAuthUserId, getAuthUser } from '../../shared/authenticated-request';

import {
  DataRequest,
  DataRequestType,
  DataRequestStatus,
  ComplianceReport,
  ComplianceType,
} from '../entities/security.entity';
import {
  ComplianceService,
  DataRequestCreateParams,
  ComplianceCheckResult,
  DataInventory,
} from '../services/compliance.service';

// ============================================================================
// DTOs
// ============================================================================

class CreateDataRequestDto {
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

class UpdateDataRequestDto {
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

class VerifyIdentityDto {
  // Fix: C6 -- verifiedBy removed from client input; set from JWT
  @IsString()
  verificationMethod!: string;
}

class CompleteDataRequestDto {
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

class QueryDataRequestsDto {
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

class GenerateReportDto {
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

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Security')
@Controller('security/compliance')
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  // ============================================================================
  // Data Subject Requests
  // ============================================================================

  /**
   * Create data subject request
   * Fix: C6 -- JWT-based identity
   */
  @AuditedOperation({ resource: 'DataRequest', action: 'CREATE' })
  @RequiresCapability('security-ops')
  @Post('data-requests')
  @HttpCode(HttpStatus.CREATED)
  async createDataRequest(
    @TenantParam('body') tenantId: string,
    @Body() dto: CreateDataRequestDto,
    @Req() req: Request,
  ): Promise<DataRequest> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.complianceService.createDataRequest({ ...dto, tenantId, requesterId: userId });
  }

  /**
   * Get data request by ID
   */
  @Get('data-requests/:id')
  async getDataRequest(@Param('id') id: string): Promise<DataRequest> {
    return this.complianceService.getDataRequest(id);
  }

  /**
   * Query data requests
   */
  @Get('data-requests')
  async queryDataRequests(
    @Query() query: QueryDataRequestsDto,
  ): Promise<{
    data: DataRequest[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.complianceService.getDataRequests({
      page: query.page ? parseInt(String(query.page), 10) : 1,
      limit: query.limit ? parseInt(String(query.limit), 10) : 20,
      tenantId: query.tenantId,
      requestType: query.requestType,
      status: query.status,
      complianceFramework: query.complianceFramework,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      overdue: query.overdue === true || String(query.overdue) === 'true',
    });
  }

  /**
   * Update data request
   * Fix: C6 -- JWT-based identity (was hardcoded 'admin')
   */
  @AuditedOperation({ resource: 'DataRequest', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put('data-requests/:id')
  async updateDataRequest(
    @Param('id') id: string,
    @Body() dto: UpdateDataRequestDto,
    @Req() req: Request,
  ): Promise<DataRequest> {
    const userPayload = getAuthUser(req);
    const userId = userPayload?.id;
    if (!userId) throw new UnauthorizedException('User not authenticated');
    const userName = userPayload?.name || userPayload?.email || userId;
    return this.complianceService.updateDataRequest(
      id,
      dto,
      userId,
      userName,
    );
  }

  /**
   * Verify requester identity
   * Fix: C6 -- JWT-based identity
   */
  @AuditedOperation({ resource: 'Identity', action: 'VERIFY' })
  @RequiresCapability('security-ops')
  @Post('data-requests/:id/verify')
  @HttpCode(HttpStatus.OK)
  async verifyIdentity(
    @Param('id') id: string,
    @Body() dto: VerifyIdentityDto,
    @Req() req: Request,
  ): Promise<DataRequest> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.complianceService.verifyIdentity(
      id,
      userId,
      dto.verificationMethod,
    );
  }

  /**
   * Complete data request
   * Fix: C6 -- JWT-based identity
   */
  @AuditedOperation({ resource: 'DataRequest', action: 'COMPLETE' })
  @RequiresCapability('security-ops')
  @Post('data-requests/:id/complete')
  @HttpCode(HttpStatus.OK)
  async completeDataRequest(
    @Param('id') id: string,
    @Body() dto: CompleteDataRequestDto,
    @Req() req: Request,
  ): Promise<DataRequest> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.complianceService.completeDataRequest(id, {
      ...dto,
      completedBy: userId,
      downloadExpiresAt: dto.downloadExpiresAt
        ? new Date(dto.downloadExpiresAt)
        : undefined,
    });
  }

  /**
   * Record download of data request
   */
  @AuditedOperation({ resource: 'Download', action: 'RECORD' })
  @RequiresCapability('security-ops')
  @Post('data-requests/:id/download')
  @HttpCode(HttpStatus.OK)
  async recordDownload(@Param('id') id: string): Promise<{ success: boolean }> {
    await this.complianceService.recordDownload(id);
    return { success: true };
  }

  /**
   * Get overdue requests
   */
  @Get('data-requests/status/overdue')
  async getOverdueRequests(): Promise<DataRequest[]> {
    return this.complianceService.getOverdueRequests();
  }

  /**
   * Get data request statistics
   */
  @Get('data-requests/stats')
  async getDataRequestStats(
    @TenantParam('query', { optional: true }) tenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.complianceService.getDataRequestStats({
      tenantId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });
  }

  // ============================================================================
  // Compliance Reports
  // ============================================================================

  /**
   * Generate compliance report
   * Fix: C6 -- JWT-based identity
   */
  @AuditedOperation({ resource: 'Report', action: 'GENERATE' })
  @RequiresCapability('security-ops')
  @Post('reports')
  @HttpCode(HttpStatus.CREATED)
  async generateReport(
    @Body() dto: GenerateReportDto,
    @Req() req: Request,
  ): Promise<ComplianceReport> {
    const userPayload = getAuthUser(req);
    const userId = userPayload?.id;
    if (!userId) throw new UnauthorizedException('User not authenticated');
    const userName = userPayload?.name || userPayload?.email || userId;
    return this.complianceService.generateComplianceReport({
      complianceType: dto.complianceType,
      reportPeriodStart: new Date(dto.reportPeriodStart),
      reportPeriodEnd: new Date(dto.reportPeriodEnd),
      includedTenants: dto.includedTenants,
      generatedBy: userId,
      generatedByName: userName,
    });
  }

  /**
   * Get compliance report by ID
   */
  @Get('reports/:id')
  async getReport(@Param('id') id: string): Promise<ComplianceReport> {
    return this.complianceService.getComplianceReport(id);
  }

  /**
   * Query compliance reports
   */
  @Get('reports')
  async queryReports(
    @Query() query: QueryReportsDto,
  ): Promise<{
    data: ComplianceReport[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.complianceService.getComplianceReports({
      page: query.page ? parseInt(String(query.page), 10) : 1,
      limit: query.limit ? parseInt(String(query.limit), 10) : 20,
      complianceType: query.complianceType,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
    });
  }

  // ============================================================================
  // Compliance Checks
  // ============================================================================

  /**
   * Run compliance checks
   */
  @Get('checks/:framework')
  async runComplianceChecks(
    @Param('framework') framework: ComplianceType,
  ): Promise<ComplianceCheckResult[]> {
    return this.complianceService.runComplianceChecks(framework);
  }

  /**
   * Get compliance requirements
   */
  @Get('requirements/:framework')
  getRequirements(@Param('framework') framework: ComplianceType) {
    return this.complianceService.getRequirements(framework);
  }

  // ============================================================================
  // Data Inventory
  // ============================================================================

  /**
   * Get data inventory (processing activities)
   */
  @Get('data-inventory')
  getDataInventory(): DataInventory[] {
    return this.complianceService.getDataInventory();
  }
}
