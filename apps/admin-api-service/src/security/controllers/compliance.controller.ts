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
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ComplianceService,
  DataRequestCreateParams,
  ComplianceCheckResult,
  DataInventory,
} from '../services/compliance.service';
import {
  DataRequest,
  DataRequestType,
  DataRequestStatus,
  ComplianceReport,
  ComplianceType,
} from '../entities/security.entity';

// ============================================================================
// DTOs
// ============================================================================

class CreateDataRequestDto {
  requestType: DataRequestType;
  complianceFramework: ComplianceType;
  tenantId: string;
  tenantName: string;
  requesterId?: string;
  requesterName: string;
  requesterEmail: string;
  description: string;
  dataCategories?: string[];
  specificData?: string;
}

class UpdateDataRequestDto {
  status?: DataRequestStatus;
  assignedTo?: string;
  assignedToName?: string;
  completionNotes?: string;
  rejectionReason?: string;
}

class VerifyIdentityDto {
  verifiedBy: string;
  verificationMethod: string;
}

class CompleteDataRequestDto {
  completedBy: string;
  completionNotes: string;
  deliveryFormat?: 'json' | 'csv' | 'pdf' | 'xml';
  downloadUrl?: string;
  downloadExpiresAt?: string;
}

class QueryDataRequestsDto {
  page?: number;
  limit?: number;
  tenantId?: string;
  requestType?: DataRequestType;
  status?: DataRequestStatus;
  complianceFramework?: ComplianceType;
  startDate?: string;
  endDate?: string;
  overdue?: boolean;
}

class GenerateReportDto {
  complianceType: ComplianceType;
  reportPeriodStart: string;
  reportPeriodEnd: string;
  includedTenants?: string[];
  generatedBy: string;
  generatedByName: string;
}

class QueryReportsDto {
  page?: number;
  limit?: number;
  complianceType?: ComplianceType;
  startDate?: string;
  endDate?: string;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('security/compliance')
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  // ============================================================================
  // Data Subject Requests
  // ============================================================================

  /**
   * Create data subject request
   */
  @Post('data-requests')
  @HttpCode(HttpStatus.CREATED)
  async createDataRequest(
    @Body() dto: CreateDataRequestDto,
  ): Promise<DataRequest> {
    return this.complianceService.createDataRequest(dto);
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
      overdue: query.overdue === true || query.overdue === 'true' as unknown as boolean,
    });
  }

  /**
   * Update data request
   */
  @Put('data-requests/:id')
  async updateDataRequest(
    @Param('id') id: string,
    @Body() dto: UpdateDataRequestDto,
  ): Promise<DataRequest> {
    return this.complianceService.updateDataRequest(
      id,
      dto,
      'admin', // Would come from auth context
      'Admin User',
    );
  }

  /**
   * Verify requester identity
   */
  @Post('data-requests/:id/verify')
  @HttpCode(HttpStatus.OK)
  async verifyIdentity(
    @Param('id') id: string,
    @Body() dto: VerifyIdentityDto,
  ): Promise<DataRequest> {
    return this.complianceService.verifyIdentity(
      id,
      dto.verifiedBy,
      dto.verificationMethod,
    );
  }

  /**
   * Complete data request
   */
  @Post('data-requests/:id/complete')
  @HttpCode(HttpStatus.OK)
  async completeDataRequest(
    @Param('id') id: string,
    @Body() dto: CompleteDataRequestDto,
  ): Promise<DataRequest> {
    return this.complianceService.completeDataRequest(id, {
      ...dto,
      downloadExpiresAt: dto.downloadExpiresAt
        ? new Date(dto.downloadExpiresAt)
        : undefined,
    });
  }

  /**
   * Record download of data request
   */
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
    @Query('tenantId') tenantId?: string,
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
   */
  @Post('reports')
  @HttpCode(HttpStatus.CREATED)
  async generateReport(
    @Body() dto: GenerateReportDto,
  ): Promise<ComplianceReport> {
    return this.complianceService.generateComplianceReport({
      complianceType: dto.complianceType,
      reportPeriodStart: new Date(dto.reportPeriodStart),
      reportPeriodEnd: new Date(dto.reportPeriodEnd),
      includedTenants: dto.includedTenants,
      generatedBy: dto.generatedBy,
      generatedByName: dto.generatedByName,
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
