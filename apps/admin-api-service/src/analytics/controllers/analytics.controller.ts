/**
 * Analytics Controller
 *
 * Dashboard KPI ve metrik endpoint'leri.
 */

import {
  Controller,
  Get,
  Query,
} from '@nestjs/common';
import { AnalyticsService } from '../services/analytics.service';

// ============================================================================
// Controller
// ============================================================================

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // ============================================================================
  // Dashboard Summary
  // ============================================================================

  @Get('dashboard')
  async getDashboardSummary() {
    return this.analyticsService.getDashboardSummary();
  }

  @Get('kpi-comparisons')
  async getKpiComparisons() {
    return this.analyticsService.getKpiComparisons();
  }

  // ============================================================================
  // Tenant Metrics
  // ============================================================================

  @Get('tenants')
  async getTenantMetrics() {
    return this.analyticsService.getTenantMetrics();
  }

  @Get('tenants/growth')
  async getTenantGrowthTrend(
    @Query('period') period: 'day' | 'week' | 'month' | 'year' = 'month',
    @Query('dataPoints') dataPoints = 12,
  ) {
    return this.analyticsService.getTenantGrowthTrend({ period, dataPoints });
  }

  @Get('tenants/churn')
  async getChurnRateTrend(
    @Query('period') period: 'day' | 'week' | 'month' | 'year' = 'month',
    @Query('dataPoints') dataPoints = 12,
  ) {
    return this.analyticsService.getChurnRateTrend({ period, dataPoints });
  }

  // ============================================================================
  // User Metrics
  // ============================================================================

  @Get('users')
  async getUserMetrics() {
    return this.analyticsService.getUserMetrics();
  }

  @Get('users/activity')
  async getUserActivityTrend(
    @Query('period') period: 'day' | 'week' | 'month' | 'year' = 'day',
    @Query('dataPoints') dataPoints = 30,
  ) {
    return this.analyticsService.getUserActivityTrend({ period, dataPoints });
  }

  @Get('users/heatmap')
  async getUserActivityHeatmap() {
    return this.analyticsService.getUserActivityHeatmap();
  }

  // ============================================================================
  // Financial Metrics
  // ============================================================================

  @Get('financial')
  async getFinancialMetrics() {
    return this.analyticsService.getFinancialMetrics();
  }

  @Get('financial/revenue')
  async getRevenueTrend(
    @Query('period') period: 'day' | 'week' | 'month' | 'year' = 'month',
    @Query('dataPoints') dataPoints = 12,
  ) {
    return this.analyticsService.getRevenueTrend({ period, dataPoints });
  }

  @Get('financial/by-plan')
  async getRevenueByPlan() {
    return this.analyticsService.getRevenueByPlanChart();
  }

  // ============================================================================
  // Revenue Analytics (Frontend API compatibility)
  // ============================================================================

  /**
   * Get revenue analytics - matches frontend RevenueAnalytics interface
   */
  @Get('revenue')
  async getRevenueAnalytics() {
    return this.analyticsService.getRevenueAnalytics();
  }

  @Get('revenue/by-plan')
  async getRevenueAnalyticsByPlan() {
    return this.analyticsService.getRevenueByPlanAnalytics();
  }

  @Get('revenue/trend')
  async getRevenueAnalyticsTrend(
    @Query('period') period = '12m',
  ) {
    return this.analyticsService.getRevenueTrendAnalytics(period);
  }

  // ============================================================================
  // System Metrics
  // ============================================================================

  @Get('system')
  async getSystemMetrics() {
    return this.analyticsService.getSystemMetrics();
  }

  @Get('system/api-calls')
  async getApiCallsTrend(
    @Query('period') period: 'day' | 'week' | 'month' | 'year' = 'day',
    @Query('dataPoints') dataPoints = 30,
  ) {
    return this.analyticsService.getApiCallsTrend({ period, dataPoints });
  }

  @Get('system/errors')
  async getErrorRateTrend(
    @Query('period') period: 'day' | 'week' | 'month' | 'year' = 'day',
    @Query('dataPoints') dataPoints = 30,
  ) {
    return this.analyticsService.getErrorRateTrend({ period, dataPoints });
  }

  // ============================================================================
  // Usage Metrics
  // ============================================================================

  @Get('usage')
  async getUsageMetrics() {
    return this.analyticsService.getUsageMetrics();
  }

  @Get('usage/modules')
  async getModuleUsageChart() {
    return this.analyticsService.getModuleUsageChart();
  }

  @Get('usage/features')
  async getFeatureAdoptionChart() {
    return this.analyticsService.getFeatureAdoptionChart();
  }

  // ============================================================================
  // Snapshots
  // ============================================================================

  @Get('snapshots')
  async getSnapshots(
    @Query('category') category: 'tenant' | 'user' | 'financial' | 'system' | 'usage',
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('snapshotType') snapshotType?: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ) {
    return this.analyticsService.getSnapshots(
      category,
      {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      },
      snapshotType,
    );
  }
}
