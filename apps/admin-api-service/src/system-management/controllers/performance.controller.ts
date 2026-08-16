import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  IsString,
  IsOptional,
  IsNumber,
  IsObject,
  IsArray,
  IsBoolean,
  MaxLength,
} from 'class-validator';

import { MetricType } from '../entities/performance-metric.entity';
import {
  PerformanceMonitoringService,
  MetricThreshold,
} from '../services/performance-monitoring.service';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  performancePerformanceDashboardContract,
  type PerformancePerformanceDashboardDto,
  performanceApplicationMetricsContract,
  type PerformanceApplicationMetricsDto,
  performanceGetApdexScoreResponseContract,
  type PerformanceGetApdexScoreResponseDto,
  performanceDatabaseMetricsContract,
  type PerformanceDatabaseMetricsDto,
  performanceGetSlowQueriesResponseArrayContract,
  type PerformanceGetSlowQueriesResponseDto,
  performanceInfrastructureMetricsContract,
  type PerformanceInfrastructureMetricsDto,
  performanceGetServiceBreakdownResponseArrayContract,
  type PerformanceGetServiceBreakdownResponseDto,
  performanceCheckThresholdsResponseArrayContract,
  type PerformanceCheckThresholdsResponseDto,
  performanceMetricThresholdArrayContract,
  type PerformanceMetricThresholdDto,
  performanceUpdateThresholdsResponseContract,
  type PerformanceUpdateThresholdsResponseDto,
  performanceGetMetricHistoryResponseArrayContract,
  type PerformanceGetMetricHistoryResponseDto,
  performancePerformanceSnapshotArrayContract,
  type PerformancePerformanceSnapshotDto,
  performanceRecordMetricResponseContract,
  type PerformanceRecordMetricResponseDto,
  performanceRecordRequestMetricResponseContract,
  type PerformanceRecordRequestMetricResponseDto,
  performanceFlushMetricsResponseContract,
  type PerformanceFlushMetricsResponseDto,
} from '../contracts/admin-http-response.contract';

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

  @AdminResponseContract(performancePerformanceDashboardContract)
  @Get('dashboard')
  async getPerformanceDashboard(
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<PerformancePerformanceDashboardDto> {
    return this.performanceService.getPerformanceDashboard(service, {
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
    });
  }

  // ============================================================================
  // Application Metrics
  // ============================================================================

  @AdminResponseContract(performanceApplicationMetricsContract)
  @Get('application')
  async getApplicationMetrics(
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<PerformanceApplicationMetricsDto> {
    return this.performanceService.getApplicationMetrics(service, {
      start: startDate ? new Date(startDate) : new Date(Date.now() - 5 * 60 * 1000),
      end: endDate ? new Date(endDate) : new Date(),
    });
  }

  @AdminResponseContract(performanceGetApdexScoreResponseContract)
  @Get('application/apdex')
  async getApdexScore(
    @Query('satisfiedThreshold') satisfiedThreshold?: number,
    @Query('toleratedThreshold') toleratedThreshold?: number,
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<PerformanceGetApdexScoreResponseDto> {
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

  @AdminResponseContract(performanceDatabaseMetricsContract)
  @Get('database')
  async getDatabaseMetrics(
    @Query('database') database?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<PerformanceDatabaseMetricsDto> {
    return this.performanceService.getDatabaseMetrics(database, {
      start: startDate ? new Date(startDate) : new Date(Date.now() - 5 * 60 * 1000),
      end: endDate ? new Date(endDate) : new Date(),
    });
  }

  @AdminResponseContract(performanceGetSlowQueriesResponseArrayContract)
  @Get('database/slow-queries')
  async getSlowQueries(
    @Query('threshold') threshold?: number,
    @Query('limit') limit?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<PerformanceGetSlowQueriesResponseDto[]> {
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

  @AdminResponseContract(performanceInfrastructureMetricsContract)
  @Get('infrastructure')
  async getInfrastructureMetrics(
    @Query('host') host?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<PerformanceInfrastructureMetricsDto> {
    return this.performanceService.getInfrastructureMetrics(host, {
      start: startDate ? new Date(startDate) : new Date(Date.now() - 5 * 60 * 1000),
      end: endDate ? new Date(endDate) : new Date(),
    });
  }

  // ============================================================================
  // Service Breakdown
  // ============================================================================

  @AdminResponseContract(performanceGetServiceBreakdownResponseArrayContract)
  @Get('services')
  async getServiceBreakdown(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<PerformanceGetServiceBreakdownResponseDto[]> {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    return this.performanceService.getServiceBreakdown(start, end);
  }

  // ============================================================================
  // Alerts & Thresholds
  // ============================================================================

  @AdminResponseContract(performanceCheckThresholdsResponseArrayContract)
  @Get('alerts')
  async checkThresholds(
    @Query('service') service?: string,
  ): Promise<PerformanceCheckThresholdsResponseDto[]> {
    return this.performanceService.checkThresholds(service);
  }

  @AdminResponseContract(performanceMetricThresholdArrayContract)
  @Get('thresholds')
  getThresholds(): PerformanceMetricThresholdDto[] {
    return this.performanceService.getThresholds();
  }

  @AdminResponseContract(performanceUpdateThresholdsResponseContract)
  @Post('thresholds')
  updateThresholds(@Body() dto: UpdateThresholdsDto): PerformanceUpdateThresholdsResponseDto {
    this.performanceService.updateThresholds(dto.thresholds);
    return { success: true };
  }

  // ============================================================================
  // Historical Data
  // ============================================================================

  @AdminResponseContract(performanceGetMetricHistoryResponseArrayContract)
  @Get('history')
  async getMetricHistory(
    @Query('metricType') metricType: MetricType,
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('intervalMinutes') intervalMinutes?: number,
  ): Promise<PerformanceGetMetricHistoryResponseDto[]> {
    return this.performanceService.getMetricHistory({
      metricType,
      service,
      start: startDate ? new Date(startDate) : new Date(Date.now() - 24 * 60 * 60 * 1000),
      end: endDate ? new Date(endDate) : new Date(),
      intervalMinutes: intervalMinutes ? Number(intervalMinutes) : undefined,
    });
  }

  @AdminResponseContract(performancePerformanceSnapshotArrayContract)
  @Get('snapshots')
  async getSnapshots(
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: number,
  ): Promise<PerformancePerformanceSnapshotDto[]> {
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

  @AdminResponseContract(performanceRecordMetricResponseContract)
  @Post('metrics')
  async recordMetric(@Body() dto: RecordMetricDto): Promise<PerformanceRecordMetricResponseDto> {
    await this.performanceService.recordMetric(dto);
    return { success: true };
  }

  @AdminResponseContract(performanceRecordRequestMetricResponseContract)
  @Post('metrics/request')
  async recordRequestMetric(
    @Body() dto: RecordRequestMetricDto,
  ): Promise<PerformanceRecordRequestMetricResponseDto> {
    await this.performanceService.recordRequestMetric(
      dto.service,
      dto.endpoint,
      dto.method,
      dto.durationMs,
      dto.isError,
    );
    return { success: true };
  }

  @AdminResponseContract(performanceFlushMetricsResponseContract)
  @Post('metrics/flush')
  async flushMetrics(): Promise<PerformanceFlushMetricsResponseDto> {
    await this.performanceService.flushMetrics();
    return { success: true };
  }
}
