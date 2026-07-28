/**
 * Reports Controller
 *
 * Rapor oluşturma ve indirme endpoint'leri.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Res,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, IsOptional, IsBoolean, IsObject } from 'class-validator';
import { Request, Response } from 'express';

import {
  REPORT_RANGE_SEMANTICS,
  REPORT_TYPES,
  ReportType,
  ReportFormat,
  ReportRequest,
  ReportResult,
  ReportDefinition,
  ReportExecution,
  ReportDefinitionStatus,
  ReportExecutionStatus,
} from '../entities/analytics-snapshot.entity';
import { ReportsService } from '../services/reports.service';
import { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

// ============================================================================
// DTOs
// ============================================================================

class GenerateReportDto {
  @IsIn(REPORT_TYPES)
  type!: ReportType;

  @IsIn(['json', 'csv', 'pdf'])
  format!: ReportFormat;

  // Optional at the DTO, required-or-forbidden by report type at the boundary
  // (`assertWindowMatchesReportType`). A blanket `@IsString()` here would force
  // every caller to send a window even for a report that cannot apply one,
  // which is the shape that produced APA-140.
  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  includeCharts?: boolean;
}

class CreateDefinitionDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsIn(REPORT_TYPES)
  type!: ReportType;

  @IsOptional()
  @IsIn(['json', 'csv', 'pdf'])
  defaultFormat?: ReportFormat;

  @IsOptional()
  @IsObject()
  defaultFilters?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  includeCharts?: boolean;
}

class UpdateDefinitionDto {
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
  @IsObject()
  defaultFilters?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  includeCharts?: boolean;
}

class ExecuteReportDto {
  @IsOptional()
  @IsString()
  reportId?: string;

  @IsOptional()
  @IsString()
  definitionId?: string;

  @IsOptional()
  @IsIn(REPORT_TYPES)
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

class QuickReportDto {
  @IsIn(['json', 'csv', 'pdf'])
  format!: ReportFormat;

  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;
}

// ============================================================================
// Controller
// ============================================================================

/**
 * Rejects a window that the report cannot apply, and a missing one it needs.
 *
 * Silently discarding a supplied window is the defect itself (APA-140): the
 * caller believes it scoped the report and the answer says otherwise. Answering
 * 400 moves the disagreement to where the caller can see it. The rule is
 * derived from `REPORT_RANGE_SEMANTICS`, so it cannot disagree with what the
 * generator actually does.
 */
function assertWindowMatchesReportType(type: ReportType, hasWindow: boolean): void {
  const ranged = REPORT_RANGE_SEMANTICS[type] === 'ranged';
  if (ranged && !hasWindow) {
    throw new BadRequestException(
      `Report "${type}" covers a date range: startDate and endDate are required.`,
    );
  }
  if (!ranged && hasWindow) {
    throw new BadRequestException(
      `Report "${type}" describes the current state and covers no date range: ` +
        'startDate and endDate must be omitted.',
    );
  }
}

