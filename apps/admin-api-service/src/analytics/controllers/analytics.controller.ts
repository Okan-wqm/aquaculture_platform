/**
 * Analytics Controller
 *
 * Dashboard KPI ve metrik endpoint'leri.
 */

import {
  Controller,
  Get,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { AnalyticsService } from '../services/analytics.service';

// INPUT VALIDATION: Constants for parameter limits
const MIN_DATA_POINTS = 1;
const MAX_DATA_POINTS = 365;
const VALID_PERIODS = ['day', 'week', 'month', 'year'] as const;

/**
 * Validate and sanitize dataPoints parameter
 * Prevents DoS attacks from extremely large values and ensures valid input
 */
function validateDataPoints(value: unknown): number {
  const num = typeof value === 'string' ? parseInt(value, 10) : Number(value);

  if (isNaN(num) || num < MIN_DATA_POINTS) {
    throw new BadRequestException(
      `dataPoints must be a positive integer (min: ${MIN_DATA_POINTS}, max: ${MAX_DATA_POINTS})`,
    );
  }

  return Math.min(num, MAX_DATA_POINTS);
}

/**
 * Parse period parameter - supports both standard formats and shorthand
 * Standard: 'day', 'week', 'month', 'year'
 * Shorthand: '30d' (30 days), '12m' (12 months), '1y' (1 year), '4w' (4 weeks)
 * Returns { period, dataPoints } where period is the base unit and dataPoints is extracted from shorthand
 */
function parsePeriodParameter(value: string, defaultDataPoints: number): { period: 'day' | 'week' | 'month' | 'year'; dataPoints: number } {
  // Check if it's a standard period format
  if (VALID_PERIODS.includes(value as typeof VALID_PERIODS[number])) {
    return { period: value as 'day' | 'week' | 'month' | 'year', dataPoints: defaultDataPoints };
  }

  // Try to parse shorthand format (e.g., '30d', '12m', '1y', '4w')
  const match = value.match(/^(\d+)([dwmy])$/i);
  if (match) {
    const num = parseInt(match[1] || '0', 10);
    const unit = (match[2] || 'd').toLowerCase();

    if (num > 0 && num <= MAX_DATA_POINTS) {
      switch (unit) {
        case 'd':
          return { period: 'day', dataPoints: num };
        case 'w':
          return { period: 'week', dataPoints: num };
        case 'm':
          return { period: 'month', dataPoints: num };
        case 'y':
          return { period: 'year', dataPoints: num };
      }
    }
  }

  throw new BadRequestException(
    `period must be one of: ${VALID_PERIODS.join(', ')}, or a shorthand like '30d', '12m', '1y', '4w'`,
  );
}

/**
 * Validate period parameter (strict mode - only accepts standard formats)
 */
function validatePeriod(value: string): 'day' | 'week' | 'month' | 'year' {
  if (!VALID_PERIODS.includes(value as typeof VALID_PERIODS[number])) {
    throw new BadRequestException(
      `period must be one of: ${VALID_PERIODS.join(', ')}`,
    );
  }
  return value as 'day' | 'week' | 'month' | 'year';
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Analytics')
@Controller('analytics')
@UseGuards(PlatformAdminGuard)
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
    @Query('period') period = 'month',
    @Query('dataPoints') dataPoints: unknown = 12,
  ) {
    // INPUT VALIDATION: Parse period (supports shorthand like '30d', '12m')
    // If dataPoints is provided explicitly, use it; otherwise extract from period shorthand
    const parsedPeriod = parsePeriodParameter(period, 12);

    // If explicit dataPoints provided, validate and use it; otherwise use parsed value
    const explicitDataPoints = dataPoints !== 12 ? validateDataPoints(dataPoints) : parsedPeriod.dataPoints;

    return this.analyticsService.getTenantGrowthTrend({
      period: parsedPeriod.period,
      dataPoints: explicitDataPoints,
    });
  }

  @Get('tenants/churn')
  async getChurnRateTrend(
    @Query('period') period = 'month',
    @Query('dataPoints') dataPoints: unknown = 12,
  ) {
    // INPUT VALIDATION: Parse period (supports shorthand like '30d', '12m')
    const parsedPeriod = parsePeriodParameter(period, 12);
    const explicitDataPoints = dataPoints !== 12 ? validateDataPoints(dataPoints) : parsedPeriod.dataPoints;

    return this.analyticsService.getChurnRateTrend({
      period: parsedPeriod.period,
      dataPoints: explicitDataPoints,
    });
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
    @Query('period') period = 'day',
    @Query('dataPoints') dataPoints: unknown = 30,
  ) {
    // INPUT VALIDATION: Parse period (supports shorthand like '30d', '12m')
    const parsedPeriod = parsePeriodParameter(period, 30);
    const explicitDataPoints = dataPoints !== 30 ? validateDataPoints(dataPoints) : parsedPeriod.dataPoints;

    return this.analyticsService.getUserActivityTrend({
      period: parsedPeriod.period,
      dataPoints: explicitDataPoints,
    });
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
    @Query('period') period = 'month',
    @Query('dataPoints') dataPoints: unknown = 12,
  ) {
    // INPUT VALIDATION: Parse period (supports shorthand like '30d', '12m')
    const parsedPeriod = parsePeriodParameter(period, 12);
    const explicitDataPoints = dataPoints !== 12 ? validateDataPoints(dataPoints) : parsedPeriod.dataPoints;

    return this.analyticsService.getRevenueTrend({
      period: parsedPeriod.period,
      dataPoints: explicitDataPoints,
    });
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
