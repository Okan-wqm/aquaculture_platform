/**
 * Analytics Controller
 *
 * Dashboard KPI ve metrik endpoint'leri.
 */

import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  AnalyticsGranularity,
  AnalyticsRange,
  TimeSeriesData,
  TimeSeriesPoint,
  TimeSeriesResponse,
} from '../entities/analytics-snapshot.entity';
import { AnalyticsService } from '../services/analytics.service';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  analyticsDashboardSummaryContract,
  type AnalyticsDashboardSummaryDto,
  analyticsGetKpiComparisonsResponseContract,
  type AnalyticsGetKpiComparisonsResponseDto,
  analyticsTenantMetricsContract,
  type AnalyticsTenantMetricsDto,
  analyticsSnapshotTrendResponseContract,
  type AnalyticsSnapshotTrendResponseDto,
  analyticsTimeSeriesDataContract,
  type AnalyticsTimeSeriesDataDto,
  analyticsUserMetricsContract,
  type AnalyticsUserMetricsDto,
  analyticsChartDataContract,
  type AnalyticsChartDataDto,
  analyticsFinancialMetricsContract,
  type AnalyticsFinancialMetricsDto,
  analyticsRevenueAnalyticsContract,
  type AnalyticsRevenueAnalyticsDto,
  analyticsGetRevenueAnalyticsByPlanResponseArrayContract,
  type AnalyticsGetRevenueAnalyticsByPlanResponseDto,
  analyticsSystemMetricsContract,
  type AnalyticsSystemMetricsDto,
  analyticsUsageMetricsContract,
  type AnalyticsUsageMetricsDto,
  analyticsAnalyticsSnapshotArrayContract,
  type AnalyticsAnalyticsSnapshotDto,
} from '../contracts/admin-http-response.contract';

