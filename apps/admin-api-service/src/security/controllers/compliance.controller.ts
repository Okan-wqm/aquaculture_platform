/**
 * Compliance Controller
 *
 * Endpoints for data subject requests, compliance reports, and GDPR management.
 */

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
  DataRequestType,
  DataRequestStatus,
  ComplianceType,
} from '../contracts/security-vocabulary';
import {
  ComplianceReportDto,
  ComplianceCheckResultDto,
  ComplianceRequirementDto,
  DataInventoryDto,
  DataRequestDto,
  DataRequestStatsDto,
  OperationSuccessDto,
  toComplianceReportDto,
  toDataRequestDto,
} from '../dto/security-response.dto';
import { ComplianceService, DataRequestCreateParams } from '../services/compliance.service';
import {
  createStandardPaginatedResult,
  IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  complianceDataRequestDtoContract,
  type ComplianceDataRequestDtoDto,
  complianceDataRequestDtoPageContract,
  complianceRecordDownloadResponseContract,
  type ComplianceRecordDownloadResponseDto,
  complianceDataRequestDtoArrayContract,
  complianceDataRequestStatsDtoContract,
  type ComplianceDataRequestStatsDtoDto,
  complianceComplianceReportDtoContract,
  type ComplianceComplianceReportDtoDto,
  complianceComplianceReportDtoPageContract,
  complianceComplianceCheckResultDtoArrayContract,
  type ComplianceComplianceCheckResultDtoDto,
  complianceComplianceRequirementDtoArrayContract,
  type ComplianceComplianceRequirementDtoDto,
  complianceDataInventoryDtoArrayContract,
  type ComplianceDataInventoryDtoDto,
} from '../contracts/admin-http-response.contract';

// ============================================================================
// DTOs
// ============================================================================

class CreateDataRequestDto {
  @IsString()
  requestType!: DataRequestType;

  @IsString()
  complianceFramework!: ComplianceType;

