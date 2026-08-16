/**
 * Database Monitoring Controller
 *
 * Database performans izleme, slow query ve index optimizasyonu endpoint'leri.
 */

import { Controller, Get, Post, Param, Body, Query, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

import { DatabaseMonitoringService } from '../services/database-monitoring.service';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  monitoringDatabaseHealthStatusContract,
  type MonitoringDatabaseHealthStatusDto,
  monitoringGetConnectionStatsResponseContract,
  type MonitoringGetConnectionStatsResponseDto,
  monitoringGetConnectionsByTenantResponseArrayContract,
  type MonitoringGetConnectionsByTenantResponseDto,
  monitoringGetQueryPerformanceStatsResponseContract,
  type MonitoringGetQueryPerformanceStatsResponseDto,
  monitoringSlowQueryResultContract,
  type MonitoringSlowQueryResultDto,
  monitoringAnalyzeQueryResponseContract,
  type MonitoringAnalyzeQueryResponseDto,
  monitoringGetTotalStorageResponseContract,
  type MonitoringGetTotalStorageResponseDto,
  monitoringGetStorageByTenantResponseArrayContract,
  type MonitoringGetStorageByTenantResponseDto,
  monitoringIndexRecommendationArrayContract,
  type MonitoringIndexRecommendationDto,
  monitoringDatabaseMetricArrayContract,
  type MonitoringDatabaseMetricDto,
} from '../contracts/admin-http-response.contract';

// ============================================================================
// DTOs
// ============================================================================

class AnalyzeQueryDto {
  @IsString()
  @IsNotEmpty()
  query!: string;

  @IsOptional()
  @IsString()
  schemaName?: string;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Database Management')
@Controller('database/monitoring')
export class MonitoringController {
  constructor(private readonly monitoringService: DatabaseMonitoringService) {}

  // ============================================================================
  // Health & Status
  // ============================================================================

  @AdminResponseContract(monitoringDatabaseHealthStatusContract)
  @Get('health')
  async getDatabaseHealth(): Promise<MonitoringDatabaseHealthStatusDto> {
    return this.monitoringService.getDatabaseHealthStatus();
  }

  // ============================================================================
  // Connection Monitoring
  // ============================================================================

  @AdminResponseContract(monitoringGetConnectionStatsResponseContract)
  @Get('connections')
  async getConnectionStats(): Promise<MonitoringGetConnectionStatsResponseDto> {
    return this.monitoringService.getConnectionStats();
  }

  @AdminResponseContract(monitoringGetConnectionsByTenantResponseArrayContract)
  @Get('connections/by-tenant')
  async getConnectionsByTenant(): Promise<MonitoringGetConnectionsByTenantResponseDto[]> {
    return this.monitoringService.getConnectionsByTenant();
  }

  // ============================================================================
  // Query Performance
  // ============================================================================

  @AdminResponseContract(monitoringGetQueryPerformanceStatsResponseContract)
  @Get('query-performance')
  async getQueryPerformanceStats(): Promise<MonitoringGetQueryPerformanceStatsResponseDto> {
    return this.monitoringService.getQueryPerformanceStats();
  }

  @AdminResponseContract(monitoringSlowQueryResultContract)
  @Get('slow-queries')
  async getSlowQueries(
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
    @Query('minTime') minTime?: string,
    @Query('grouped') grouped?: string,
  ): Promise<MonitoringSlowQueryResultDto> {
    return this.monitoringService.getSlowQueries({
      tenantId,
      limit: limit ? parseInt(limit, 10) : undefined,
      minExecutionTime: minTime ? parseInt(minTime, 10) : undefined,
      groupByQuery: grouped === 'true',
    });
  }

  @AdminResponseContract(monitoringAnalyzeQueryResponseContract)
  @Post('analyze-query')
  @HttpCode(HttpStatus.OK)
  async analyzeQuery(@Body() dto: AnalyzeQueryDto): Promise<MonitoringAnalyzeQueryResponseDto> {
    return this.monitoringService.analyzeQuery(dto.query, dto.schemaName);
  }

  // ============================================================================
  // Storage
  // ============================================================================

  @AdminResponseContract(monitoringGetTotalStorageResponseContract)
  @Get('storage')
  async getTotalStorage(): Promise<MonitoringGetTotalStorageResponseDto> {
    return this.monitoringService.getTotalStorage();
  }

  @AdminResponseContract(monitoringGetStorageByTenantResponseArrayContract)
  @Get('storage/by-tenant')
  async getStorageByTenant(): Promise<MonitoringGetStorageByTenantResponseDto[]> {
    return this.monitoringService.getStorageByTenant();
  }

  // ============================================================================
  // Index Optimization
  // ============================================================================

  @AdminResponseContract(monitoringIndexRecommendationArrayContract)
  @Get('index-recommendations')
  async getIndexRecommendations(
    @Query('schemaName') schemaName?: string,
  ): Promise<MonitoringIndexRecommendationDto[]> {
    return this.monitoringService.getIndexRecommendations(schemaName);
  }

  // ============================================================================
  // Metrics History
  // ============================================================================

  @AdminResponseContract(monitoringDatabaseMetricArrayContract)
  @Get('metrics')
  async getMetricsHistory(
    @Query('hours') hours?: string,
    @Query('tenantId') tenantId?: string,
    @Query('metricType') metricType?: string,
  ): Promise<MonitoringDatabaseMetricDto[]> {
    return this.monitoringService.getMetricsHistory({
      hours: hours ? parseInt(hours, 10) : undefined,
      tenantId,
      metricType,
    });
  }
}
