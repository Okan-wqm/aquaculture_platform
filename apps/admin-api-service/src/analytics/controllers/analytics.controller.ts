/**
 * Analytics Controller
 *
 * Dashboard KPI ve metrik endpoint'leri.
 */

import {
  Controller,
  Get,
  Query,
  BadRequestException,
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

// INPUT VALIDATION: Constants for parameter limits
const MIN_DATA_POINTS = 1;
const MAX_DATA_POINTS = 365;
const VALID_PERIODS = ['day', 'week', 'month', 'year'] as const;
const VALID_RANGES = ['7d', '30d', '90d', '1y'] as const;
const VALID_GRANULARITIES = ['day', 'week', 'month'] as const;

type AnalyticsTrendResponse = TimeSeriesData | TimeSeriesResponse;
type RevenueTrendAnalyticsResponse = Awaited<ReturnType<AnalyticsService['getRevenueTrendAnalytics']>>;

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

/** A period parameter resolved into its base unit and how many of them to plot. */
interface ParsedPeriod {
  period: 'day' | 'week' | 'month' | 'year';
  dataPoints: number;
}

/**
 * A range parameter resolved into the canonical analytics window.
 *
 * `period` is always `'day'`: a range is expressed in days regardless of the
 * granularity the caller asked to aggregate at.
 */
interface ParsedRange {
  range: AnalyticsRange;
  granularity: AnalyticsGranularity;
  period: 'day';
  dataPoints: number;
}

/**
 * Parse period parameter - supports both standard formats and shorthand
 * Standard: 'day', 'week', 'month', 'year'
 * Shorthand: '30d' (30 days), '12m' (12 months), '1y' (1 year), '4w' (4 weeks)
 * Returns { period, dataPoints } where period is the base unit and dataPoints is extracted from shorthand
 */
function parsePeriodParameter(value: string, defaultDataPoints: number): ParsedPeriod {
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

function parseRangeParameter(
  range: string,
  granularity?: string,
): ParsedRange {
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
    ? granularity as AnalyticsGranularity
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

  @Get('dashboard')
  getDashboardSummary(): ReturnType<AnalyticsService['getDashboardSummary']> {
    return this.analyticsService.getDashboardSummary();
  }

  @Get('kpi-comparisons')
  getKpiComparisons(): ReturnType<AnalyticsService['getKpiComparisons']> {
    return this.analyticsService.getKpiComparisons();
  }

  // ============================================================================
  // Tenant Metrics
  // ============================================================================

  @Get('tenants')
  getTenantMetrics(): ReturnType<AnalyticsService['getTenantMetrics']> {
    return this.analyticsService.getTenantMetrics();
  }

  @Get('tenants/growth')
  async getTenantGrowthTrend(
    @Query('range') range?: string,
    @Query('granularity') granularity?: string,
    @Query('period') period = 'month',
    @Query('dataPoints') dataPoints: unknown = 12,
  ): Promise<AnalyticsTrendResponse> {
    if (range) {
      const parsedRange = parseRangeParameter(range, granularity);
      const trend = await this.analyticsService.getTenantGrowthTrend({
        period: parsedRange.period,
        dataPoints: parsedRange.dataPoints,
      });
      return toTimeSeriesResponse(trend, parsedRange.range, parsedRange.granularity, 'admin.analytics_snapshots');
    }

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
  getChurnRateTrend(
    @Query('period') period = 'month',
    @Query('dataPoints') dataPoints: unknown = 12,
  ): ReturnType<AnalyticsService['getChurnRateTrend']> {
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
  getUserMetrics(): ReturnType<AnalyticsService['getUserMetrics']> {
    return this.analyticsService.getUserMetrics();
  }

  @Get('users/activity')
  async getUserActivityTrend(
    @Query('range') range?: string,
    @Query('granularity') granularity?: string,
    @Query('period') period = 'day',
    @Query('dataPoints') dataPoints: unknown = 30,
  ): Promise<AnalyticsTrendResponse> {
    if (range) {
      const parsedRange = parseRangeParameter(range, granularity);
      const trend = await this.analyticsService.getUserActivityTrend({
        period: parsedRange.period,
        dataPoints: parsedRange.dataPoints,
      });
      return toTimeSeriesResponse(trend, parsedRange.range, parsedRange.granularity, 'admin.analytics_snapshots');
    }

    // INPUT VALIDATION: Parse period (supports shorthand like '30d', '12m')
    const parsedPeriod = parsePeriodParameter(period, 30);
    const explicitDataPoints = dataPoints !== 30 ? validateDataPoints(dataPoints) : parsedPeriod.dataPoints;

    return this.analyticsService.getUserActivityTrend({
      period: parsedPeriod.period,
      dataPoints: explicitDataPoints,
    });
  }

  @Get('users/heatmap')
  getUserActivityHeatmap(): ReturnType<AnalyticsService['getUserActivityHeatmap']> {
    return this.analyticsService.getUserActivityHeatmap();
  }

  // ============================================================================
  // Financial Metrics
  // ============================================================================

  @Get('financial')
  getFinancialMetrics(): ReturnType<AnalyticsService['getFinancialMetrics']> {
    return this.analyticsService.getFinancialMetrics();
  }

  @Get('financial/revenue')
  getRevenueTrend(
    @Query('period') period = 'month',
    @Query('dataPoints') dataPoints: unknown = 12,
  ): ReturnType<AnalyticsService['getRevenueTrend']> {
    // INPUT VALIDATION: Parse period (supports shorthand like '30d', '12m')
    const parsedPeriod = parsePeriodParameter(period, 12);
    const explicitDataPoints = dataPoints !== 12 ? validateDataPoints(dataPoints) : parsedPeriod.dataPoints;

    return this.analyticsService.getRevenueTrend({
      period: parsedPeriod.period,
      dataPoints: explicitDataPoints,
    });
  }

  @Get('financial/by-plan')
  getRevenueByPlan(): ReturnType<AnalyticsService['getRevenueByPlanChart']> {
    return this.analyticsService.getRevenueByPlanChart();
  }

  // ============================================================================
  // Revenue Analytics (Frontend API compatibility)
  // ============================================================================

  /**
   * Get revenue analytics - matches frontend RevenueAnalytics interface
   */
  @Get('revenue')
  getRevenueAnalytics(): ReturnType<AnalyticsService['getRevenueAnalytics']> {
    return this.analyticsService.getRevenueAnalytics();
  }

  @Get('revenue/by-plan')
  getRevenueAnalyticsByPlan(): ReturnType<AnalyticsService['getRevenueByPlanAnalytics']> {
    return this.analyticsService.getRevenueByPlanAnalytics();
  }

  @Get('revenue/trend')
  async getRevenueAnalyticsTrend(
    @Query('range') range?: string,
    @Query('granularity') granularity?: string,
    @Query('period') period = '12m',
  ): Promise<TimeSeriesResponse | RevenueTrendAnalyticsResponse> {
    if (range) {
      const parsedRange = parseRangeParameter(range, granularity);
      const trend = await this.analyticsService.getRevenueTrend({
        period: parsedRange.period,
        dataPoints: parsedRange.dataPoints,
      });
      return toTimeSeriesResponse(trend, parsedRange.range, parsedRange.granularity, 'admin.analytics_snapshots');
    }

    return this.analyticsService.getRevenueTrendAnalytics(period);
  }

  // ============================================================================
  // System Metrics
  // ============================================================================

  @Get('system')
  getSystemMetrics(): ReturnType<AnalyticsService['getSystemMetrics']> {
    return this.analyticsService.getSystemMetrics();
  }

  @Get('system/api-calls')
  getApiCallsTrend(
    @Query('period') period: 'day' | 'week' | 'month' | 'year' = 'day',
    @Query('dataPoints') dataPoints = 30,
  ): ReturnType<AnalyticsService['getApiCallsTrend']> {
    return this.analyticsService.getApiCallsTrend({ period, dataPoints });
  }

  @Get('system/errors')
  getErrorRateTrend(
    @Query('period') period: 'day' | 'week' | 'month' | 'year' = 'day',
    @Query('dataPoints') dataPoints = 30,
  ): ReturnType<AnalyticsService['getErrorRateTrend']> {
    return this.analyticsService.getErrorRateTrend({ period, dataPoints });
  }

  // ============================================================================
  // Usage Metrics
  // ============================================================================

  @Get('usage')
  getUsageMetrics(): ReturnType<AnalyticsService['getUsageMetrics']> {
    return this.analyticsService.getUsageMetrics();
  }

  @Get('usage/modules')
  getModuleUsageChart(): ReturnType<AnalyticsService['getModuleUsageChart']> {
    return this.analyticsService.getModuleUsageChart();
  }

  @Get('usage/features')
  getFeatureAdoptionChart(): ReturnType<AnalyticsService['getFeatureAdoptionChart']> {
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
  ): ReturnType<AnalyticsService['getSnapshots']> {
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
