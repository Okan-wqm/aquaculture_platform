import {
  Controller,
  Get,
  Post,
  Body,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { IsString, IsOptional, IsNumber, IsObject, IsArray, IsBoolean, MaxLength } from 'class-validator';

import { MetricType } from '../entities/performance-metric.entity';
import { OperationAcknowledgement } from '../../common/dto/operation-acknowledgement.dto';
import { PerformanceMonitoringService, MetricThreshold } from '../services/performance-monitoring.service';
import type { PerformanceSnapshot } from '../entities/performance-metric.entity';
import type {
  ApdexScoreResult,
  ApplicationMetrics,
  DatabasePerformanceMetrics,
  InfrastructureMetrics,
  MetricHistoryPoint,
  PerformanceDashboard,
  ServiceBreakdown,
  SlowQueryAggregate,
  ThresholdBreach,
} from '../services/performance-monitoring.service';

// ============================================================================
// DTOs
// ============================================================================

class RecordMetricDto {
  @IsString()
  metricType!: MetricType;

  @IsString()
  name!: string;

  @IsNumber()
  value!: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsObject()
  dimensions?: Record<string, string | undefined>;

  @IsOptional()
  @IsObject()
  percentiles?: { p50?: number; p90?: number; p95?: number; p99?: number };

  @IsOptional()
  @IsNumber()
  sampleCount?: number;
}

class RecordRequestMetricDto {
  @IsString()
  @MaxLength(255)
  service!: string;

  @IsString()
  @MaxLength(255)
  endpoint!: string;

  @IsString()
  @MaxLength(10)
  method!: string;

  @IsNumber()
  durationMs!: number;

  @IsBoolean()
  isError!: boolean;
}

class UpdateThresholdsDto {
  @IsArray()
  thresholds!: MetricThreshold[];
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Analytics')
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
  ): Promise<PerformanceDashboard> {
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
  ): Promise<ApplicationMetrics> {
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
  ): Promise<ApdexScoreResult> {
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
  ): Promise<DatabasePerformanceMetrics> {
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
  ): Promise<SlowQueryAggregate[]> {
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
  ): Promise<InfrastructureMetrics> {
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
  ): Promise<ServiceBreakdown[]> {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    return this.performanceService.getServiceBreakdown(start, end);
  }

  // ============================================================================
  // Alerts & Thresholds
  // ============================================================================

  @Get('alerts')
  async checkThresholds(@Query('service') service?: string): Promise<ThresholdBreach[]> {
    return this.performanceService.checkThresholds(service);
  }

  @Get('thresholds')
  getThresholds(): MetricThreshold[] {
    return this.performanceService.getThresholds();
  }

  @Post('thresholds')
  updateThresholds(@Body() dto: UpdateThresholdsDto): OperationAcknowledgement {
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
  ): Promise<MetricHistoryPoint[]> {
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
  ): Promise<PerformanceSnapshot[]> {
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
  async recordMetric(@Body() dto: RecordMetricDto): Promise<OperationAcknowledgement> {
    await this.performanceService.recordMetric(dto);
    return { success: true };
  }

  @Post('metrics/request')
  async recordRequestMetric(
    @Body() dto: RecordRequestMetricDto,
  ): Promise<OperationAcknowledgement> {
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
  async flushMetrics(): Promise<OperationAcknowledgement> {
    await this.performanceService.flushMetrics();
    return { success: true };
  }
}
