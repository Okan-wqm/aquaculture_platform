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
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import {
  ReportType,
  ReportFormat,
  ReportRequest,
  ReportDefinition,
  ReportExecution,
  ReportDefinitionStatus,
  ReportSchedule,
  ReportExecutionStatus,
} from '../entities/analytics-snapshot.entity';
import { ReportsService } from '../services/reports.service';

// ============================================================================
// DTOs
// ============================================================================

class GenerateReportDto {
  type!: ReportType;
  format!: ReportFormat;
  startDate!: string;
  endDate!: string;
  filters?: Record<string, unknown>;
  includeCharts?: boolean;
}

class CreateDefinitionDto {
  name!: string;
  description?: string;
  type!: ReportType;
  defaultFormat?: ReportFormat;
  schedule?: ReportSchedule;
  defaultFilters?: Record<string, unknown>;
  recipients?: string[];
  includeCharts?: boolean;
}

class UpdateDefinitionDto {
  name?: string;
  description?: string;
  defaultFormat?: ReportFormat;
  status?: ReportDefinitionStatus;
  schedule?: ReportSchedule;
  defaultFilters?: Record<string, unknown>;
  recipients?: string[];
  includeCharts?: boolean;
}

class ExecuteReportDto {
  reportId?: string;
  format!: ReportFormat;
  filters?: Record<string, unknown>;
  startDate?: string;
  endDate?: string;
}

class QuickReportDto {
  format!: ReportFormat;
  filters?: Record<string, unknown>;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Analytics')
@Controller('reports')
@UseGuards(PlatformAdminGuard)
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
  ): Promise<{ data: ReportDefinition[]; total: number; page: number; limit: number }> {
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
  ): Promise<{ data: ReportExecution[]; total: number; page: number; limit: number }> {
    return this.reportsService.getExecutions({
      definitionId,
      status,
      reportType,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('executions/:id')
  async getExecution(@Param('id') id: string): Promise<ReportExecution> {
    return this.reportsService.getExecution(id);
  }

  @Get('executions/:id/download')
  async downloadExecution(@Param('id') id: string, @Res() res: Response) {
    const download = await this.reportsService.getExecutionDownload(id);

    res.setHeader('Content-Type', download.contentType);
    // H-1 fix: sanitize filename to prevent Content-Disposition header injection
    const safeFilename = this.sanitizeFilename(download.filename);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

    if (download.execution.format === 'json') {
      res.send(JSON.stringify(download.data, null, 2));
    } else if (download.execution.format === 'pdf') {
      const pdfBuffer = await this.reportsService.generatePdfBuffer(
        download.execution.reportType,
        download.data,
      );
      res.send(pdfBuffer);
    } else {
      res.send(download.data);
    }
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
  getAvailableReports() {
    return this.reportsService.getAvailableReports();
  }

  // ============================================================================
  // Report Generation
  // ============================================================================

  @Post('generate')
  async generateReport(@Body() dto: GenerateReportDto) {
    // Validate dates
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid date format');
    }

    if (startDate > endDate) {
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

  @Get('tenant-overview')
  async getTenantOverviewReport(
    @Query('format') format: ReportFormat = 'json',
  ) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 1);

    return this.reportsService.generateReport({
      type: 'tenant_overview',
      format,
      startDate,
      endDate,
    });
  }

  @Get('churn-analysis')
  async getChurnAnalysisReport(
    @Query('format') format: ReportFormat = 'json',
    @Query('months') months = 3,
  ) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

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
  ) {
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
  ) {
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
  ) {
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
  ) {
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
  ) {
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
  ) {
    // MED-007 fix: validate reportType against the known enum at runtime
    // (TypeScript types are erased at runtime — an invalid value would reach generateReport()
    // and the Content-Disposition header if the switch default did not throw).
    const allowedReportTypes: readonly string[] = [
      'tenant_overview', 'tenant_churn', 'financial_revenue',
      'financial_payments', 'usage_modules', 'usage_features', 'system_performance',
    ];
    if (!allowedReportTypes.includes(reportType as string)) {
      throw new BadRequestException(`Invalid report type: "${reportType}"`);
    }

    // MED-007 fix: validate format parameter
    const allowedFormats: readonly string[] = ['pdf', 'csv'];
    if (!allowedFormats.includes(format as string)) {
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
  ) {
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
  ) {
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
