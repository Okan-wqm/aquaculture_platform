import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { SystemMetricsService, SystemMetrics, ServiceHealth } from './system-metrics.service';
import { AdminResponseContract } from '../shared/admin-response-contract.decorator';
import {
  systemMetricsSystemMetricsContract,
  type SystemMetricsSystemMetricsDto,
  systemMetricsGetDatabaseMetricsResponseContract,
  type SystemMetricsGetDatabaseMetricsResponseDto,
  systemMetricsGetPlatformMetricsResponseContract,
  type SystemMetricsGetPlatformMetricsResponseDto,
  systemMetricsGetResourceMetricsResponseContract,
  type SystemMetricsGetResourceMetricsResponseDto,
  systemMetricsServiceHealthArrayContract,
  type SystemMetricsServiceHealthDto,
  systemMetricsGetMetricTrendsResponseArrayContract,
  type SystemMetricsGetMetricTrendsResponseDto,
} from './contracts/admin-http-response.contract';

@ApiTags('Analytics')
@Controller('system')
export class SystemMetricsController {
  constructor(private readonly metricsService: SystemMetricsService) {}

  @AdminResponseContract(systemMetricsSystemMetricsContract)
  @Get('metrics')
  async getSystemMetrics(): Promise<SystemMetricsSystemMetricsDto> {
    return this.metricsService.getSystemMetrics();
  }

  @AdminResponseContract(systemMetricsGetDatabaseMetricsResponseContract)
  @Get('metrics/database')
  async getDatabaseMetrics(): Promise<SystemMetricsGetDatabaseMetricsResponseDto> {
    return this.metricsService.getDatabaseMetrics();
  }

  @AdminResponseContract(systemMetricsGetPlatformMetricsResponseContract)
  @Get('metrics/platform')
  async getPlatformMetrics(): Promise<SystemMetricsGetPlatformMetricsResponseDto> {
    return this.metricsService.getPlatformMetrics();
  }

  @AdminResponseContract(systemMetricsGetResourceMetricsResponseContract)
  @Get('metrics/resources')
  getResourceMetrics(): SystemMetricsGetResourceMetricsResponseDto {
    return this.metricsService.getResourceMetrics();
  }

  @AdminResponseContract(systemMetricsServiceHealthArrayContract)
  @Get('services/health')
  async getServicesHealth(): Promise<SystemMetricsServiceHealthDto[]> {
    return this.metricsService.checkServicesHealth();
  }

  @AdminResponseContract(systemMetricsGetMetricTrendsResponseArrayContract)
  @Get('metrics/trends')
  async getMetricTrends(
    @Query('metric') metric: string,
    @Query('interval') interval: '1h' | '24h' | '7d' | '30d' = '24h',
  ): Promise<SystemMetricsGetMetricTrendsResponseDto[]> {
    return this.metricsService.getMetricTrends(metric, interval);
  }
}
