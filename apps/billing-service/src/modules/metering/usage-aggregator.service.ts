/**
 * Usage Aggregator Service
 *
 * Aggregates usage data across different time periods and dimensions.
 * Supports daily, weekly, monthly rollups with tenant and module breakdowns.
 *
 * OPTIMIZED: Database persistence for fault tolerance - no data loss on restart.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DataSource, Repository, Between, In, MoreThanOrEqual, Not } from 'typeorm';
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
  /** Nullable: null until the first observation is recorded in this aggregation period */
  minUsage: number | null;
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
 * Month-to-date usage summary for one meter, read from the PERSISTED
 * usage_aggregations rows (not the per-instance in-memory cache).
 *
 * WHY two numbers: cumulative counters (api_calls, sensor_readings) are
 * answered by the month's summed totalUsage, while gauge meters
 * (data_storage, users/farms/sensors active) record absolute levels — for
 * those the most recent hourly bucket's maxUsage is the current level.
 */
export interface MeterMonthUsage {
  meterType: MeterType;
  /** Σ totalUsage across the month window — correct for cumulative counters. */
  cumulativeTotal: number;
  /** maxUsage of the most recent hourly bucket — current level for gauges. */
  latestLevel: number;
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
  // Secondary index: tenantId → Set of aggregation keys owned by that tenant.
  // Prevents O(N-all-tenants) scans in getAggregationsInRange/performRollup —
  // per-tenant lookups are O(tenant-record-count) instead.
  private readonly tenantAggregationIndex = new Map<string, Set<string>>();
  private readonly hourlyData = new Map<string, number[]>();
  // Ring-buffer write-head positions for hourlyData — avoids O(N) Array.shift()
  private readonly hourlyDataIndex = new Map<string, number>();
  private readonly rollupConfigs: RollupConfig[] = [];
  private static readonly HOURLY_WINDOW = 8760;

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

  private aggregationRepository!: Repository<UsageAggregation>;
  private hourlyDataRepository!: Repository<UsageHourlyData>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly usageMeteringService: UsageMeteringService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    // Initialize repositories at module init — this service is a cross-
    // tenant aggregator (runs a 30s persistence interval + periodic
    // rollups across ALL tenants in one pass). tenantManagerRepo is
    // not applicable because no single tenantId holds for the service's
    // lifetime; every downstream query pins tenantId explicitly.
    // eslint-disable-next-line no-restricted-syntax -- cross-tenant aggregator
    this.aggregationRepository = this.dataSource.getRepository(UsageAggregation);
    // eslint-disable-next-line no-restricted-syntax -- cross-tenant aggregator
    this.hourlyDataRepository = this.dataSource.getRepository(UsageHourlyData);

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
      // Load recent aggregations only — hourly: last 90 days, non-hourly: last 2 years.
      // Avoids unbounded startup load on mature deployments.
      const hourlyCutoff = new Date();
      hourlyCutoff.setDate(hourlyCutoff.getDate() - 90);

      const nonHourlyCutoff = new Date();
      nonHourlyCutoff.setFullYear(nonHourlyCutoff.getFullYear() - 2);

      const aggregations = await this.aggregationRepository.find({
        where: [
          { period: AggregationPeriod.HOURLY, periodStart: MoreThanOrEqual(hourlyCutoff) },
          { period: Not(AggregationPeriod.HOURLY), periodStart: MoreThanOrEqual(nonHourlyCutoff) },
        ],
        order: { periodStart: 'DESC' },
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
          minUsage: agg.minUsage !== null && agg.minUsage !== undefined ? Number(agg.minUsage) : null,
          maxUsage: Number(agg.maxUsage),
          eventCount: agg.eventCount,
          unit: agg.unit,
          metadata: agg.metadata,
          createdAt: agg.createdAt,
          updatedAt: agg.updatedAt,
        };
        this.aggregations.set(agg.id, aggregatedUsage);
        // Populate secondary index
        if (!this.tenantAggregationIndex.has(agg.tenantId)) {
          this.tenantAggregationIndex.set(agg.tenantId, new Set());
        }
        this.tenantAggregationIndex.get(agg.tenantId)!.add(agg.id);
      }

