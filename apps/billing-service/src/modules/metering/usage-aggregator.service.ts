/**
 * Usage Aggregator Service
 *
 * Aggregates usage data across different time periods and dimensions.
 * Supports daily, weekly, monthly rollups with tenant and module breakdowns.
 *
 * OPTIMIZED: Database persistence for fault tolerance - no data loss on restart.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThanOrEqual, Not } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MeterType, UsageMeteringService, MeterReading } from './usage-metering.service';
import { UsageAggregation, UsageHourlyData } from './entities/usage-aggregation.entity';

/**
 * Aggregation period
 */
export enum AggregationPeriod {
  HOURLY = 'hourly',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  YEARLY = 'yearly',
}

/**
 * Aggregation dimension
 */
export enum AggregationDimension {
  TENANT = 'tenant',
  MODULE = 'module',
  METER_TYPE = 'meter_type',
  USER = 'user',
  FARM = 'farm',
  RESOURCE = 'resource',
}

/**
 * Aggregated usage record
 */
export interface AggregatedUsage {
  id: string;
  tenantId: string;
  period: AggregationPeriod;
  periodStart: Date;
  periodEnd: Date;
  meterType: MeterType;
  dimension?: AggregationDimension;
  dimensionValue?: string;
  totalUsage: number;
  peakUsage: number;
  averageUsage: number;
  minUsage: number;
  maxUsage: number;
  eventCount: number;
  unit: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Usage breakdown by module
 */
export interface ModuleUsageBreakdown {
  moduleId: string;
  moduleName: string;
  totalUsage: number;
  percentageOfTotal: number;
  meterBreakdown: Map<MeterType, number>;
}

/**
 * Tenant-level aggregation summary
 */
export interface TenantUsageSummary {
  tenantId: string;
  period: AggregationPeriod;
  periodStart: Date;
  periodEnd: Date;
  totalUsageByMeter: Map<MeterType, number>;
  moduleBreakdown: ModuleUsageBreakdown[];
  peakUsageTime?: Date;
  costEstimate?: number;
  comparedToPreviousPeriod?: {
    totalChange: number;
    percentageChange: number;
  };
}

/**
 * Rollup configuration
 */
export interface RollupConfig {
  sourcePeriod: AggregationPeriod;
  targetPeriod: AggregationPeriod;
  retentionDays: number;
  aggregateOnSchedule: boolean;
  scheduleExpression?: string;
}

/**
 * Usage trend data point
 */
export interface UsageTrendPoint {
  timestamp: Date;
  value: number;
  period: AggregationPeriod;
}

/**
 * Usage statistics
 */
export interface UsageStatistics {
  mean: number;
  median: number;
  stdDev: number;
  variance: number;
  min: number;
  max: number;
  sum: number;
  count: number;
  percentile95: number;
  percentile99: number;
}

@Injectable()
export class UsageAggregatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsageAggregatorService.name);

  // In-memory cache backed by database
  private readonly aggregations = new Map<string, AggregatedUsage>();
  private readonly hourlyData = new Map<string, number[]>();
  private readonly rollupConfigs: RollupConfig[] = [];

  // Dirty tracking for batch persistence
  private readonly dirtyAggregations = new Set<string>();
  private readonly dirtyHourlyData = new Set<string>();
  private persistenceInterval: ReturnType<typeof setInterval> | null = null;

  // Metrics
  private metrics = {
    totalAggregations: 0,
    rollupsPerformed: 0,
    lastAggregationTime: null as Date | null,
  };

  constructor(
    @InjectRepository(UsageAggregation)
    private readonly aggregationRepository: Repository<UsageAggregation>,
    @InjectRepository(UsageHourlyData)
    private readonly hourlyDataRepository: Repository<UsageHourlyData>,
    private readonly usageMeteringService: UsageMeteringService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    this.initializeDefaultRollupConfigs();
    this.setupEventListeners();

    // Load existing data from database
    await this.loadFromDatabase();

    // Setup periodic persistence (every 30 seconds)
    this.persistenceInterval = setInterval(() => {
      this.persistDirtyData().catch(err => {
        this.logger.error(`Failed to persist dirty data: ${err.message}`);
      });
    }, 30000);

    this.logger.log('UsageAggregatorService initialized with database persistence');
  }

  async onModuleDestroy(): Promise<void> {
    // Clear persistence interval
    if (this.persistenceInterval) {
      clearInterval(this.persistenceInterval);
      this.persistenceInterval = null;
    }

    // Final persistence before shutdown
    await this.persistDirtyData();
    this.logger.log('UsageAggregatorService shutdown - all data persisted');
  }

  /**
   * Load aggregations from database on startup
   */
  private async loadFromDatabase(): Promise<void> {
    try {
      // Load recent aggregations (last 90 days for hourly, all for others)
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 90);

      const aggregations = await this.aggregationRepository.find({
        where: [
          { period: AggregationPeriod.HOURLY, periodStart: MoreThanOrEqual(cutoffDate) },
          { period: Not(AggregationPeriod.HOURLY) },
        ],
      });

      for (const agg of aggregations) {
        const aggregatedUsage: AggregatedUsage = {
          id: agg.id,
          tenantId: agg.tenantId,
          period: agg.period,
          periodStart: agg.periodStart,
          periodEnd: agg.periodEnd,
          meterType: agg.meterType,
          dimension: agg.dimension,
          dimensionValue: agg.dimensionValue,
          totalUsage: Number(agg.totalUsage),
          peakUsage: Number(agg.peakUsage),
          averageUsage: Number(agg.averageUsage),
          minUsage: Number(agg.minUsage),
          maxUsage: Number(agg.maxUsage),
          eventCount: agg.eventCount,
          unit: agg.unit,
          metadata: agg.metadata,
          createdAt: agg.createdAt,
          updatedAt: agg.updatedAt,
        };
        this.aggregations.set(agg.id, aggregatedUsage);
      }

      // Load hourly data
      const hourlyRecords = await this.hourlyDataRepository.find();
      for (const record of hourlyRecords) {
        this.hourlyData.set(record.id, record.values);
      }

      this.metrics.totalAggregations = this.aggregations.size;
      this.logger.log(`Loaded ${aggregations.length} aggregations and ${hourlyRecords.length} hourly records from database`);
    } catch (error) {
      this.logger.error(`Failed to load from database: ${(error as Error).message}`);
    }
  }

  /**
   * Persist dirty data to database
   */
  private async persistDirtyData(): Promise<void> {
    if (this.dirtyAggregations.size === 0 && this.dirtyHourlyData.size === 0) {
      return;
    }

    const aggregationsToPersist: UsageAggregation[] = [];
    const hourlyToPersist: UsageHourlyData[] = [];

    // Collect dirty aggregations
    for (const id of this.dirtyAggregations) {
      const agg = this.aggregations.get(id);
      if (agg) {
        const entity = this.aggregationRepository.create({
          id: agg.id,
          tenantId: agg.tenantId,
          period: agg.period,
          periodStart: agg.periodStart,
          periodEnd: agg.periodEnd,
          meterType: agg.meterType,
          dimension: agg.dimension,
          dimensionValue: agg.dimensionValue,
          totalUsage: agg.totalUsage,
          peakUsage: agg.peakUsage,
          averageUsage: agg.averageUsage,
          minUsage: agg.minUsage,
          maxUsage: agg.maxUsage,
          eventCount: agg.eventCount,
          unit: agg.unit,
          metadata: agg.metadata,
        });
        aggregationsToPersist.push(entity);
      }
    }

    // Collect dirty hourly data
    for (const id of this.dirtyHourlyData) {
      const values = this.hourlyData.get(id);
      if (values) {
        const [tenantId, meterTypeStr] = id.split(':');
        const entity = this.hourlyDataRepository.create({
          id,
          tenantId: tenantId!,
          meterType: meterTypeStr as MeterType,
          values,
        });
        hourlyToPersist.push(entity);
      }
    }

    try {
      // Batch upsert aggregations
      if (aggregationsToPersist.length > 0) {
        await this.aggregationRepository.upsert(
          aggregationsToPersist as unknown as Parameters<typeof this.aggregationRepository.upsert>[0],
          ['id'],
        );
        this.dirtyAggregations.clear();
      }

      // Batch upsert hourly data
      if (hourlyToPersist.length > 0) {
        await this.hourlyDataRepository.upsert(
          hourlyToPersist as unknown as Parameters<typeof this.hourlyDataRepository.upsert>[0],
          ['id'],
        );
        this.dirtyHourlyData.clear();
      }

      this.logger.debug(`Persisted ${aggregationsToPersist.length} aggregations, ${hourlyToPersist.length} hourly records`);
    } catch (error) {
      this.logger.error(`Failed to persist data: ${(error as Error).message}`);
    }
  }

  /**
   * Initialize default rollup configurations
   */
  private initializeDefaultRollupConfigs(): void {
    this.rollupConfigs.push(
      {
        sourcePeriod: AggregationPeriod.HOURLY,
        targetPeriod: AggregationPeriod.DAILY,
        retentionDays: 90,
        aggregateOnSchedule: true,
      },
      {
        sourcePeriod: AggregationPeriod.DAILY,
        targetPeriod: AggregationPeriod.WEEKLY,
        retentionDays: 365,
        aggregateOnSchedule: true,
      },
      {
        sourcePeriod: AggregationPeriod.DAILY,
        targetPeriod: AggregationPeriod.MONTHLY,
        retentionDays: 730, // 2 years
        aggregateOnSchedule: true,
      },
    );
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    this.eventEmitter.on('usage.recorded', (data: Record<string, unknown>) => {
      this.handleUsageRecorded(data);
    });
  }

  /**
   * Handle usage recorded event
   */
  private handleUsageRecorded(data: Record<string, unknown>): void {
    const tenantId = data.tenantId as string;
    const meterType = data.meterType as MeterType;
    const quantity = data.quantity as number;
    const timestamp = data.timestamp as Date;

    // Update hourly aggregation
    this.updateAggregation(tenantId, meterType, quantity, AggregationPeriod.HOURLY, timestamp);
  }

  /**
   * Update aggregation
   */
  updateAggregation(
    tenantId: string,
    meterType: MeterType,
    quantity: number,
    period: AggregationPeriod,
    timestamp: Date,
  ): AggregatedUsage {
    const periodBounds = this.getPeriodBounds(period, timestamp);
    const aggregationId = this.buildAggregationKey(tenantId, meterType, period, periodBounds.start);

    let aggregation = this.aggregations.get(aggregationId);

    if (!aggregation) {
      aggregation = {
        id: aggregationId,
        tenantId,
        period,
        periodStart: periodBounds.start,
        periodEnd: periodBounds.end,
        meterType,
        totalUsage: 0,
        peakUsage: 0,
        averageUsage: 0,
        minUsage: Number.MAX_VALUE,
        maxUsage: 0,
        eventCount: 0,
        unit: this.getUnitForMeterType(meterType),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.aggregations.set(aggregationId, aggregation);
      this.metrics.totalAggregations++;
    }

    // Update aggregation
    aggregation.totalUsage += quantity;
    aggregation.eventCount++;
    aggregation.averageUsage = aggregation.totalUsage / aggregation.eventCount;
    aggregation.minUsage = Math.min(aggregation.minUsage, quantity);
    aggregation.maxUsage = Math.max(aggregation.maxUsage, quantity);
    aggregation.peakUsage = Math.max(aggregation.peakUsage, aggregation.totalUsage);
    aggregation.updatedAt = new Date();

    // Mark as dirty for persistence
    this.dirtyAggregations.add(aggregationId);

    // Store for trend analysis
    const hourlyKey = `${tenantId}:${meterType}:hourly`;
    const hourlyValues = this.hourlyData.get(hourlyKey) || [];
    hourlyValues.push(quantity);
    if (hourlyValues.length > 8760) { // Keep 1 year of hourly data
      hourlyValues.shift();
    }
    this.hourlyData.set(hourlyKey, hourlyValues);

    // Mark hourly data as dirty
    this.dirtyHourlyData.add(hourlyKey);

    return aggregation;
  }

  /**
   * Get period bounds
   */
  private getPeriodBounds(
    period: AggregationPeriod,
    timestamp: Date,
  ): { start: Date; end: Date } {
    const date = new Date(timestamp);

    switch (period) {
      case AggregationPeriod.HOURLY: {
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours());
        const end = new Date(start.getTime() + 3600000 - 1);
        return { start, end };
      }

      case AggregationPeriod.DAILY: {
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const end = new Date(start.getTime() + 86400000 - 1);
        return { start, end };
      }

      case AggregationPeriod.WEEKLY: {
        const dayOfWeek = date.getDay();
        const diff = date.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        const start = new Date(date.getFullYear(), date.getMonth(), diff);
        const end = new Date(start.getTime() + 604800000 - 1);
        return { start, end };
      }

      case AggregationPeriod.MONTHLY: {
        const start = new Date(date.getFullYear(), date.getMonth(), 1);
        const end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
        return { start, end };
      }

      case AggregationPeriod.QUARTERLY: {
        const quarter = Math.floor(date.getMonth() / 3);
        const start = new Date(date.getFullYear(), quarter * 3, 1);
        const end = new Date(date.getFullYear(), (quarter + 1) * 3, 0, 23, 59, 59, 999);
        return { start, end };
      }

      case AggregationPeriod.YEARLY: {
        const start = new Date(date.getFullYear(), 0, 1);
        const end = new Date(date.getFullYear(), 11, 31, 23, 59, 59, 999);
        return { start, end };
      }

      default:
        throw new Error(`Unsupported aggregation period: ${period}`);
    }
  }

  /**
   * Build aggregation key
   */
  private buildAggregationKey(
    tenantId: string,
    meterType: MeterType,
    period: AggregationPeriod,
    periodStart: Date,
  ): string {
    return `${tenantId}:${meterType}:${period}:${periodStart.toISOString()}`;
  }

  /**
   * Get unit for meter type
   */
  private getUnitForMeterType(meterType: MeterType): string {
    const config = this.usageMeteringService.getMeterConfig(meterType);
    return config?.unit || 'units';
  }

  /**
   * Perform rollup from source to target period
   */
  performRollup(
    tenantId: string,
    meterType: MeterType,
    sourcePeriod: AggregationPeriod,
    targetPeriod: AggregationPeriod,
    targetPeriodStart: Date,
  ): AggregatedUsage | null {
    const targetBounds = this.getPeriodBounds(targetPeriod, targetPeriodStart);

    // Find all source aggregations within the target period
    const sourceAggregations: AggregatedUsage[] = [];

    for (const aggregation of this.aggregations.values()) {
      if (
        aggregation.tenantId === tenantId &&
        aggregation.meterType === meterType &&
        aggregation.period === sourcePeriod &&
        aggregation.periodStart >= targetBounds.start &&
        aggregation.periodEnd <= targetBounds.end
      ) {
        sourceAggregations.push(aggregation);
      }
    }

    if (sourceAggregations.length === 0) {
      return null;
    }

    // Calculate rolled up values
    const totalUsage = sourceAggregations.reduce((sum, a) => sum + a.totalUsage, 0);
    const eventCount = sourceAggregations.reduce((sum, a) => sum + a.eventCount, 0);
    const peakUsage = Math.max(...sourceAggregations.map(a => a.peakUsage));
    const minUsage = Math.min(...sourceAggregations.map(a => a.minUsage));
    const maxUsage = Math.max(...sourceAggregations.map(a => a.maxUsage));

    const rollupId = this.buildAggregationKey(tenantId, meterType, targetPeriod, targetBounds.start);

    const rollup: AggregatedUsage = {
      id: rollupId,
      tenantId,
      period: targetPeriod,
      periodStart: targetBounds.start,
      periodEnd: targetBounds.end,
      meterType,
      totalUsage,
      peakUsage,
      averageUsage: eventCount > 0 ? totalUsage / eventCount : 0,
      minUsage,
      maxUsage,
      eventCount,
      unit: this.getUnitForMeterType(meterType),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.aggregations.set(rollupId, rollup);
    this.metrics.rollupsPerformed++;
    this.metrics.lastAggregationTime = new Date();

    // Mark as dirty for persistence
    this.dirtyAggregations.add(rollupId);

    this.logger.debug(
      `Performed rollup: ${tenantId} - ${meterType} from ${sourcePeriod} to ${targetPeriod}`,
    );

    return rollup;
  }

  /**
   * Get aggregation for a specific period
   */
  getAggregation(
    tenantId: string,
    meterType: MeterType,
    period: AggregationPeriod,
    timestamp: Date,
  ): AggregatedUsage | undefined {
    const periodBounds = this.getPeriodBounds(period, timestamp);
    const key = this.buildAggregationKey(tenantId, meterType, period, periodBounds.start);
    return this.aggregations.get(key);
  }

  /**
   * Get all aggregations for a tenant in a time range
   */
  getAggregationsInRange(
    tenantId: string,
    period: AggregationPeriod,
    startDate: Date,
    endDate: Date,
    meterType?: MeterType,
  ): AggregatedUsage[] {
    const results: AggregatedUsage[] = [];

    for (const aggregation of this.aggregations.values()) {
      if (
        aggregation.tenantId === tenantId &&
        aggregation.period === period &&
        aggregation.periodStart >= startDate &&
        aggregation.periodEnd <= endDate &&
        (!meterType || aggregation.meterType === meterType)
      ) {
        results.push(aggregation);
      }
    }

    return results.sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
  }

  /**
   * Get tenant usage summary
   */
  getTenantUsageSummary(
    tenantId: string,
    period: AggregationPeriod,
    periodStart: Date,
  ): TenantUsageSummary {
    const bounds = this.getPeriodBounds(period, periodStart);
    const aggregations = this.getAggregationsInRange(
      tenantId,
      period,
      bounds.start,
      bounds.end,
    );

    const totalUsageByMeter = new Map<MeterType, number>();
    let peakUsageTime: Date | undefined;
    let peakUsageValue = 0;

    for (const agg of aggregations) {
      const current = totalUsageByMeter.get(agg.meterType) || 0;
      totalUsageByMeter.set(agg.meterType, current + agg.totalUsage);

      if (agg.peakUsage > peakUsageValue) {
        peakUsageValue = agg.peakUsage;
        peakUsageTime = agg.periodStart;
      }
    }

    // Get previous period for comparison
    const previousPeriodStart = this.getPreviousPeriodStart(period, bounds.start);
    const previousAggregations = this.getAggregationsInRange(
      tenantId,
      period,
      previousPeriodStart,
      bounds.start,
    );

    let comparedToPreviousPeriod: { totalChange: number; percentageChange: number } | undefined;

    if (previousAggregations.length > 0) {
      const previousTotal = previousAggregations.reduce((sum, a) => sum + a.totalUsage, 0);
      const currentTotal = aggregations.reduce((sum, a) => sum + a.totalUsage, 0);
      const totalChange = currentTotal - previousTotal;
      const percentageChange = previousTotal > 0 ? (totalChange / previousTotal) * 100 : 0;

      comparedToPreviousPeriod = { totalChange, percentageChange };
    }

    return {
      tenantId,
      period,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      totalUsageByMeter,
      moduleBreakdown: [], // TODO: Implement module breakdown
      peakUsageTime,
      comparedToPreviousPeriod,
    };
  }

  /**
   * Get previous period start
   */
  private getPreviousPeriodStart(period: AggregationPeriod, currentStart: Date): Date {
    const date = new Date(currentStart);

    switch (period) {
      case AggregationPeriod.HOURLY:
        return new Date(date.getTime() - 3600000);
      case AggregationPeriod.DAILY:
        return new Date(date.getTime() - 86400000);
      case AggregationPeriod.WEEKLY:
        return new Date(date.getTime() - 604800000);
      case AggregationPeriod.MONTHLY:
        return new Date(date.getFullYear(), date.getMonth() - 1, 1);
      case AggregationPeriod.QUARTERLY:
        return new Date(date.getFullYear(), date.getMonth() - 3, 1);
      case AggregationPeriod.YEARLY:
        return new Date(date.getFullYear() - 1, 0, 1);
      default:
        return date;
    }
  }

  /**
   * Get usage trend
   */
  getUsageTrend(
    tenantId: string,
    meterType: MeterType,
    period: AggregationPeriod,
    numPeriods: number,
  ): UsageTrendPoint[] {
    const now = new Date();
    const trends: UsageTrendPoint[] = [];

    for (let i = numPeriods - 1; i >= 0; i--) {
      const periodStart = this.subtractPeriods(now, period, i);
      const aggregation = this.getAggregation(tenantId, meterType, period, periodStart);

      trends.push({
        timestamp: periodStart,
        value: aggregation?.totalUsage || 0,
        period,
      });
    }

    return trends;
  }

  /**
   * Subtract periods from date
   */
  private subtractPeriods(date: Date, period: AggregationPeriod, count: number): Date {
    const result = new Date(date);

    switch (period) {
      case AggregationPeriod.HOURLY:
        result.setHours(result.getHours() - count);
        break;
      case AggregationPeriod.DAILY:
        result.setDate(result.getDate() - count);
        break;
      case AggregationPeriod.WEEKLY:
        result.setDate(result.getDate() - count * 7);
        break;
      case AggregationPeriod.MONTHLY:
        result.setMonth(result.getMonth() - count);
        break;
      case AggregationPeriod.QUARTERLY:
        result.setMonth(result.getMonth() - count * 3);
        break;
      case AggregationPeriod.YEARLY:
        result.setFullYear(result.getFullYear() - count);
        break;
    }

    return result;
  }

  /**
   * Calculate usage statistics
   */
  calculateStatistics(
    tenantId: string,
    meterType: MeterType,
    period: AggregationPeriod,
    numPeriods: number,
  ): UsageStatistics {
    const trend = this.getUsageTrend(tenantId, meterType, period, numPeriods);
    const values = trend.map(t => t.value).filter(v => v > 0);

    if (values.length === 0) {
      return {
        mean: 0,
        median: 0,
        stdDev: 0,
        variance: 0,
        min: 0,
        max: 0,
        sum: 0,
        count: 0,
        percentile95: 0,
        percentile99: 0,
      };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / values.length;

    // Variance and standard deviation
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(variance);

    // Median
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 !== 0
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;

    // Percentiles
    const percentile95Index = Math.floor(sorted.length * 0.95);
    const percentile99Index = Math.floor(sorted.length * 0.99);

    return {
      mean,
      median,
      stdDev,
      variance,
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      sum,
      count: values.length,
      percentile95: sorted[percentile95Index] || sorted[sorted.length - 1]!,
      percentile99: sorted[percentile99Index] || sorted[sorted.length - 1]!,
    };
  }

  /**
   * Get metrics
   */
  getMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }

  /**
   * Cleanup old aggregations
   */
  cleanupOldAggregations(retentionDays: number = 365): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    let deletedCount = 0;

    for (const [key, aggregation] of this.aggregations) {
      if (aggregation.periodEnd < cutoff) {
        this.aggregations.delete(key);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      this.logger.log(`Cleaned up ${deletedCount} old aggregations`);
    }

    return deletedCount;
  }

  /**
   * Export aggregations
   */
  exportAggregations(tenantId: string): AggregatedUsage[] {
    return Array.from(this.aggregations.values()).filter(a => a.tenantId === tenantId);
  }

  /**
   * Get all meter types with data
   */
  getActiveMeterTypes(tenantId: string): MeterType[] {
    const meterTypes = new Set<MeterType>();

    for (const aggregation of this.aggregations.values()) {
      if (aggregation.tenantId === tenantId) {
        meterTypes.add(aggregation.meterType);
      }
    }

    return Array.from(meterTypes);
  }
}