  @IsString()
  tenantId!: string;

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
  @AdminResponseContract(complianceDataRequestDtoContract)
  @Post('data-requests')
  @HttpCode(HttpStatus.CREATED)
  async createDataRequest(
    @Body() dto: CreateDataRequestDto,
    @Req() req: Request,
  ): Promise<ComplianceDataRequestDtoDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return toDataRequestDto(
      await this.complianceService.createDataRequest({
        ...dto,
        requesterId: userId,
      }),
    );
  }

  /**
   * Get data request statistics. Static route registration must precede the
   * parameter route below; the generated matcher proof enforces this order.
   */
  @AdminResponseContract(complianceDataRequestStatsDtoContract)
  @Get('data-requests/stats')
  async getDataRequestStats(
    @Query('tenantId') tenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<ComplianceDataRequestStatsDtoDto> {
    return this.complianceService.getDataRequestStats({
      tenantId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });
  }

  /**
   * Get data request by ID
   */
  @AdminResponseContract(complianceDataRequestDtoContract)
  @Get('data-requests/:id')
  async getDataRequest(@Param('id') id: string): Promise<ComplianceDataRequestDtoDto> {
    return toDataRequestDto(await this.complianceService.getDataRequest(id));
  }

  /**
   * Query data requests
   */
  @AdminResponseContract(complianceDataRequestDtoPageContract)
  @Get('data-requests')
  async queryDataRequests(
    @Query() query: QueryDataRequestsDto,
  ): Promise<IStandardPaginatedResult<ComplianceDataRequestDtoDto>> {
    const result = await this.complianceService.getDataRequests({
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
    return createStandardPaginatedResult(
      result.items.map(toDataRequestDto),
      result.total,
      result.page,
      result.limit,
    );
  }

  /**
   * Update data request
   * Fix: C6 -- JWT-based identity (was hardcoded 'admin')
   */
  @AdminResponseContract(complianceDataRequestDtoContract)
  @Put('data-requests/:id')
  async updateDataRequest(
    @Param('id') id: string,
    @Body() dto: UpdateDataRequestDto,
    @Req() req: Request,
  ): Promise<ComplianceDataRequestDtoDto> {
    const userPayload = getAuthUser(req);
    const userId = userPayload?.id;
    if (!userId) throw new UnauthorizedException('User not authenticated');
    const userName = userPayload?.name || userPayload?.email || userId;
    return toDataRequestDto(
      await this.complianceService.updateDataRequest(id, dto, userId, userName),
    );
  }

  /**
   * Verify requester identity
   * Fix: C6 -- JWT-based identity
   */
  @AdminResponseContract(complianceDataRequestDtoContract)
  @Post('data-requests/:id/verify')
  @HttpCode(HttpStatus.OK)
  async verifyIdentity(
    @Param('id') id: string,
    @Body() dto: VerifyIdentityDto,
    @Req() req: Request,
  ): Promise<ComplianceDataRequestDtoDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return toDataRequestDto(
      await this.complianceService.verifyIdentity(id, userId, dto.verificationMethod),
    );
  }

  /**
   * Complete data request
   * Fix: C6 -- JWT-based identity
   */
  @AdminResponseContract(complianceDataRequestDtoContract)
  @Post('data-requests/:id/complete')
  @HttpCode(HttpStatus.OK)
  async completeDataRequest(
    @Param('id') id: string,
    @Body() dto: CompleteDataRequestDto,
    @Req() req: Request,
  ): Promise<ComplianceDataRequestDtoDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return toDataRequestDto(
      await this.complianceService.completeDataRequest(id, {
        ...dto,
        completedBy: userId,
        downloadExpiresAt: dto.downloadExpiresAt ? new Date(dto.downloadExpiresAt) : undefined,
      }),
    );
  }

  /**
   * Record download of data request
   */
  @AdminResponseContract(complianceRecordDownloadResponseContract)
  @Post('data-requests/:id/download')
  @HttpCode(HttpStatus.OK)
  async recordDownload(@Param('id') id: string): Promise<ComplianceRecordDownloadResponseDto> {
    await this.complianceService.recordDownload(id);
    return { success: true };
  }

  /**
   * Get overdue requests
   */
  @AdminResponseContract(complianceDataRequestDtoArrayContract)
  @Get('data-requests/status/overdue')
  async getOverdueRequests(): Promise<ComplianceDataRequestDtoDto[]> {
    return (await this.complianceService.getOverdueRequests()).map(toDataRequestDto);
  }

  // ============================================================================
  // Compliance Reports
  // ============================================================================

  /**
   * Generate compliance report
   * Fix: C6 -- JWT-based identity
   */
  @AdminResponseContract(complianceComplianceReportDtoContract)
  @Post('reports')
  @HttpCode(HttpStatus.CREATED)
  async generateReport(
    @Body() dto: GenerateReportDto,
    @Req() req: Request,
  ): Promise<ComplianceComplianceReportDtoDto> {
    const userPayload = getAuthUser(req);
    const userId = userPayload?.id;
    if (!userId) throw new UnauthorizedException('User not authenticated');
    const userName = userPayload?.name || userPayload?.email || userId;
    return toComplianceReportDto(
      await this.complianceService.generateComplianceReport({
        complianceType: dto.complianceType,
        reportPeriodStart: new Date(dto.reportPeriodStart),
        reportPeriodEnd: new Date(dto.reportPeriodEnd),
        includedTenants: dto.includedTenants,
        generatedBy: userId,
        generatedByName: userName,
      }),
    );
  }

  /**
   * Get compliance report by ID
   */
  @AdminResponseContract(complianceComplianceReportDtoContract)
  @Get('reports/:id')
  async getReport(@Param('id') id: string): Promise<ComplianceComplianceReportDtoDto> {
    return toComplianceReportDto(await this.complianceService.getComplianceReport(id));
  }

  /**
   * Query compliance reports
   */
  @AdminResponseContract(complianceComplianceReportDtoPageContract)
  @Get('reports')
  async queryReports(
    @Query() query: QueryReportsDto,
  ): Promise<IStandardPaginatedResult<ComplianceComplianceReportDtoDto>> {
    const result = await this.complianceService.getComplianceReports({
      page: query.page ? parseInt(String(query.page), 10) : 1,
      limit: query.limit ? parseInt(String(query.limit), 10) : 20,
      complianceType: query.complianceType,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
    });
    return createStandardPaginatedResult(
      result.items.map(toComplianceReportDto),
      result.total,
      result.page,
      result.limit,
    );
  }

  // ============================================================================
  // Compliance Checks
  // ============================================================================

  /**
   * Run compliance checks
   */
  @AdminResponseContract(complianceComplianceCheckResultDtoArrayContract)
  @Get('checks/:framework')
  async runComplianceChecks(
    @Param('framework') framework: ComplianceType,
  ): Promise<ComplianceComplianceCheckResultDtoDto[]> {
    return this.complianceService.runComplianceChecks(framework);
  }

  /**
   * Get compliance requirements
   */
  @AdminResponseContract(complianceComplianceRequirementDtoArrayContract)
  @Get('requirements/:framework')
  getRequirements(
    @Param('framework') framework: ComplianceType,
  ): ComplianceComplianceRequirementDtoDto[] {
    return this.complianceService.getRequirements(framework);
  }

  // ============================================================================
  // Data Inventory
  // ============================================================================

  /**
   * Get data inventory (processing activities)
   */
  @AdminResponseContract(complianceDataInventoryDtoArrayContract)
  @Get('data-inventory')
  getDataInventory(): ComplianceDataInventoryDtoDto[] {
    return this.complianceService.getDataInventory();
  }
}
