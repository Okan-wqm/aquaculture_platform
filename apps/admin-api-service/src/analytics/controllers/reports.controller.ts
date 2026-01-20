/**
 * Reports Controller
 *
 * Rapor oluşturma ve indirme endpoint'leri.
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Res,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { ReportsService } from '../services/reports.service';
import { ReportType, ReportFormat, ReportRequest } from '../entities/analytics-snapshot.entity';

// ============================================================================
// DTOs
// ============================================================================

class GenerateReportDto {
  type: ReportType;
  format: ReportFormat;
  startDate: string;
  endDate: string;
  filters?: Record<string, unknown>;
  includeCharts?: boolean;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

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
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
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
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
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
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
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
    res.setHeader('Content-Disposition', `attachment; filename=${type}_report_${Date.now()}.csv`);
    res.send(report.data);
  }
}
