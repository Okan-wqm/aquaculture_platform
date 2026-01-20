import {
  Controller,
  Get,
  Post,
  Body,
  Query,
} from '@nestjs/common';

import { PerformanceMonitoringService, MetricThreshold } from '../services/performance-monitoring.service';
import { MetricType } from '../entities/performance-metric.entity';

// ============================================================================
// DTOs
// ============================================================================

class RecordMetricDto {
  metricType: MetricType;
  name: string;
  value: number;
  unit?: string;
  service?: string;
  dimensions?: Record<string, string | undefined>;
  percentiles?: { p50?: number; p90?: number; p95?: number; p99?: number };
  sampleCount?: number;
}

class UpdateThresholdsDto {
  thresholds: MetricThreshold[];
}

// ============================================================================
// Controller
// ============================================================================

@Controller('system/performance')
export class PerformanceController {
  constructor(private readonly performanceService: PerformanceMonitoringService) {}

  // ============================================================================
  // Dashboard
  // ============================================================================

  @Get('dashboard')
  async getPerformanceDashboard(
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.performanceService.getPerformanceDashboard(service, {
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
    });
  }

  // ============================================================================
  // Application Metrics
  // ============================================================================

  @Get('application')
  async getApplicationMetrics(
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.performanceService.getApplicationMetrics(service, {
      start: startDate ? new Date(startDate) : new Date(Date.now() - 5 * 60 * 1000),
      end: endDate ? new Date(endDate) : new Date(),
    });
  }

  @Get('application/apdex')
  async getApdexScore(
    @Query('satisfiedThreshold') satisfiedThreshold?: number,
    @Query('toleratedThreshold') toleratedThreshold?: number,
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return {
      apdexScore: await this.performanceService.calculateApdexScore(
        satisfiedThreshold ? Number(satisfiedThreshold) : undefined,
        toleratedThreshold ? Number(toleratedThreshold) : undefined,
        service,
        {
          start: startDate ? new Date(startDate) : undefined,
          end: endDate ? new Date(endDate) : undefined,
        },
      ),
    };
  }

  // ============================================================================
  // Database Metrics
  // ============================================================================

  @Get('database')
  async getDatabaseMetrics(
    @Query('database') database?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.performanceService.getDatabaseMetrics(database, {
      start: startDate ? new Date(startDate) : new Date(Date.now() - 5 * 60 * 1000),
      end: endDate ? new Date(endDate) : new Date(),
    });
  }

  @Get('database/slow-queries')
  async getSlowQueries(
    @Query('threshold') threshold?: number,
    @Query('limit') limit?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.performanceService.getSlowQueries(
      threshold ? Number(threshold) : undefined,
      limit ? Number(limit) : undefined,
      {
        start: startDate ? new Date(startDate) : undefined,
        end: endDate ? new Date(endDate) : undefined,
      },
    );
  }

  // ============================================================================
  // Infrastructure Metrics
  // ============================================================================

  @Get('infrastructure')
  async getInfrastructureMetrics(
    @Query('host') host?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.performanceService.getInfrastructureMetrics(host, {
      start: startDate ? new Date(startDate) : new Date(Date.now() - 5 * 60 * 1000),
      end: endDate ? new Date(endDate) : new Date(),
    });
  }

  // ============================================================================
  // Service Breakdown
  // ============================================================================

  @Get('services')
  async getServiceBreakdown(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    return this.performanceService.getServiceBreakdown(start, end);
  }

  // ============================================================================
  // Alerts & Thresholds
  // ============================================================================

  @Get('alerts')
  async checkThresholds(@Query('service') service?: string) {
    return this.performanceService.checkThresholds(service);
  }

  @Get('thresholds')
  getThresholds() {
    return this.performanceService.getThresholds();
  }

  @Post('thresholds')
  updateThresholds(@Body() dto: UpdateThresholdsDto) {
    this.performanceService.updateThresholds(dto.thresholds);
    return { success: true };
  }

  // ============================================================================
  // Historical Data
  // ============================================================================

  @Get('history')
  async getMetricHistory(
    @Query('metricType') metricType: MetricType,
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('intervalMinutes') intervalMinutes?: number,
  ) {
    return this.performanceService.getMetricHistory({
      metricType,
      service,
      start: startDate ? new Date(startDate) : new Date(Date.now() - 24 * 60 * 60 * 1000),
      end: endDate ? new Date(endDate) : new Date(),
      intervalMinutes: intervalMinutes ? Number(intervalMinutes) : undefined,
    });
  }

  @Get('snapshots')
  async getSnapshots(
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: number,
  ) {
    return this.performanceService.getSnapshots({
      service,
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ============================================================================
  // Metric Recording (for internal use)
  // ============================================================================

  @Post('metrics')
  async recordMetric(@Body() dto: RecordMetricDto) {
    await this.performanceService.recordMetric(dto);
    return { success: true };
  }

  @Post('metrics/request')
  async recordRequestMetric(
    @Body() dto: {
      service: string;
      endpoint: string;
      method: string;
      durationMs: number;
      isError: boolean;
    },
  ) {
    await this.performanceService.recordRequestMetric(
      dto.service,
      dto.endpoint,
      dto.method,
      dto.durationMs,
      dto.isError,
    );
    return { success: true };
  }

  @Post('metrics/flush')
  async flushMetrics() {
    await this.performanceService.flushMetrics();
    return { success: true };
  }
}