      // Load hourly data — limit to prevent unbounded startup load
      const hourlyRecords = await this.hourlyDataRepository.find({
        order: { updatedAt: 'DESC' },
        take: 10000,
      });
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
          aggregationsToPersist as Parameters<typeof this.aggregationRepository.upsert>[0],
          ['id'],
        );
        this.dirtyAggregations.clear();
      }

      // Batch upsert hourly data
      if (hourlyToPersist.length > 0) {
        await this.hourlyDataRepository.upsert(
          hourlyToPersist as Parameters<typeof this.hourlyDataRepository.upsert>[0],
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
    const tenantId = data['tenantId'] as string;
    const meterType = data['meterType'] as MeterType;
    const quantity = data['quantity'] as number;
    const timestamp = data['timestamp'] as Date;

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
        minUsage: quantity, // Initialize with first observed value instead of Number.MAX_VALUE
        maxUsage: 0,
        eventCount: 0,
        unit: this.getUnitForMeterType(meterType),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.aggregations.set(aggregationId, aggregation);
      // Maintain secondary index for O(tenant-record-count) per-tenant lookups
      if (!this.tenantAggregationIndex.has(tenantId)) {
        this.tenantAggregationIndex.set(tenantId, new Set());
      }
      this.tenantAggregationIndex.get(tenantId)!.add(aggregationId);
      this.metrics.totalAggregations++;
    }

    // Update aggregation
    aggregation.totalUsage += quantity;
    aggregation.eventCount++;
    aggregation.averageUsage = aggregation.totalUsage / aggregation.eventCount;
    aggregation.minUsage = Math.min(aggregation.minUsage ?? Infinity, quantity);
    aggregation.maxUsage = Math.max(aggregation.maxUsage ?? -Infinity, quantity);
    aggregation.peakUsage = Math.max(aggregation.peakUsage, aggregation.totalUsage);
    aggregation.updatedAt = new Date();

    // Mark as dirty for persistence
    this.dirtyAggregations.add(aggregationId);

    // Store for trend analysis using a ring buffer — O(1) writes, no Array.shift()
    const hourlyKey = `${tenantId}:${meterType}:hourly`;
    if (!this.hourlyData.has(hourlyKey)) {
      this.hourlyData.set(hourlyKey, new Array(UsageAggregatorService.HOURLY_WINDOW).fill(0));
      this.hourlyDataIndex.set(hourlyKey, 0);
    }
    const hourlyValues = this.hourlyData.get(hourlyKey)!;
    const writeIdx = this.hourlyDataIndex.get(hourlyKey)!;
    hourlyValues[writeIdx] = quantity;
    this.hourlyDataIndex.set(hourlyKey, (writeIdx + 1) % UsageAggregatorService.HOURLY_WINDOW);
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
    // MED-07: Guard against key overflow — the column is varchar(255).
    // tenantId is a UUID (36 chars), meterType and period are enums, periodStart is an ISO string (24 chars).
    // Total should never exceed ~120 chars for valid inputs, but we fail fast if it would truncate.
    const key = `${tenantId}:${meterType}:${period}:${periodStart.toISOString()}`;
    if (key.length > 255) {
      throw new Error(
        `Aggregation key exceeds maximum length of 255 characters (got ${key.length}). ` +
          `tenantId=${tenantId}, meterType=${meterType}, period=${period}`,
      );
    }
    return key;
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

    // Find all source aggregations within the target period.
    // Use the secondary tenant index to avoid O(N-all-tenants) scan (CRITICAL-002).
    const sourceAggregations: AggregatedUsage[] = [];
    const tenantKeys = this.tenantAggregationIndex.get(tenantId);
    if (!tenantKeys) return null;

    for (const key of tenantKeys) {
      const aggregation = this.aggregations.get(key);
      if (
        aggregation &&
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
    // Filter out null minUsage values (new aggregation records before first observation)
    const validMinValues = sourceAggregations
      .map(a => a.minUsage)
      .filter((v): v is number => v !== null && v !== undefined);
    const minUsage = validMinValues.length > 0 ? Math.min(...validMinValues) : null;
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
    // Maintain secondary index
    if (!this.tenantAggregationIndex.has(tenantId)) {
      this.tenantAggregationIndex.set(tenantId, new Set());
    }
    this.tenantAggregationIndex.get(tenantId)!.add(rollupId);
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
   * Month-to-date persisted usage summary for one tenant.
   *
   * WHY: `billing.tenant_usage_metrics` was retired (A6 / DB-IDENT-MEDIUM-002)
   * — `usage_aggregations` is the single persisted usage model. Tenant-facing
   * billing reads (GetTenantBillingHandler) need a month summary that is
   * correct across service instances, so this reads the PERSISTED rows rather
   * than the per-instance in-memory cache above.
   *
   * WHAT: aggregates the tenant's HOURLY rows inside the month containing
   * `reference`. HOURLY is the granularity the live event path writes
   * (`handleUsageRecorded` → `updateAggregation(HOURLY)`); rollup periods are
   * derived views, so summing hourly buckets never double-counts.
   */
  async getPersistedMonthUsage(
    tenantId: string,
    reference: Date,
  ): Promise<Map<MeterType, MeterMonthUsage>> {
    const bounds = this.getPeriodBounds(AggregationPeriod.MONTHLY, reference);

    // This service is a cross-tenant aggregator (see onModuleInit); per its
    // contract every downstream query pins tenantId explicitly in the WHERE.
    const rows = await this.aggregationRepository.find({
      where: {
        tenantId,
        period: AggregationPeriod.HOURLY,
        periodStart: Between(bounds.start, bounds.end),
      },
      order: { periodStart: 'ASC' },
    });

    const summary = new Map<MeterType, MeterMonthUsage>();
    for (const row of rows) {
      const entry = summary.get(row.meterType) ?? {
        meterType: row.meterType,
        cumulativeTotal: 0,
        latestLevel: 0,
      };
      entry.cumulativeTotal += row.totalUsage;
      // Rows arrive periodStart-ASC, so the last row seen per meter is the
      // most recent bucket — its maxUsage is the level a gauge meter reached
      // in that bucket (gauges record absolute levels as event quantities).
      entry.latestLevel = row.maxUsage;
      summary.set(row.meterType, entry);
    }
    return summary;
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

    // Use secondary tenant index to avoid O(N-all-tenants) full scan (CRITICAL-002).
    const tenantKeys = this.tenantAggregationIndex.get(tenantId);
    if (!tenantKeys) return results;

    for (const key of tenantKeys) {
      const aggregation = this.aggregations.get(key);
      if (
        aggregation &&
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
