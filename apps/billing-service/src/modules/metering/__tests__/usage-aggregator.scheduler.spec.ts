/**
 * Metering rollup SCHEDULER wiring (Billing Revival Faz E).
 *
 * Before Faz E the metering rollup chain was dead: `performRollup` had zero
 * callers and every `RollupConfig.aggregateOnSchedule` flag was written but
 * never read. This suite pins the scheduler contract:
 *   - `runScheduledRollups` is registered hourly and runs under a lease.
 *   - `flushDirtyDataOnInterval` is registered every 30s and runs on EVERY
 *     replica, because the dirty aggregations it persists are in this
 *     process's memory (ADMIN-HIGH-013).
 *   - `runScheduledRollups` reads `rollupConfigs` and drives `performRollup`
 *     for the full hourly→daily→weekly/monthly chain.
 *   - the pass is idempotent and no-ops safely before any usage is ingested
 *     (usage-INGESTION remains a separate, tracked initiative).
 *
 * London-style: collaborators (DataSource / metering / event bus) are mocked;
 * the in-memory aggregation logic runs for real so the rollup chain is proven.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { UsageAggregatorService, AggregationPeriod } from '../usage-aggregator.service';
import { UsageMeteringService, MeterType } from '../usage-metering.service';
import { ScheduledJobRunner } from '@aquaculture/backend-common/scheduling';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';

// @nestjs/schedule attaches its decorator metadata through Nest's `SetMetadata`
// under these keys. The constants are the package's public decorator contract
// but are not re-exported from the entrypoint, so we reference the literals.
const SCHEDULE_CRON_OPTIONS = 'SCHEDULE_CRON_OPTIONS';
const SCHEDULE_INTERVAL_OPTIONS = 'SCHEDULE_INTERVAL_OPTIONS';

const scheduledJobs = createScheduledJobTestExecutor();

describe('UsageAggregatorService — scheduled rollup wiring (Faz E)', () => {
  let service: UsageAggregatorService;

  const mockUsageMeteringService = {
    getMeterConfig: jest.fn().mockReturnValue({ unit: 'calls' }),
  };
  const mockEventEmitter = {
    emit: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
  };
  const mockRepository = {
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((entity: unknown) => entity),
    upsert: jest.fn().mockResolvedValue(undefined),
  };
  const mockDataSource = {
    getRepository: jest.fn().mockReturnValue(mockRepository),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UsageAggregatorService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: UsageMeteringService, useValue: mockUsageMeteringService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: ScheduledJobRunner, useValue: scheduledJobs.executor },
      ],
    }).compile();

    service = moduleRef.get<UsageAggregatorService>(UsageAggregatorService);
    await service.onModuleInit();
  });

  afterEach(() => {
    jest.clearAllMocks();
    scheduledJobs.reset();
  });

  describe('schedule and lease registration', () => {
    it('registers runScheduledRollups hourly and runs it under a cluster lease', async () => {
      const cron = Reflect.getMetadata(
        SCHEDULE_CRON_OPTIONS,
        UsageAggregatorService.prototype.runScheduledRollups,
      );

      expect(cron).toBeDefined();
      expect(cron.cronTime).toBe(CronExpression.EVERY_HOUR);

      // The rollup rebuilds SHARED `usage_aggregations` rows, so exactly one
      // replica may run it — the schedule alone never guaranteed that.
      await service.runScheduledRollups();
      expect(scheduledJobs.entries).toEqual([
        { job: 'metering-aggregator.rollup', scope: 'cluster-single' },
      ]);
    });

    it('registers flushDirtyDataOnInterval every 30s and runs it on every replica', async () => {
      const interval = Reflect.getMetadata(
        SCHEDULE_INTERVAL_OPTIONS,
        UsageAggregatorService.prototype.flushDirtyDataOnInterval,
      );

      expect(interval).toBeDefined();
      expect(interval.timeout).toBe(30_000);

      // `each-replica`, deliberately: the dirty data is per-process, so a
      // leader-only tick would leave every other replica's aggregations
      // unpersisted — silent metering loss, not a skipped tick.
      await service.flushDirtyDataOnInterval();
      expect(scheduledJobs.entries).toEqual([
        { job: 'metering-aggregator.persist', scope: 'each-replica' },
      ]);
    });
  });

  describe('runScheduledRollups', () => {
    const TENANT = 'tenant-faz-e';

    /**
     * Seed three HOURLY buckets at fixed mid-day hours of *today* so they
     * always fall inside today's DAILY period regardless of the wall-clock
     * hour the test runs at. Returns the expected daily total.
     */
    const seedTodayHourlyBuckets = (): number => {
      const h10 = new Date();
      h10.setHours(10, 0, 0, 0);
      const h11 = new Date();
      h11.setHours(11, 0, 0, 0);
      const h12 = new Date();
      h12.setHours(12, 0, 0, 0);

      service.updateAggregation(TENANT, MeterType.API_CALLS, 100, AggregationPeriod.HOURLY, h10);
      service.updateAggregation(TENANT, MeterType.API_CALLS, 200, AggregationPeriod.HOURLY, h11);
      service.updateAggregation(TENANT, MeterType.API_CALLS, 50, AggregationPeriod.HOURLY, h12);

      return 350;
    };

    const todayNoon = (): Date => {
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      return noon;
    };

    it('drives performRollup for every configured rollup (hourly→daily→weekly/monthly)', () => {
      seedTodayHourlyBuckets();
      const spy = jest.spyOn(service, 'performRollup');

      service.runScheduledRollups();

      // rollupConfigs SSoT: HOURLY→DAILY, DAILY→WEEKLY, DAILY→MONTHLY.
      expect(spy).toHaveBeenCalledWith(
        TENANT,
        MeterType.API_CALLS,
        AggregationPeriod.HOURLY,
        AggregationPeriod.DAILY,
        expect.any(Date),
      );
      expect(spy).toHaveBeenCalledWith(
        TENANT,
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        AggregationPeriod.WEEKLY,
        expect.any(Date),
      );
      expect(spy).toHaveBeenCalledWith(
        TENANT,
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        AggregationPeriod.MONTHLY,
        expect.any(Date),
      );
    });

    it('materialises the daily rollup by summing the hourly buckets', () => {
      const expectedDaily = seedTodayHourlyBuckets();

      service.runScheduledRollups();

      const daily = service.getAggregation(
        TENANT,
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        todayNoon(),
      );
      expect(daily).toBeDefined();
      expect(daily?.totalUsage).toBe(expectedDaily);
    });

    it('is idempotent — repeated passes never double-count', () => {
      const expectedDaily = seedTodayHourlyBuckets();

      service.runScheduledRollups();
      service.runScheduledRollups();
      service.runScheduledRollups();

      const daily = service.getAggregation(
        TENANT,
        MeterType.API_CALLS,
        AggregationPeriod.DAILY,
        todayNoon(),
      );
      expect(daily?.totalUsage).toBe(expectedDaily);
    });

    it('no-ops safely when no usage has been ingested (ingestion not yet wired)', () => {
      const spy = jest.spyOn(service, 'performRollup');

      expect(() => service.runScheduledRollups()).not.toThrow();
      // Empty tenant index → performRollup is never invoked.
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