@ApiTags('Analytics')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  /** H-1 fix: Sanitize filenames to prevent Content-Disposition header injection */
  private sanitizeFilename(filename: string): string {
    // Strip path separators, control characters, quotes, and newlines
    return filename
      .replace(/[/\\:*?"<>|\r\n]/g, '_')
      .replace(/\.{2,}/g, '.')
      .slice(0, 255);
  }

  // ============================================================================
  // Report Definitions (Saved Reports)
  // ============================================================================

  @Get('definitions')
  async getDefinitions(
    @Query('status') status?: ReportDefinitionStatus,
    @Query('type') type?: ReportType,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<IStandardPaginatedResult<ReportDefinition>> {
    return this.reportsService.getDefinitions({
      status,
      type,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('definitions/:id')
  async getDefinition(@Param('id') id: string): Promise<ReportDefinition> {
    return this.reportsService.getDefinition(id);
  }

  @Post('definitions')
  @HttpCode(HttpStatus.CREATED)
  async createDefinition(@Body() dto: CreateDefinitionDto): Promise<ReportDefinition> {
    return this.reportsService.createDefinition(dto);
  }

  @Put('definitions/:id')
  async updateDefinition(
    @Param('id') id: string,
    @Body() dto: UpdateDefinitionDto,
  ): Promise<ReportDefinition> {
    return this.reportsService.updateDefinition(id, dto);
  }

  @Delete('definitions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDefinition(@Param('id') id: string): Promise<void> {
    return this.reportsService.deleteDefinition(id);
  }

  // ============================================================================
  // Report Executions (Execution History)
  // ============================================================================

  @Get('executions')
  async getExecutions(
    @Query('definitionId') definitionId?: string,
    @Query('status') status?: ReportExecutionStatus,
    @Query('reportType') reportType?: ReportType,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<IStandardPaginatedResult<ReportExecution>> {
    return this.reportsService.getExecutions({
      definitionId,
      status,
      reportType,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('executions')
  @HttpCode(HttpStatus.CREATED)
  async createExecution(
    @Body() dto: ExecuteReportDto,
    // Annotated with the two fields the handler actually reads rather than the
    // whole express Request. `@Req()` still injects the full object; narrowing
    // the TYPE is what makes the boundary rule below unit-testable without
    // fabricating a hundred-member Request that the handler never touches.
    @Req() req: { user?: { id?: string; email?: string } },
  ): Promise<ReportExecution> {
    const startDate = dto.startDate ? new Date(dto.startDate) : undefined;
    const endDate = dto.endDate ? new Date(dto.endDate) : undefined;

    if (dto.startDate && (!startDate || isNaN(startDate.getTime()))) {
      throw new BadRequestException('Invalid startDate format');
    }

    if (dto.endDate && (!endDate || isNaN(endDate.getTime()))) {
      throw new BadRequestException('Invalid endDate format');
    }

    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('Start date must be before end date');
    }

    // A definition-driven execution takes its type from the stored definition,
    // which this route cannot see; the service resolves it and the same rule
    // applies there. Only an ad-hoc execution names its type here.
    if (dto.reportType) {
      assertWindowMatchesReportType(dto.reportType, Boolean(dto.startDate || dto.endDate));
    }

    return this.reportsService.executeReport({
      definitionId: dto.definitionId ?? dto.reportId,
      reportType: dto.reportType,
      reportName: dto.reportName,
      format: dto.format,
      filters: dto.filters,
      startDate,
      endDate,
      executedBy: req.user?.id,
      executedByEmail: req.user?.email,
    });
  }

  @Get('executions/:id')
  async getExecution(@Param('id') id: string): Promise<ReportExecution> {
    return this.reportsService.getExecution(id);
  }

  @Get('executions/:id/download')
  async downloadExecution(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const download = await this.reportsService.getExecutionDownload(id);

    res.setHeader('Content-Type', download.contentType);
    // H-1 fix: sanitize filename to prevent Content-Disposition header injection
    const safeFilename = this.sanitizeFilename(download.filename);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

    res.send(download.data);
  }

  // ============================================================================
  // Quick Reports (Frontend Compatible)
  // ============================================================================

  @Post('quick/tenants')
  @HttpCode(HttpStatus.OK)
  async quickTenantsReport(@Body() dto: QuickReportDto): Promise<ReportExecution> {
    return this.reportsService.generateQuickTenantsReport(dto.format, dto.filters);
  }

  @Post('quick/users')
  @HttpCode(HttpStatus.OK)
  async quickUsersReport(@Body() dto: QuickReportDto): Promise<ReportExecution> {
    return this.reportsService.generateQuickUsersReport(dto.format, dto.filters);
  }

  @Post('quick/revenue')
  @HttpCode(HttpStatus.OK)
  async quickRevenueReport(@Body() dto: QuickReportDto): Promise<ReportExecution> {
    return this.reportsService.generateQuickRevenueReport(dto.format, dto.filters);
  }

  @Post('quick/audit')
  @HttpCode(HttpStatus.OK)
  async quickAuditReport(@Body() dto: QuickReportDto): Promise<ReportExecution> {
    return this.reportsService.generateQuickAuditReport(dto.format, dto.filters);
  }

  // ============================================================================
  // Report Types
  // ============================================================================

  @Get('types')
  getAvailableReports(): ReturnType<ReportsService['getAvailableReports']> {
    return this.reportsService.getAvailableReports();
  }

  // ============================================================================
  // Report Generation
  // ============================================================================

  @Post('generate')
  async generateReport(@Body() dto: GenerateReportDto): Promise<ReportResult> {
    assertWindowMatchesReportType(dto.type, Boolean(dto.startDate || dto.endDate));

    // Validate dates
    const startDate = dto.startDate ? new Date(dto.startDate) : undefined;
    const endDate = dto.endDate ? new Date(dto.endDate) : undefined;

    if (
      (startDate && isNaN(startDate.getTime())) ||
      (endDate && isNaN(endDate.getTime()))
    ) {
      throw new BadRequestException('Invalid date format');
    }

    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('Start date must be before end date');
    }

    const request: ReportRequest = {
      type: dto.type,
      format: dto.format,
      startDate,
      endDate,
      filters: dto.filters,
      includeCharts: dto.includeCharts,
    };

    return this.reportsService.generateReport(request);
  }

  // ============================================================================
  // Quick Reports
  // ============================================================================

  /**
   * No window is constructed: the tenant roster describes current state, so the
   * one-month range this route used to build was discarded by the generator
   * (APA-140).
   */
  @Get('tenant-overview')
  async getTenantOverviewReport(
    @Query('format') format: ReportFormat = 'json',
  ): Promise<ReportResult> {
    return this.reportsService.generateReport({
      type: 'tenant_overview',
      format,
    });
  }

  /**
   * The `months` query parameter is gone (APA-140). It computed a `startDate`
   * that `generateChurnReport` discarded, so narrowing or widening the window
   * returned byte-identical data — a knob that moved nothing. It is not
   * reinstated with the window plumbed through, because the churn report has no
   * measurable cancellation date to select by in the first place: it now
   * answers 422 "no data source" rather than exporting a last-write timestamp
   * as a churn date (APA-135).
   */
  @Get('churn-analysis')
  async getChurnAnalysisReport(
    @Query('format') format: ReportFormat = 'json',
  ): Promise<ReportResult> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 3);

    return this.reportsService.generateReport({
      type: 'tenant_churn',
      format,
      startDate,
      endDate,
    });
  }

  @Get('revenue')
  async getRevenueReport(
    @Query('format') format: ReportFormat = 'json',
    @Query('days') days = 30,
  ): Promise<ReportResult> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return this.reportsService.generateReport({
      type: 'financial_revenue',
      format,
      startDate,
      endDate,
    });
  }

  @Get('payments')
  async getPaymentsReport(
    @Query('format') format: ReportFormat = 'json',
  ): Promise<ReportResult> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 1);

    return this.reportsService.generateReport({
      type: 'financial_payments',
      format,
      startDate,
      endDate,
    });
  }

  @Get('module-usage')
  async getModuleUsageReport(
    @Query('format') format: ReportFormat = 'json',
  ): Promise<ReportResult> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 1);

    return this.reportsService.generateReport({
      type: 'usage_modules',
      format,
      startDate,
      endDate,
    });
  }

  @Get('feature-usage')
  async getFeatureUsageReport(
    @Query('format') format: ReportFormat = 'json',
  ): Promise<ReportResult> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 1);

    return this.reportsService.generateReport({
      type: 'usage_features',
      format,
      startDate,
      endDate,
    });
  }

  @Get('system-performance')
  async getSystemPerformanceReport(
    @Query('format') format: ReportFormat = 'json',
    @Query('days') days = 7,
  ): Promise<ReportResult> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return this.reportsService.generateReport({
      type: 'system_performance',
      format,
      startDate,
      endDate,
    });
  }

  // ============================================================================
  // Download
  // ============================================================================

  @Get('download/:reportType')
  async downloadReport(
    @Param('reportType') reportType: ReportType,
    @Query('format') format: 'pdf' | 'csv' = 'pdf',
    @Query('days') days = 30,
    @Res() res: Response,
  ): Promise<void> {
    // MED-007 fix: validate reportType against the known enum at runtime
    // (TypeScript types are erased at runtime — an invalid value would reach generateReport()
    // and the Content-Disposition header if the switch default did not throw).
    //
    // This route is keyed by report TYPE, never by a generated result id, which
    // is why the `/api/reports/download/rpt_…` link `generateReport` used to
    // advertise could never resolve here (APA-146). The set is the entity's
    // `REPORT_TYPES` SSoT rather than a fourth local copy of the literals.
    if (!REPORT_TYPES.includes(reportType)) {
      throw new BadRequestException(`Invalid report type: "${reportType}"`);
    }

    // MED-007 fix: validate format parameter
    const allowedFormats: ReadonlyArray<'pdf' | 'csv'> = ['pdf', 'csv'];
    if (!allowedFormats.includes(format)) {
      throw new BadRequestException(`Invalid format: "${format}". Must be "pdf" or "csv"`);
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Generate the report data
    const report = await this.reportsService.generateReport({
      type: reportType,
      format: 'json',
      startDate,
      endDate,
    });

    if (format === 'pdf') {
      const pdfBuffer = await this.reportsService.generatePdfBuffer(reportType, report.data);
      const filename = `${reportType}_report_${Date.now()}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${this.sanitizeFilename(filename)}"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
    } else {
      // CSV format
      const csvReport = await this.reportsService.generateReport({
        type: reportType,
        format: 'csv',
        startDate,
        endDate,
      });
      const filename = `${reportType}_report_${Date.now()}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${this.sanitizeFilename(filename)}"`);
      res.send(csvReport.data);
    }
  }

  @Get('export/pdf/:reportType')
  async exportPdf(
    @Param('reportType') reportType: ReportType,
    @Query('days') days = 30,
    @Res() res: Response,
  ): Promise<void> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const report = await this.reportsService.generateReport({
      type: reportType,
      format: 'json',
      startDate,
      endDate,
    });

    const pdfBuffer = await this.reportsService.generatePdfBuffer(reportType, report.data);
    const filename = `${reportType}_report_${Date.now()}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    // BUG-040 fix: quote the filename per RFC 6266 to handle special characters safely
    res.setHeader('Content-Disposition', `attachment; filename="${this.sanitizeFilename(filename)}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  }

  // ============================================================================
  // Export Data
  // ============================================================================

  @Get('export/csv')
  async exportCsv(
    @Query('type') type: string,
    @Res() res: Response,
  ): Promise<void> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 1);

    let reportType: ReportType;
    switch (type) {
      case 'tenants':
        reportType = 'tenant_overview';
        break;
      case 'users':
        reportType = 'usage_modules';
        break;
      case 'revenue':
        reportType = 'financial_revenue';
        break;
      case 'payments':
        reportType = 'financial_payments';
        break;
      default:
        throw new BadRequestException('Invalid export type');
    }

    const report = await this.reportsService.generateReport({
      type: reportType,
      format: 'csv',
      startDate,
      endDate,
    });

    res.setHeader('Content-Type', 'text/csv');
    const csvFilename = this.sanitizeFilename(`${type}_report_${Date.now()}.csv`);
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename}"`);
    res.send(report.data);
  }
}
