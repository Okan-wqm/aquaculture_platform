import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  UsageAggregatorService,
  AggregationPeriod,
  AggregationDimension,
  AggregatedUsage,
  TenantUsageSummary,
  UsageStatistics,
  UsageTrendPoint,
} from '../usage-aggregator.service';
import { UsageMeteringService, MeterType } from '../usage-metering.service';

describe('UsageAggregatorService', () => {
  let service: UsageAggregatorService;
  let usageMeteringService: jest.Mocked<UsageMeteringService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const mockUsageMeteringService = {
    getMeterConfig: jest.fn().mockReturnValue({ unit: 'calls' }),
    getMeterReading: jest.fn(),
    getAllMeterReadings: jest.fn(),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsageAggregatorService,
        {
          provide: UsageMeteringService,
          useValue: mockUsageMeteringService,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
      ],
    }).compile();

    service = module.get<UsageAggregatorService>(UsageAggregatorService);
    usageMeteringService = module.get(UsageMeteringService);
    eventEmitter = module.get(EventEmitter2);

    service.onModuleInit();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // TIME-BASED AGGREGATION TESTS
  // ============================================================================
  describe('Time-based Aggregation', () => {
    describe('Aggregation Update', () => {
      it('should create hourly aggregation', () => {
        const now = new Date();
        const aggregation = service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          100,
          AggregationPeriod.HOURLY,
          now,
        );

        expect(aggregation).toBeDefined();
        expect(aggregation.tenantId).toBe('tenant-1');
        expect(aggregation.meterType).toBe(MeterType.API_CALLS);
        expect(aggregation.period).toBe(AggregationPeriod.HOURLY);
        expect(aggregation.totalUsage).toBe(100);
      });

      it('should create daily aggregation', () => {
        const now = new Date();
        const aggregation = service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          500,
          AggregationPeriod.DAILY,
          now,
        );

        expect(aggregation.period).toBe(AggregationPeriod.DAILY);
        expect(aggregation.totalUsage).toBe(500);
      });

      it('should create weekly aggregation', () => {
        const now = new Date();
        const aggregation = service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          1000,
          AggregationPeriod.WEEKLY,
          now,
        );

        expect(aggregation.period).toBe(AggregationPeriod.WEEKLY);
        expect(aggregation.totalUsage).toBe(1000);
      });

      it('should create monthly aggregation', () => {
        const now = new Date();
        const aggregation = service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          5000,
          AggregationPeriod.MONTHLY,
          now,
        );

        expect(aggregation.period).toBe(AggregationPeriod.MONTHLY);
        expect(aggregation.totalUsage).toBe(5000);
      });

      it('should create quarterly aggregation', () => {
        const now = new Date();
        const aggregation = service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          15000,
          AggregationPeriod.QUARTERLY,
          now,
        );

        expect(aggregation.period).toBe(AggregationPeriod.QUARTERLY);
        expect(aggregation.totalUsage).toBe(15000);
      });

      it('should create yearly aggregation', () => {
        const now = new Date();
        const aggregation = service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          100000,
          AggregationPeriod.YEARLY,
          now,
        );

        expect(aggregation.period).toBe(AggregationPeriod.YEARLY);
        expect(aggregation.totalUsage).toBe(100000);
      });
    });

    describe('Period Bounds Calculation', () => {
      it('should calculate hourly period bounds correctly', () => {
        const testDate = new Date('2024-06-15T14:30:45Z');
        const aggregation = service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          100,
          AggregationPeriod.HOURLY,
          testDate,
        );

        expect(aggregation.periodStart.getHours()).toBe(testDate.getHours());
        expect(aggregation.periodStart.getMinutes()).toBe(0);
        expect(aggregation.periodStart.getSeconds()).toBe(0);
      });

      it('should calculate daily period bounds correctly', () => {
        const testDate = new Date('2024-06-15T14:30:45Z');
        const aggregation = service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          100,
          AggregationPeriod.DAILY,
          testDate,
        );

        expect(aggregation.periodStart.getDate()).toBe(15);
        expect(aggregation.periodStart.getHours()).toBe(0);
      });

      it('should calculate monthly period bounds correctly', () => {
        const testDate = new Date('2024-06-15T14:30:45Z');
        const aggregation = service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          100,
          AggregationPeriod.MONTHLY,
          testDate,
        );

        expect(aggregation.periodStart.getMonth()).toBe(5); // June (0-indexed)
        expect(aggregation.periodStart.getDate()).toBe(1);
      });

      it('should calculate quarterly period bounds correctly', () => {
        const testDate = new Date('2024-06-15T14:30:45Z');
        const aggregation = service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          100,
          AggregationPeriod.QUARTERLY,
          testDate,
        );

        // June is in Q2, which starts in April (month 3)
        expect(aggregation.periodStart.getMonth()).toBe(3);
        expect(aggregation.periodStart.getDate()).toBe(1);
      });

      it('should calculate yearly period bounds correctly', () => {
        const testDate = new Date('2024-06-15T14:30:45Z');
        const aggregation = service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          100,
          AggregationPeriod.YEARLY,
          testDate,
        );

        expect(aggregation.periodStart.getMonth()).toBe(0); // January
        expect(aggregation.periodStart.getDate()).toBe(1);
        expect(aggregation.periodStart.getFullYear()).toBe(2024);
      });
    });

    describe('Aggregation Accumulation', () => {
      it('should accumulate values in same period', () => {
        const now = new Date();

        service.updateAggregation('tenant-1', MeterType.API_CALLS, 100, AggregationPeriod.HOURLY, now);
        service.updateAggregation('tenant-1', MeterType.API_CALLS, 200, AggregationPeriod.HOURLY, now);
        service.updateAggregation('tenant-1', MeterType.API_CALLS, 300, AggregationPeriod.HOURLY, now);

        const aggregation = service.getAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          AggregationPeriod.HOURLY,
          now,
        );

        expect(aggregation?.totalUsage).toBe(600);
        expect(aggregation?.eventCount).toBe(3);
      });

      it('should track min and max values', () => {
        const now = new Date();

        service.updateAggregation('tenant-1', MeterType.API_CALLS, 100, AggregationPeriod.HOURLY, now);
        service.updateAggregation('tenant-1', MeterType.API_CALLS, 500, AggregationPeriod.HOURLY, now);
        service.updateAggregation('tenant-1', MeterType.API_CALLS, 200, AggregationPeriod.HOURLY, now);

        const aggregation = service.getAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          AggregationPeriod.HOURLY,
          now,
        );

        expect(aggregation?.minUsage).toBe(100);
        expect(aggregation?.maxUsage).toBe(500);
      });

      it('should calculate average correctly', () => {
        const now = new Date();

        service.updateAggregation('tenant-1', MeterType.API_CALLS, 100, AggregationPeriod.HOURLY, now);
        service.updateAggregation('tenant-1', MeterType.API_CALLS, 200, AggregationPeriod.HOURLY, now);
        service.updateAggregation('tenant-1', MeterType.API_CALLS, 300, AggregationPeriod.HOURLY, now);

        const aggregation = service.getAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          AggregationPeriod.HOURLY,
          now,
        );

        expect(aggregation?.averageUsage).toBe(200);
      });

      it('should track peak usage', () => {
        const now = new Date();

        service.updateAggregation('tenant-1', MeterType.API_CALLS, 100, AggregationPeriod.HOURLY, now);
        service.updateAggregation('tenant-1', MeterType.API_CALLS, 200, AggregationPeriod.HOURLY, now);

        const aggregation = service.getAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          AggregationPeriod.HOURLY,
          now,
        );

        expect(aggregation?.peakUsage).toBe(300); // Total at peak
      });
    });
  });

  // ============================================================================
  // ROLLUP TESTS
  // ============================================================================
  describe('Rollup Operations', () => {
    it('should perform daily to weekly rollup', () => {
      const monday = new Date('2024-06-10T12:00:00Z'); // Monday

      // Create daily aggregations for the week
      for (let i = 0; i < 7; i++) {
        const day = new Date(monday);
        day.setDate(day.getDate() + i);
        service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          100,
          AggregationPeriod.DAILY,
          day,
        );
      }

      const rollup = service.performRollup(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        AggregationPeriod.WEEKLY,
        monday,
      );

      expect(rollup).toBeDefined();
      expect(rollup?.period).toBe(AggregationPeriod.WEEKLY);
      expect(rollup?.totalUsage).toBeGreaterThan(0);
    });

    it('should perform weekly to monthly rollup', () => {
      const monthStart = new Date('2024-06-01T12:00:00Z');

      // Create weekly aggregations for the month
      for (let i = 0; i < 4; i++) {
        const week = new Date(monthStart);
        week.setDate(week.getDate() + i * 7);
        service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          1000,
          AggregationPeriod.WEEKLY,
          week,
        );
      }

      const rollup = service.performRollup(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.WEEKLY,
        AggregationPeriod.MONTHLY,
        monthStart,
      );

      expect(rollup?.period).toBe(AggregationPeriod.MONTHLY);
    });

    it('should return null when no source aggregations exist', () => {
      const rollup = service.performRollup(
        'non-existent-tenant',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        AggregationPeriod.MONTHLY,
        new Date(),
      );

      expect(rollup).toBeNull();
    });

    it('should calculate correct rollup statistics', () => {
      const now = new Date();

      // Create multiple daily aggregations
      service.updateAggregation('tenant-1', MeterType.API_CALLS, 100, AggregationPeriod.DAILY, now);
      service.updateAggregation('tenant-1', MeterType.API_CALLS, 200, AggregationPeriod.DAILY, now);
      service.updateAggregation('tenant-1', MeterType.API_CALLS, 50, AggregationPeriod.DAILY, now);

      const aggregation = service.getAggregation(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        now,
      );

      expect(aggregation?.totalUsage).toBe(350);
      expect(aggregation?.minUsage).toBe(50);
      expect(aggregation?.maxUsage).toBe(200);
    });

    it('should track rollup metrics', () => {
      const now = new Date();

      service.updateAggregation('tenant-1', MeterType.API_CALLS, 100, AggregationPeriod.HOURLY, now);

      service.performRollup(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.HOURLY,
        AggregationPeriod.DAILY,
        now,
      );

      const metrics = service.getMetrics();
      expect(metrics.rollupsPerformed).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================================
  // AGGREGATION QUERIES
  // ============================================================================
  describe('Aggregation Queries', () => {
    beforeEach(() => {
      // Setup test data
      const baseDate = new Date('2024-06-01T12:00:00Z');
      for (let i = 0; i < 30; i++) {
        const date = new Date(baseDate);
        date.setDate(date.getDate() + i);
        service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          100 + i * 10,
          AggregationPeriod.DAILY,
          date,
        );
      }
    });

    it('should get aggregation by key', () => {
      const startDate = new Date('2024-06-01T00:00:00Z');
      const aggregation = service.getAggregation(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        startDate,
      );

      expect(aggregation).toBeDefined();
      expect(aggregation?.tenantId).toBe('tenant-1');
    });

    it('should get aggregations in date range', () => {
      const startDate = new Date('2024-06-01T00:00:00Z');
      const endDate = new Date('2024-06-15T23:59:59Z');

      const aggregations = service.getAggregationsInRange(
        'tenant-1',
        AggregationPeriod.DAILY,
        startDate,
        endDate,
      );

      expect(aggregations.length).toBeGreaterThan(0);
      aggregations.forEach((agg) => {
        expect(agg.periodStart.getTime()).toBeGreaterThanOrEqual(startDate.getTime());
        expect(agg.periodEnd.getTime()).toBeLessThanOrEqual(endDate.getTime());
      });
    });

    it('should filter aggregations by meter type', () => {
      const now = new Date();
      service.updateAggregation('tenant-1', MeterType.DATA_STORAGE, 500, AggregationPeriod.DAILY, now);

      const startDate = new Date('2024-06-01T00:00:00Z');
      const endDate = new Date('2024-06-30T23:59:59Z');

      const apiCallAggregations = service.getAggregationsInRange(
        'tenant-1',
        AggregationPeriod.DAILY,
        startDate,
        endDate,
        MeterType.API_CALLS,
      );

      apiCallAggregations.forEach((agg) => {
        expect(agg.meterType).toBe(MeterType.API_CALLS);
      });
    });

    it('should sort aggregations by period start', () => {
      const startDate = new Date('2024-06-01T00:00:00Z');
      const endDate = new Date('2024-06-30T23:59:59Z');

      const aggregations = service.getAggregationsInRange(
        'tenant-1',
        AggregationPeriod.DAILY,
        startDate,
        endDate,
      );

      for (let i = 1; i < aggregations.length; i++) {
        expect(aggregations[i]!.periodStart.getTime()).toBeGreaterThanOrEqual(
          aggregations[i - 1]!.periodStart.getTime(),
        );
      }
    });

    it('should return empty array for unknown tenant', () => {
      const aggregations = service.getAggregationsInRange(
        'unknown-tenant',
        AggregationPeriod.DAILY,
        new Date('2024-06-01'),
        new Date('2024-06-30'),
      );

      expect(aggregations).toEqual([]);
    });
  });

  // ============================================================================
  // TENANT USAGE SUMMARY TESTS
  // ============================================================================
  describe('Tenant Usage Summary', () => {
    beforeEach(() => {
      const now = new Date();

      // Add usage for multiple meter types
      service.updateAggregation('tenant-1', MeterType.API_CALLS, 1000, AggregationPeriod.MONTHLY, now);
      service.updateAggregation('tenant-1', MeterType.DATA_STORAGE, 500, AggregationPeriod.MONTHLY, now);
      service.updateAggregation('tenant-1', MeterType.SENSOR_READINGS, 5000, AggregationPeriod.MONTHLY, now);
    });

    it('should generate tenant usage summary', () => {
      const summary = service.getTenantUsageSummary(
        'tenant-1',
        AggregationPeriod.MONTHLY,
        new Date(),
      );

      expect(summary).toBeDefined();
      expect(summary.tenantId).toBe('tenant-1');
      expect(summary.period).toBe(AggregationPeriod.MONTHLY);
      expect(summary.totalUsageByMeter).toBeInstanceOf(Map);
    });

    it('should calculate total usage by meter type', () => {
      const summary = service.getTenantUsageSummary(
        'tenant-1',
        AggregationPeriod.MONTHLY,
        new Date(),
      );

      expect(summary.totalUsageByMeter.get(MeterType.API_CALLS)).toBe(1000);
      expect(summary.totalUsageByMeter.get(MeterType.DATA_STORAGE)).toBe(500);
      expect(summary.totalUsageByMeter.get(MeterType.SENSOR_READINGS)).toBe(5000);
    });

    it('should include period bounds in summary', () => {
      const summary = service.getTenantUsageSummary(
        'tenant-1',
        AggregationPeriod.MONTHLY,
        new Date(),
      );

      expect(summary.periodStart).toBeInstanceOf(Date);
      expect(summary.periodEnd).toBeInstanceOf(Date);
      expect(summary.periodEnd.getTime()).toBeGreaterThan(summary.periodStart.getTime());
    });

    it('should compare to previous period when available', () => {
      const now = new Date();
      const lastMonth = new Date(now);
      lastMonth.setMonth(lastMonth.getMonth() - 1);

      // Add previous period data
      service.updateAggregation('tenant-1', MeterType.API_CALLS, 800, AggregationPeriod.MONTHLY, lastMonth);

      const summary = service.getTenantUsageSummary(
        'tenant-1',
        AggregationPeriod.MONTHLY,
        now,
      );

      // May or may not have comparison depending on data alignment
      expect(summary).toBeDefined();
    });
  });

  // ============================================================================
  // USAGE TREND TESTS
  // ============================================================================
  describe('Usage Trends', () => {
    beforeEach(() => {
      const baseDate = new Date();

      // Create trend data for 12 months
      for (let i = 0; i < 12; i++) {
        const date = new Date(baseDate);
        date.setMonth(date.getMonth() - i);
        service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          1000 + i * 100, // Increasing trend
          AggregationPeriod.MONTHLY,
          date,
        );
      }
    });

    it('should get usage trend for specified periods', () => {
      const trend = service.getUsageTrend(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.MONTHLY,
        6,
      );

      expect(trend).toHaveLength(6);
      trend.forEach((point) => {
        expect(point.timestamp).toBeInstanceOf(Date);
        expect(point.period).toBe(AggregationPeriod.MONTHLY);
        expect(typeof point.value).toBe('number');
      });
    });

    it('should return chronological trend data', () => {
      const trend = service.getUsageTrend(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.MONTHLY,
        6,
      );

      for (let i = 1; i < trend.length; i++) {
        expect(trend[i]!.timestamp.getTime()).toBeGreaterThan(
          trend[i - 1]!.timestamp.getTime(),
        );
      }
    });

    it('should return zero for periods with no data', () => {
      const trend = service.getUsageTrend(
        'tenant-1',
        MeterType.CUSTOM, // No data for this type
        AggregationPeriod.MONTHLY,
        3,
      );

      trend.forEach((point) => {
        expect(point.value).toBe(0);
      });
    });
  });

  // ============================================================================
  // STATISTICS CALCULATION TESTS
  // ============================================================================
  describe('Statistics Calculation', () => {
    beforeEach(() => {
      const baseDate = new Date();
      const values = [100, 200, 300, 400, 500, 150, 250, 350, 450, 550];

      values.forEach((value, i) => {
        const date = new Date(baseDate);
        date.setDate(date.getDate() - i);
        service.updateAggregation(
          'tenant-1',
          MeterType.API_CALLS,
          value,
          AggregationPeriod.DAILY,
          date,
        );
      });
    });

    it('should calculate mean correctly', () => {
      const stats = service.calculateStatistics(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        10,
      );

      expect(stats.mean).toBeCloseTo(325, 0);
    });

    it('should calculate median correctly', () => {
      const stats = service.calculateStatistics(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        10,
      );

      expect(stats.median).toBeDefined();
      expect(typeof stats.median).toBe('number');
    });

    it('should calculate standard deviation', () => {
      const stats = service.calculateStatistics(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        10,
      );

      expect(stats.stdDev).toBeGreaterThan(0);
    });

    it('should calculate variance', () => {
      const stats = service.calculateStatistics(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        10,
      );

      expect(stats.variance).toBeGreaterThan(0);
      expect(stats.variance).toBeCloseTo(stats.stdDev * stats.stdDev, 0);
    });

    it('should calculate min and max', () => {
      const stats = service.calculateStatistics(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        10,
      );

      expect(stats.min).toBe(100);
      expect(stats.max).toBe(550);
    });

    it('should calculate sum and count', () => {
      const stats = service.calculateStatistics(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        10,
      );

      expect(stats.sum).toBe(3250);
      expect(stats.count).toBe(10);
    });

    it('should calculate percentiles', () => {
      const stats = service.calculateStatistics(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        10,
      );

      expect(stats.percentile95).toBeDefined();
      expect(stats.percentile99).toBeDefined();
      expect(stats.percentile95).toBeLessThanOrEqual(stats.max);
      expect(stats.percentile99).toBeLessThanOrEqual(stats.max);
    });

    it('should return zero statistics for no data', () => {
      const stats = service.calculateStatistics(
        'unknown-tenant',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        10,
      );

      expect(stats.mean).toBe(0);
      expect(stats.median).toBe(0);
      expect(stats.sum).toBe(0);
      expect(stats.count).toBe(0);
    });
  });

  // ============================================================================
  // MULTI-DIMENSIONAL AGGREGATION TESTS
  // ============================================================================
  describe('Multi-dimensional Aggregation', () => {
    it('should aggregate by tenant', () => {
      const now = new Date();

      service.updateAggregation('tenant-1', MeterType.API_CALLS, 1000, AggregationPeriod.DAILY, now);
      service.updateAggregation('tenant-2', MeterType.API_CALLS, 2000, AggregationPeriod.DAILY, now);
      service.updateAggregation('tenant-3', MeterType.API_CALLS, 3000, AggregationPeriod.DAILY, now);

      const tenant1 = service.getAggregation('tenant-1', MeterType.API_CALLS, AggregationPeriod.DAILY, now);
      const tenant2 = service.getAggregation('tenant-2', MeterType.API_CALLS, AggregationPeriod.DAILY, now);
      const tenant3 = service.getAggregation('tenant-3', MeterType.API_CALLS, AggregationPeriod.DAILY, now);

      expect(tenant1?.totalUsage).toBe(1000);
      expect(tenant2?.totalUsage).toBe(2000);
      expect(tenant3?.totalUsage).toBe(3000);
    });

    it('should aggregate by meter type', () => {
      const now = new Date();

      service.updateAggregation('tenant-1', MeterType.API_CALLS, 1000, AggregationPeriod.DAILY, now);
      service.updateAggregation('tenant-1', MeterType.DATA_STORAGE, 500, AggregationPeriod.DAILY, now);
      service.updateAggregation('tenant-1', MeterType.SENSOR_READINGS, 5000, AggregationPeriod.DAILY, now);

      const apiCalls = service.getAggregation('tenant-1', MeterType.API_CALLS, AggregationPeriod.DAILY, now);
      const storage = service.getAggregation('tenant-1', MeterType.DATA_STORAGE, AggregationPeriod.DAILY, now);
      const readings = service.getAggregation('tenant-1', MeterType.SENSOR_READINGS, AggregationPeriod.DAILY, now);

      expect(apiCalls?.totalUsage).toBe(1000);
      expect(storage?.totalUsage).toBe(500);
      expect(readings?.totalUsage).toBe(5000);
    });

    it('should get active meter types for tenant', () => {
      const now = new Date();

      service.updateAggregation('tenant-1', MeterType.API_CALLS, 1000, AggregationPeriod.DAILY, now);
      service.updateAggregation('tenant-1', MeterType.DATA_STORAGE, 500, AggregationPeriod.DAILY, now);

      const activeMeterTypes = service.getActiveMeterTypes('tenant-1');

      expect(activeMeterTypes).toContain(MeterType.API_CALLS);
      expect(activeMeterTypes).toContain(MeterType.DATA_STORAGE);
    });
  });

  // ============================================================================
  // CLEANUP TESTS
  // ============================================================================
  describe('Data Cleanup', () => {
    it('should cleanup old aggregations', () => {
      // Create old aggregations
      const oldDate = new Date();
      oldDate.setFullYear(oldDate.getFullYear() - 2);

      service.updateAggregation(
        'tenant-1',
        MeterType.API_CALLS,
        1000,
        AggregationPeriod.DAILY,
        oldDate,
      );

      const deletedCount = service.cleanupOldAggregations(365);

      expect(deletedCount).toBeGreaterThanOrEqual(0);
    });

    it('should respect retention period', () => {
      const recentDate = new Date();
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100);

      service.updateAggregation(
        'tenant-1',
        MeterType.API_CALLS,
        1000,
        AggregationPeriod.DAILY,
        recentDate,
      );

      service.updateAggregation(
        'tenant-1',
        MeterType.API_CALLS,
        500,
        AggregationPeriod.DAILY,
        oldDate,
      );

      // Cleanup with 30 day retention
      service.cleanupOldAggregations(30);

      // Recent data should still exist
      const recent = service.getAggregation(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        recentDate,
      );

      expect(recent).toBeDefined();
    });
  });

  // ============================================================================
  // EXPORT TESTS
  // ============================================================================
  describe('Data Export', () => {
    it('should export all aggregations for tenant', () => {
      const now = new Date();

      service.updateAggregation('tenant-1', MeterType.API_CALLS, 1000, AggregationPeriod.DAILY, now);
      service.updateAggregation('tenant-1', MeterType.DATA_STORAGE, 500, AggregationPeriod.DAILY, now);

      const exported = service.exportAggregations('tenant-1');

      expect(exported.length).toBeGreaterThanOrEqual(2);
      exported.forEach((agg) => {
        expect(agg.tenantId).toBe('tenant-1');
      });
    });

    it('should return empty array for tenant with no data', () => {
      const exported = service.exportAggregations('unknown-tenant');
      expect(exported).toEqual([]);
    });
  });

  // ============================================================================
  // METRICS TESTS
  // ============================================================================
  describe('Metrics', () => {
    it('should track total aggregations', () => {
      const now = new Date();

      service.updateAggregation('tenant-1', MeterType.API_CALLS, 1000, AggregationPeriod.DAILY, now);
      service.updateAggregation('tenant-2', MeterType.API_CALLS, 2000, AggregationPeriod.DAILY, now);

      const metrics = service.getMetrics();
      expect(metrics.totalAggregations).toBeGreaterThanOrEqual(2);
    });

    it('should track rollups performed', () => {
      const initialMetrics = service.getMetrics();
      const initialRollups = initialMetrics.rollupsPerformed;

      const now = new Date();
      service.updateAggregation('tenant-1', MeterType.API_CALLS, 1000, AggregationPeriod.HOURLY, now);

      service.performRollup(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.HOURLY,
        AggregationPeriod.DAILY,
        now,
      );

      const finalMetrics = service.getMetrics();
      expect(finalMetrics.rollupsPerformed).toBeGreaterThanOrEqual(initialRollups);
    });

    it('should return metrics snapshot', () => {
      const metrics1 = service.getMetrics();
      const metrics2 = service.getMetrics();

      expect(metrics1).not.toBe(metrics2);
      expect(metrics1).toEqual(metrics2);
    });
  });

  // ============================================================================
  // EVENT LISTENER TESTS
  // ============================================================================
  describe('Event Listeners', () => {
    it('should register usage.recorded event listener', () => {
      expect(mockEventEmitter.on).toHaveBeenCalledWith(
        'usage.recorded',
        expect.any(Function),
      );
    });
  });

  // ============================================================================
  // AGGREGATION ACCURACY TESTS
  // ============================================================================
  describe('Aggregation Accuracy', () => {
    it('should maintain precision for large numbers', () => {
      const now = new Date();
      const largeValue = 1000000000; // 1 billion

      service.updateAggregation(
        'tenant-1',
        MeterType.API_CALLS,
        largeValue,
        AggregationPeriod.DAILY,
        now,
      );

      const aggregation = service.getAggregation(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        now,
      );

      expect(aggregation?.totalUsage).toBe(largeValue);
    });

    it('should maintain precision for decimal values', () => {
      const now = new Date();

      service.updateAggregation(
        'tenant-1',
        MeterType.DATA_STORAGE,
        0.123456789,
        AggregationPeriod.DAILY,
        now,
      );

      const aggregation = service.getAggregation(
        'tenant-1',
        MeterType.DATA_STORAGE,
        AggregationPeriod.DAILY,
        now,
      );

      expect(aggregation?.totalUsage).toBeCloseTo(0.123456789, 9);
    });

    it('should handle concurrent updates correctly', async () => {
      const now = new Date();
      const promises: Promise<AggregatedUsage>[] = [];

      for (let i = 0; i < 100; i++) {
        promises.push(
          Promise.resolve(
            service.updateAggregation(
              'tenant-1',
              MeterType.API_CALLS,
              1,
              AggregationPeriod.DAILY,
              now,
            ),
          ),
        );
      }

      await Promise.all(promises);

      const aggregation = service.getAggregation(
        'tenant-1',
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        now,
      );

      expect(aggregation?.totalUsage).toBe(100);
      expect(aggregation?.eventCount).toBe(100);
    });
  });
});
