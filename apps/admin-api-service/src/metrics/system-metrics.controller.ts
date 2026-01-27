import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  SystemMetricsService,
  SystemMetrics,
  ServiceHealth,
} from './system-metrics.service';
import { PlatformAdminGuard } from '../guards/platform-admin.guard';

@Controller('system')
@UseGuards(PlatformAdminGuard)
export class SystemMetricsController {
  constructor(private readonly metricsService: SystemMetricsService) {}

  @Get('metrics')
  async getSystemMetrics(): Promise<SystemMetrics> {
    return this.metricsService.getSystemMetrics();
  }

  @Get('metrics/database')
  async getDatabaseMetrics() {
    return this.metricsService.getDatabaseMetrics();
  }

  @Get('metrics/platform')
  async getPlatformMetrics() {
    return this.metricsService.getPlatformMetrics();
  }

  @Get('metrics/resources')
  getResourceMetrics() {
    return this.metricsService.getResourceMetrics();
  }

  @Get('services/health')
  async getServicesHealth(): Promise<ServiceHealth[]> {
    return this.metricsService.checkServicesHealth();
  }

  @Get('metrics/trends')
  async getMetricTrends(
    @Query('metric') metric: string,
    @Query('interval') interval: '1h' | '24h' | '7d' | '30d' = '24h',
  ) {
    return this.metricsService.getMetricTrends(metric, interval);
  }
}
