/**
 * Database Monitoring Controller
 *
 * Database performans izleme, slow query ve index optimizasyonu endpoint'leri.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { DatabaseMonitoringService } from '../services/database-monitoring.service';

// ============================================================================
// DTOs
// ============================================================================

class AnalyzeQueryDto {
  query: string;
  schemaName?: string;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('database/monitoring')
export class MonitoringController {
  constructor(private readonly monitoringService: DatabaseMonitoringService) {}

  // ============================================================================
  // Health & Status
  // ============================================================================

  @Get('health')
  async getDatabaseHealth() {
    return this.monitoringService.getDatabaseHealthStatus();
  }

  // ============================================================================
  // Connection Monitoring
  // ============================================================================

  @Get('connections')
  async getConnectionStats() {
    return this.monitoringService.getConnectionStats();
  }

  @Get('connections/by-tenant')
  async getConnectionsByTenant() {
    return this.monitoringService.getConnectionsByTenant();
  }

  // ============================================================================
  // Query Performance
  // ============================================================================

  @Get('query-performance')
  async getQueryPerformanceStats() {
    return this.monitoringService.getQueryPerformanceStats();
  }

  @Get('slow-queries')
  async getSlowQueries(
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
    @Query('minTime') minTime?: string,
    @Query('grouped') grouped?: string,
  ) {
    return this.monitoringService.getSlowQueries({
      tenantId,
      limit: limit ? parseInt(limit, 10) : undefined,
      minExecutionTime: minTime ? parseInt(minTime, 10) : undefined,
      groupByQuery: grouped === 'true',
    });
  }

  @Post('analyze-query')
  @HttpCode(HttpStatus.OK)
  async analyzeQuery(@Body() dto: AnalyzeQueryDto) {
    return this.monitoringService.analyzeQuery(dto.query, dto.schemaName);
  }

  // ============================================================================
  // Storage
  // ============================================================================

  @Get('storage')
  async getTotalStorage() {
    return this.monitoringService.getTotalStorage();
  }

  @Get('storage/by-tenant')
  async getStorageByTenant() {
    return this.monitoringService.getStorageByTenant();
  }

  // ============================================================================
  // Index Optimization
  // ============================================================================

  @Get('index-recommendations')
  async getIndexRecommendations(@Query('schemaName') schemaName?: string) {
    return this.monitoringService.getIndexRecommendations(schemaName);
  }

  // ============================================================================
  // Metrics History
  // ============================================================================

  @Get('metrics')
  async getMetricsHistory(
    @Query('hours') hours?: string,
    @Query('tenantId') tenantId?: string,
    @Query('metricType') metricType?: string,
  ) {
    return this.monitoringService.getMetricsHistory({
      hours: hours ? parseInt(hours, 10) : undefined,
      tenantId,
      metricType,
    });
  }
}