// INPUT VALIDATION: Constants for parameter limits
const MIN_DATA_POINTS = 1;
const MAX_DATA_POINTS = 365;
const VALID_PERIODS = ['day', 'week', 'month', 'year'] as const;
const VALID_RANGES = ['7d', '30d', '90d', '1y'] as const;
const VALID_GRANULARITIES = ['day', 'week', 'month'] as const;

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
function parsePeriodParameter(
  value: string,
  defaultDataPoints: number,
): { period: 'day' | 'week' | 'month' | 'year'; dataPoints: number } {
  // Check if it's a standard period format
  if (VALID_PERIODS.includes(value as (typeof VALID_PERIODS)[number])) {
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

function parseRangeParameter(
  range: string,
  granularity?: string,
): { range: AnalyticsRange; granularity: AnalyticsGranularity; period: 'day'; dataPoints: number } {
  if (!VALID_RANGES.includes(range as AnalyticsRange)) {
    throw new BadRequestException(`range must be one of: ${VALID_RANGES.join(', ')}`);
  }

  const typedRange = range as AnalyticsRange;
  const defaultGranularity: Record<AnalyticsRange, AnalyticsGranularity> = {
    '7d': 'day',
    '30d': 'day',
    '90d': 'week',
    '1y': 'month',
  };

  const typedGranularity = granularity
    ? (granularity as AnalyticsGranularity)
    : defaultGranularity[typedRange];

  if (!VALID_GRANULARITIES.includes(typedGranularity)) {
    throw new BadRequestException(`granularity must be one of: ${VALID_GRANULARITIES.join(', ')}`);
  }

  const dataPointsByRange: Record<AnalyticsRange, number> = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
    '1y': 365,
  };

  return {
    range: typedRange,
    granularity: typedGranularity,
    period: 'day',
    dataPoints: dataPointsByRange[typedRange],
  };
}

function toTimeSeriesResponse(
  timeSeries: TimeSeriesData,
  range: AnalyticsRange,
  granularity: AnalyticsGranularity,
  source: string,
): TimeSeriesResponse {
  return {
    range,
    granularity,
    data: aggregateTimeSeriesPoints(timeSeries.data, granularity),
    source,
    asOf: new Date().toISOString(),
  };
}

function aggregateTimeSeriesPoints(
  points: TimeSeriesPoint[],
  granularity: AnalyticsGranularity,
): TimeSeriesPoint[] {
  if (granularity === 'day') return points;

  const buckets = new Map<string, TimeSeriesPoint>();
  for (const point of points) {
    const date = new Date(point.date);
    if (isNaN(date.getTime())) continue;

    if (granularity === 'week') {
      const day = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() - day + 1);
    } else {
      date.setUTCDate(1);
    }

    const bucketDate = date.toISOString().slice(0, 10);
    buckets.set(bucketDate, { date: bucketDate, value: point.value });
  }

  return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // ============================================================================
  // Dashboard Summary
  // ============================================================================

  @AdminResponseContract(analyticsDashboardSummaryContract)
  @Get('dashboard')
  getDashboardSummary(): Promise<AnalyticsDashboardSummaryDto> {
    return this.analyticsService.getDashboardSummary();
  }

  @AdminResponseContract(analyticsGetKpiComparisonsResponseContract)
  @Get('kpi-comparisons')
  getKpiComparisons(): Promise<AnalyticsGetKpiComparisonsResponseDto> {
    return this.analyticsService.getKpiComparisons();
  }

  // ============================================================================
  // Tenant Metrics
  // ============================================================================

  @AdminResponseContract(analyticsTenantMetricsContract)
  @Get('tenants')
  getTenantMetrics(): Promise<AnalyticsTenantMetricsDto> {
    return this.analyticsService.getTenantMetrics();
  }

  @AdminResponseContract(analyticsSnapshotTrendResponseContract)
  @Get('tenants/growth')
  async getTenantGrowthTrend(
    @Query('range') range = '30d',
    @Query('granularity') granularity?: string,
  ): Promise<AnalyticsSnapshotTrendResponseDto> {
    const parsedRange = parseRangeParameter(range, granularity);
    const trend = await this.analyticsService.getTenantGrowthTrend({
      period: parsedRange.period,
      dataPoints: parsedRange.dataPoints,
    });
    return toTimeSeriesResponse(
      trend,
      parsedRange.range,
      parsedRange.granularity,
      'admin.analytics_snapshots',
    );
  }

  @AdminResponseContract(analyticsTimeSeriesDataContract)
  @Get('tenants/churn')
  getChurnRateTrend(
    @Query('period') period = 'month',
    @Query('dataPoints', new DefaultValuePipe(12), ParseIntPipe) dataPoints = 12,
  ): Promise<AnalyticsTimeSeriesDataDto> {
    // INPUT VALIDATION: Parse period (supports shorthand like '30d', '12m')
    const parsedPeriod = parsePeriodParameter(period, 12);
    const explicitDataPoints =
      dataPoints !== 12 ? validateDataPoints(dataPoints) : parsedPeriod.dataPoints;

    return this.analyticsService.getChurnRateTrend({
      period: parsedPeriod.period,
      dataPoints: explicitDataPoints,
    });
  }

  // ============================================================================
  // User Metrics
  // ============================================================================

  @AdminResponseContract(analyticsUserMetricsContract)
  @Get('users')
  getUserMetrics(): Promise<AnalyticsUserMetricsDto> {
    return this.analyticsService.getUserMetrics();
  }

  @AdminResponseContract(analyticsSnapshotTrendResponseContract)
  @Get('users/activity')
  async getUserActivityTrend(
    @Query('range') range = '30d',
    @Query('granularity') granularity?: string,
  ): Promise<AnalyticsSnapshotTrendResponseDto> {
    const parsedRange = parseRangeParameter(range, granularity);
    const trend = await this.analyticsService.getUserActivityTrend({
      period: parsedRange.period,
      dataPoints: parsedRange.dataPoints,
    });
    return toTimeSeriesResponse(
      trend,
      parsedRange.range,
      parsedRange.granularity,
      'admin.analytics_snapshots',
    );
  }

  @AdminResponseContract(analyticsChartDataContract)
  @Get('users/heatmap')
  getUserActivityHeatmap(): Promise<AnalyticsChartDataDto> {
    return this.analyticsService.getUserActivityHeatmap();
  }

  // ============================================================================
  // Financial Metrics
  // ============================================================================

  @AdminResponseContract(analyticsFinancialMetricsContract)
  @Get('financial')
  getFinancialMetrics(): Promise<AnalyticsFinancialMetricsDto> {
    return this.analyticsService.getFinancialMetrics();
  }

  @AdminResponseContract(analyticsTimeSeriesDataContract)
  @Get('financial/revenue')
  getRevenueTrend(
    @Query('period') period = 'month',
    @Query('dataPoints', new DefaultValuePipe(12), ParseIntPipe) dataPoints = 12,
  ): Promise<AnalyticsTimeSeriesDataDto> {
    // INPUT VALIDATION: Parse period (supports shorthand like '30d', '12m')
    const parsedPeriod = parsePeriodParameter(period, 12);
    const explicitDataPoints =
      dataPoints !== 12 ? validateDataPoints(dataPoints) : parsedPeriod.dataPoints;

    return this.analyticsService.getRevenueTrend({
      period: parsedPeriod.period,
      dataPoints: explicitDataPoints,
    });
  }

  @AdminResponseContract(analyticsChartDataContract)
  @Get('financial/by-plan')
  getRevenueByPlan(): Promise<AnalyticsChartDataDto> {
    return this.analyticsService.getRevenueByPlanChart();
  }

  // ============================================================================
  // Revenue Analytics (Frontend API compatibility)
  // ============================================================================

  /**
   * Get revenue analytics - matches frontend RevenueAnalytics interface
   */
  @AdminResponseContract(analyticsRevenueAnalyticsContract)
  @Get('revenue')
  getRevenueAnalytics(): Promise<AnalyticsRevenueAnalyticsDto> {
    return this.analyticsService.getRevenueAnalytics();
  }

  @AdminResponseContract(analyticsGetRevenueAnalyticsByPlanResponseArrayContract)
  @Get('revenue/by-plan')
  getRevenueAnalyticsByPlan(): Promise<AnalyticsGetRevenueAnalyticsByPlanResponseDto[]> {
    return this.analyticsService.getRevenueByPlanAnalytics();
  }

  @AdminResponseContract(analyticsSnapshotTrendResponseContract)
  @Get('revenue/trend')
  async getRevenueAnalyticsTrend(
    @Query('range') range = '30d',
    @Query('granularity') granularity?: string,
  ): Promise<AnalyticsSnapshotTrendResponseDto> {
    const parsedRange = parseRangeParameter(range, granularity);
    const trend = await this.analyticsService.getRevenueTrend({
      period: parsedRange.period,
      dataPoints: parsedRange.dataPoints,
    });
    return toTimeSeriesResponse(
      trend,
      parsedRange.range,
      parsedRange.granularity,
      'admin.analytics_snapshots',
    );
  }

  // ============================================================================
  // System Metrics
  // ============================================================================

  @AdminResponseContract(analyticsSystemMetricsContract)
  @Get('system')
  getSystemMetrics(): Promise<AnalyticsSystemMetricsDto> {
    return this.analyticsService.getSystemMetrics();
  }

  @AdminResponseContract(analyticsTimeSeriesDataContract)
  @Get('system/api-calls')
  getApiCallsTrend(
    @Query('period') period: 'day' | 'week' | 'month' | 'year' = 'day',
    @Query('dataPoints') dataPoints = 30,
  ): Promise<AnalyticsTimeSeriesDataDto> {
    return this.analyticsService.getApiCallsTrend({ period, dataPoints });
  }

  @AdminResponseContract(analyticsTimeSeriesDataContract)
  @Get('system/errors')
  getErrorRateTrend(
    @Query('period') period: 'day' | 'week' | 'month' | 'year' = 'day',
    @Query('dataPoints') dataPoints = 30,
  ): Promise<AnalyticsTimeSeriesDataDto> {
    return this.analyticsService.getErrorRateTrend({ period, dataPoints });
  }

  // ============================================================================
  // Usage Metrics
  // ============================================================================

  @AdminResponseContract(analyticsUsageMetricsContract)
  @Get('usage')
  getUsageMetrics(): Promise<AnalyticsUsageMetricsDto> {
    return this.analyticsService.getUsageMetrics();
  }

  @AdminResponseContract(analyticsChartDataContract)
  @Get('usage/modules')
  getModuleUsageChart(): Promise<AnalyticsChartDataDto> {
    return this.analyticsService.getModuleUsageChart();
  }

  @AdminResponseContract(analyticsChartDataContract)
  @Get('usage/features')
  getFeatureAdoptionChart(): Promise<AnalyticsChartDataDto> {
    return this.analyticsService.getFeatureAdoptionChart();
  }

  // ============================================================================
  // Snapshots
  // ============================================================================

  @AdminResponseContract(analyticsAnalyticsSnapshotArrayContract)
  @Get('snapshots')
  async getSnapshots(
    @Query('category') category: 'tenant' | 'user' | 'financial' | 'system' | 'usage',
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('snapshotType') snapshotType?: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): Promise<AnalyticsAnalyticsSnapshotDto[]> {
    // BUG-023 fix: validate date strings before constructing Date objects.
    // new Date('invalid') silently produces Invalid Date which causes DB query errors.
    const parsedStart = new Date(startDate);
    const parsedEnd = new Date(endDate);

    if (!startDate || isNaN(parsedStart.getTime())) {
      throw new BadRequestException('startDate must be a valid ISO 8601 date string');
    }
    if (!endDate || isNaN(parsedEnd.getTime())) {
      throw new BadRequestException('endDate must be a valid ISO 8601 date string');
    }

    return this.analyticsService.getSnapshots(
      category,
      {
        startDate: parsedStart,
        endDate: parsedEnd,
      },
      snapshotType,
    );
  }
}
