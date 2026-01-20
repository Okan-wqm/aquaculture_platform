import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  UsageMeteringService,
  MeterType,
  UsageEvent,
  MeterConfig,
  MeterReading,
  UsageThreshold,
  ThresholdBreachEvent,
} from '../usage-metering.service';

describe('UsageMeteringService', () => {
  let service: UsageMeteringService;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const mockEventEmitter = {
    emit: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
  };

  beforeEach(async () => {
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsageMeteringService,
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
      ],
    }).compile();

    service = module.get<UsageMeteringService>(UsageMeteringService);
    eventEmitter = module.get(EventEmitter2);

    // Initialize service
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  // ============================================================================
  // EVENT CAPTURE TESTS
  // ============================================================================
  describe('Event Capture', () => {
    describe('Basic Event Recording', () => {
      it('should record usage event successfully', () => {
        const event = service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 100,
          unit: 'calls',
        });

        expect(event).toBeDefined();
        expect(event.id).toBeDefined();
        expect(event.tenantId).toBe('tenant-1');
        expect(event.meterType).toBe(MeterType.API_CALLS);
        expect(event.quantity).toBe(100);
        expect(event.unit).toBe('calls');
        expect(event.timestamp).toBeInstanceOf(Date);
      });

      it('should store event metadata correctly', () => {
        const metadata = {
          endpoint: '/api/v1/users',
          method: 'GET',
          statusCode: 200,
        };

        const event = service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 1,
          unit: 'calls',
          metadata,
        });

        expect(event.metadata).toEqual(metadata);
      });

      it('should record timestamp in UTC format', () => {
        const beforeRecord = new Date();
        const event = service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 1,
          unit: 'calls',
        });
        const afterRecord = new Date();

        expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(beforeRecord.getTime());
        expect(event.timestamp.getTime()).toBeLessThanOrEqual(afterRecord.getTime());
      });

      it('should associate tenant ID correctly', () => {
        const tenantIds = ['tenant-1', 'tenant-2', 'tenant-3'];

        tenantIds.forEach((tenantId) => {
          const event = service.recordUsage({
            tenantId,
            meterType: MeterType.API_CALLS,
            quantity: 10,
            unit: 'calls',
          });
          expect(event.tenantId).toBe(tenantId);
        });
      });

      it('should associate user ID correctly', () => {
        const event = service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 1,
          unit: 'calls',
          userId: 'user-123',
        });

        expect(event.userId).toBe('user-123');
      });

      it('should label resource type correctly', () => {
        const event = service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.DATA_STORAGE,
          quantity: 100,
          unit: 'MB',
          resourceId: 'bucket-123',
        });

        expect(event.meterType).toBe(MeterType.DATA_STORAGE);
        expect(event.resourceId).toBe('bucket-123');
      });

      it('should record quantity correctly', () => {
        const quantities = [1, 10, 100, 1000, 0.5, 0.001];

        quantities.forEach((quantity) => {
          const event = service.recordUsage({
            tenantId: 'tenant-1',
            meterType: MeterType.DATA_STORAGE,
            quantity,
            unit: 'GB',
          });
          expect(event.quantity).toBe(quantity);
        });
      });

      it('should handle different unit types correctly', () => {
        const units = [
          { type: MeterType.API_CALLS, unit: 'calls' },
          { type: MeterType.DATA_STORAGE, unit: 'GB' },
          { type: MeterType.SENSOR_READINGS, unit: 'readings' },
          { type: MeterType.USERS_ACTIVE, unit: 'users' },
        ];

        units.forEach(({ type, unit }) => {
          const event = service.recordUsage({
            tenantId: 'tenant-1',
            meterType: type,
            quantity: 10,
            unit,
          });
          expect(event.unit).toBe(unit);
        });
      });
    });

    describe('Idempotency', () => {
      it('should prevent event duplication with idempotency key', () => {
        const idempotencyKey = 'unique-key-123';

        // First event
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 100,
          unit: 'calls',
          idempotencyKey,
        });

        // Flush to process
        jest.advanceTimersByTime(5000);

        // Duplicate event with same idempotency key
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 100,
          unit: 'calls',
          idempotencyKey,
        });

        jest.advanceTimersByTime(5000);

        const metrics = service.getMetrics();
        expect(metrics.duplicateEventsSkipped).toBeGreaterThan(0);
      });

      it('should allow events without idempotency key', () => {
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 100,
          unit: 'calls',
        });

        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 100,
          unit: 'calls',
        });

        jest.advanceTimersByTime(5000);

        const metrics = service.getMetrics();
        expect(metrics.totalEventsReceived).toBe(2);
      });

      it('should generate unique event IDs', () => {
        const events: UsageEvent[] = [];

        for (let i = 0; i < 100; i++) {
          events.push(
            service.recordUsage({
              tenantId: 'tenant-1',
              meterType: MeterType.API_CALLS,
              quantity: 1,
              unit: 'calls',
            }),
          );
        }

        const uniqueIds = new Set(events.map((e) => e.id));
        expect(uniqueIds.size).toBe(100);
      });
    });

    describe('Concurrent Event Capture', () => {
      it('should handle concurrent event capture correctly', async () => {
        const promises = Array.from({ length: 100 }, (_, i) =>
          Promise.resolve(
            service.recordUsage({
              tenantId: 'tenant-1',
              meterType: MeterType.API_CALLS,
              quantity: 1,
              unit: 'calls',
              idempotencyKey: `event-${i}`,
            }),
          ),
        );

        await Promise.all(promises);
        jest.advanceTimersByTime(5000);

        const metrics = service.getMetrics();
        expect(metrics.totalEventsReceived).toBe(100);
      });
    });

    describe('Batch Event Processing', () => {
      it('should process batch events correctly', () => {
        const events = Array.from({ length: 50 }, (_, i) => ({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 10,
          unit: 'calls',
          idempotencyKey: `batch-${i}`,
        }));

        const batch = service.recordUsageBatch(events);

        expect(batch).toBeDefined();
        expect(batch.batchId).toBeDefined();
        expect(batch.events.length).toBe(50);
        expect(batch.timestamp).toBeInstanceOf(Date);
      });

      it('should track batch processing metrics', () => {
        const events = Array.from({ length: 10 }, () => ({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 1,
          unit: 'calls',
        }));

        service.recordUsageBatch(events);
        service.recordUsageBatch(events);

        const metrics = service.getMetrics();
        expect(metrics.batchesProcessed).toBe(2);
      });
    });

    describe('Invalid Event Handling', () => {
      it('should handle zero quantity', () => {
        const event = service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 0,
          unit: 'calls',
        });

        expect(event.quantity).toBe(0);
      });

      it('should handle very large quantities', () => {
        const event = service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: Number.MAX_SAFE_INTEGER,
          unit: 'calls',
        });

        expect(event.quantity).toBe(Number.MAX_SAFE_INTEGER);
      });

      it('should handle decimal quantities', () => {
        const event = service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.DATA_STORAGE,
          quantity: 0.123456789,
          unit: 'GB',
        });

        expect(event.quantity).toBe(0.123456789);
      });
    });

    describe('Event Buffer Management', () => {
      it('should flush buffer periodically', () => {
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 100,
          unit: 'calls',
        });

        // Advance timer to trigger flush
        jest.advanceTimersByTime(5000);

        const metrics = service.getMetrics();
        expect(metrics.totalEventsProcessed).toBeGreaterThan(0);
      });

      it('should flush immediately when buffer is full', () => {
        // Record more than maxBufferSize events
        for (let i = 0; i < 1001; i++) {
          service.recordUsage({
            tenantId: 'tenant-1',
            meterType: MeterType.API_CALLS,
            quantity: 1,
            unit: 'calls',
          });
        }

        const metrics = service.getMetrics();
        expect(metrics.totalEventsProcessed).toBeGreaterThan(0);
      });
    });
  });

  // ============================================================================
  // METER MANAGEMENT TESTS
  // ============================================================================
  describe('Meter Management', () => {
    describe('Meter Configuration', () => {
      it('should register meter configuration', () => {
        const config: MeterConfig = {
          meterType: MeterType.CUSTOM,
          resetPeriod: 'daily',
          unit: 'custom_units',
          allowOverage: true,
          overageRate: 0.05,
        };

        service.registerMeterConfig(config);
        const retrieved = service.getMeterConfig(MeterType.CUSTOM);

        expect(retrieved).toEqual(config);
      });

      it('should have default configurations for standard meter types', () => {
        const standardTypes = [
          MeterType.API_CALLS,
          MeterType.DATA_STORAGE,
          MeterType.SENSOR_READINGS,
          MeterType.ALERTS_SENT,
        ];

        standardTypes.forEach((type) => {
          const config = service.getMeterConfig(type);
          expect(config).toBeDefined();
          expect(config?.meterType).toBe(type);
        });
      });

      it('should update existing meter configuration', () => {
        const initialConfig: MeterConfig = {
          meterType: MeterType.CUSTOM,
          resetPeriod: 'daily',
          unit: 'units',
        };

        const updatedConfig: MeterConfig = {
          meterType: MeterType.CUSTOM,
          resetPeriod: 'monthly',
          unit: 'new_units',
          allowOverage: true,
        };

        service.registerMeterConfig(initialConfig);
        service.registerMeterConfig(updatedConfig);

        const retrieved = service.getMeterConfig(MeterType.CUSTOM);
        expect(retrieved?.resetPeriod).toBe('monthly');
        expect(retrieved?.unit).toBe('new_units');
      });
    });

    describe('Meter Readings', () => {
      it('should get meter reading for tenant', () => {
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 100,
          unit: 'calls',
        });

        jest.advanceTimersByTime(5000);

        const reading = service.getMeterReading('tenant-1', MeterType.API_CALLS);
        expect(reading).toBeDefined();
        expect(reading?.currentValue).toBe(100);
      });

      it('should get all meter readings for tenant', () => {
        // Record different meter types
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 100,
          unit: 'calls',
        });

        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.DATA_STORAGE,
          quantity: 50,
          unit: 'GB',
        });

        jest.advanceTimersByTime(5000);

        const readings = service.getAllMeterReadings('tenant-1');
        expect(readings.length).toBeGreaterThanOrEqual(2);
      });

      it('should return empty array for unknown tenant', () => {
        const readings = service.getAllMeterReadings('unknown-tenant');
        expect(readings).toEqual([]);
      });

      it('should accumulate meter values correctly', () => {
        for (let i = 0; i < 10; i++) {
          service.recordUsage({
            tenantId: 'tenant-1',
            meterType: MeterType.API_CALLS,
            quantity: 10,
            unit: 'calls',
          });
        }

        jest.advanceTimersByTime(5000);

        const reading = service.getMeterReading('tenant-1', MeterType.API_CALLS);
        expect(reading?.currentValue).toBe(100);
        expect(reading?.eventCount).toBe(10);
      });
    });

    describe('Meter Limits', () => {
      it('should set meter limit', () => {
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 50,
          unit: 'calls',
        });

        jest.advanceTimersByTime(5000);

        service.setMeterLimit('tenant-1', MeterType.API_CALLS, 1000);

        const reading = service.getMeterReading('tenant-1', MeterType.API_CALLS);
        expect(reading?.limit).toBe(1000);
        expect(reading?.percentageUsed).toBe(5);
      });

      it('should check if usage is within limits', () => {
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 500,
          unit: 'calls',
        });

        jest.advanceTimersByTime(5000);

        service.setMeterLimit('tenant-1', MeterType.API_CALLS, 1000);
        expect(service.isWithinLimits('tenant-1', MeterType.API_CALLS)).toBe(true);

        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 600,
          unit: 'calls',
        });

        jest.advanceTimersByTime(5000);

        expect(service.isWithinLimits('tenant-1', MeterType.API_CALLS)).toBe(false);
      });

      it('should calculate remaining usage', () => {
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 300,
          unit: 'calls',
        });

        jest.advanceTimersByTime(5000);

        service.setMeterLimit('tenant-1', MeterType.API_CALLS, 1000);

        const remaining = service.getRemainingUsage('tenant-1', MeterType.API_CALLS);
        expect(remaining).toBe(700);
      });

      it('should return null for remaining usage when no limit set', () => {
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 100,
          unit: 'calls',
        });

        jest.advanceTimersByTime(5000);

        const remaining = service.getRemainingUsage('tenant-1', MeterType.API_CALLS);
        expect(remaining).toBeNull();
      });
    });
  });

  // ============================================================================
  // METER RESET TESTS
  // ============================================================================
  describe('Meter Reset', () => {
    beforeEach(() => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 500,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);
    });

    it('should reset single meter', () => {
      const beforeReset = service.getMeterReading('tenant-1', MeterType.API_CALLS);
      expect(beforeReset?.currentValue).toBe(500);

      service.resetMeter('tenant-1', MeterType.API_CALLS, 'Monthly reset');

      const afterReset = service.getMeterReading('tenant-1', MeterType.API_CALLS);
      expect(afterReset?.currentValue).toBe(0);
      expect(afterReset?.eventCount).toBe(0);
    });

    it('should emit meter reset event', () => {
      service.resetMeter('tenant-1', MeterType.API_CALLS, 'Test reset');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'usage.meter.reset',
        expect.objectContaining({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          previousValue: 500,
          reason: 'Test reset',
        }),
      );
    });

    it('should reset all meters for tenant', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.DATA_STORAGE,
        quantity: 100,
        unit: 'GB',
      });
      jest.advanceTimersByTime(5000);

      service.resetAllMeters('tenant-1', 'Billing cycle reset');

      const readings = service.getAllMeterReadings('tenant-1');
      readings.forEach((reading) => {
        expect(reading.currentValue).toBe(0);
      });
    });

    it('should reset percentage used after reset', () => {
      service.setMeterLimit('tenant-1', MeterType.API_CALLS, 1000);

      const beforeReset = service.getMeterReading('tenant-1', MeterType.API_CALLS);
      expect(beforeReset?.percentageUsed).toBe(50);

      service.resetMeter('tenant-1', MeterType.API_CALLS);

      const afterReset = service.getMeterReading('tenant-1', MeterType.API_CALLS);
      expect(afterReset?.percentageUsed).toBe(0);
    });

    it('should update period bounds after reset', () => {
      const beforeReset = service.getMeterReading('tenant-1', MeterType.API_CALLS);
      const originalStart = beforeReset?.periodStart;

      service.resetMeter('tenant-1', MeterType.API_CALLS);

      const afterReset = service.getMeterReading('tenant-1', MeterType.API_CALLS);
      expect(afterReset?.periodStart).toBeDefined();
    });

    it('should handle reset for non-existent tenant gracefully', () => {
      const result = service.resetMeter('non-existent-tenant', MeterType.API_CALLS);
      expect(result).toBeUndefined();
    });

    it('should handle reset for non-existent meter gracefully', () => {
      const result = service.resetMeter('tenant-1', MeterType.CUSTOM);
      expect(result).toBeUndefined();
    });
  });

  // ============================================================================
  // USAGE THRESHOLD TESTS
  // ============================================================================
  describe('Usage Thresholds', () => {
    beforeEach(() => {
      service.setMeterLimit('tenant-1', MeterType.API_CALLS, 1000);
    });

    it('should detect threshold breach at 50%', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 500,
        unit: 'calls',
      });

      jest.advanceTimersByTime(5000);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'usage.threshold.breached',
        expect.objectContaining({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          threshold: expect.objectContaining({ percentage: 50 }),
        }),
      );
    });

    it('should detect threshold breach at 75%', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 750,
        unit: 'calls',
      });

      jest.advanceTimersByTime(5000);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'usage.threshold.breached',
        expect.objectContaining({
          threshold: expect.objectContaining({ percentage: 75 }),
        }),
      );
    });

    it('should detect threshold breach at 90%', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 900,
        unit: 'calls',
      });

      jest.advanceTimersByTime(5000);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'usage.threshold.breached',
        expect.objectContaining({
          threshold: expect.objectContaining({ percentage: 90 }),
        }),
      );
    });

    it('should detect threshold breach at 100%', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 1000,
        unit: 'calls',
      });

      jest.advanceTimersByTime(5000);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'usage.threshold.breached',
        expect.objectContaining({
          threshold: expect.objectContaining({ percentage: 100 }),
        }),
      );
    });

    it('should not re-emit breach for same threshold level', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 500,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      const breachCallsAfterFirst = mockEventEmitter.emit.mock.calls.filter(
        (call) => call[0] === 'usage.threshold.breached',
      ).length;

      // Add more usage that doesn't cross new threshold
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 100,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      const breachCallsAfterSecond = mockEventEmitter.emit.mock.calls.filter(
        (call) => call[0] === 'usage.threshold.breached',
      ).length;

      // Should not emit new breach for 50% threshold
      expect(breachCallsAfterSecond).toBe(breachCallsAfterFirst);
    });

    it('should track threshold breach metrics', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 1000,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      const metrics = service.getMetrics();
      expect(metrics.thresholdBreaches).toBeGreaterThan(0);
    });

    it('should reset breached thresholds after meter reset', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 500,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      service.resetMeter('tenant-1', MeterType.API_CALLS);

      // Record usage to breach 50% again
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 500,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      // Should emit breach again after reset
      const breachCalls = mockEventEmitter.emit.mock.calls.filter(
        (call) =>
          call[0] === 'usage.threshold.breached' &&
          call[1].threshold.percentage === 50,
      );
      expect(breachCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ============================================================================
  // OVERAGE TESTS
  // ============================================================================
  describe('Overage Calculation', () => {
    beforeEach(() => {
      service.setMeterLimit('tenant-1', MeterType.API_CALLS, 1000);
    });

    it('should calculate overage correctly', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 1500,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      const overage = service.getOverage('tenant-1', MeterType.API_CALLS);
      expect(overage).toBe(500);
    });

    it('should return zero overage when within limit', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 800,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      const overage = service.getOverage('tenant-1', MeterType.API_CALLS);
      expect(overage).toBe(0);
    });

    it('should calculate overage cost', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 1500,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      const cost = service.getOverageCost('tenant-1', MeterType.API_CALLS);
      // 500 overage * 0.001 overage rate = 0.5
      expect(cost).toBe(0.5);
    });

    it('should return zero overage cost when no overage', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 800,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      const cost = service.getOverageCost('tenant-1', MeterType.API_CALLS);
      expect(cost).toBe(0);
    });
  });

  // ============================================================================
  // USAGE SUMMARY TESTS
  // ============================================================================
  describe('Usage Summary', () => {
    it('should get usage summary for tenant', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 1500,
        unit: 'calls',
      });
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.DATA_STORAGE,
        quantity: 50,
        unit: 'GB',
      });
      jest.advanceTimersByTime(5000);

      service.setMeterLimit('tenant-1', MeterType.API_CALLS, 1000);

      const summary = service.getUsageSummary('tenant-1');

      expect(summary.meters.length).toBeGreaterThanOrEqual(2);
      expect(summary.metersOverLimit).toContain(MeterType.API_CALLS);
      expect(summary.totalOverageCost).toBeGreaterThan(0);
    });

    it('should identify meters at limit', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 1000,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      service.setMeterLimit('tenant-1', MeterType.API_CALLS, 1000);

      const summary = service.getUsageSummary('tenant-1');
      expect(summary.metersAtLimit).toContain(MeterType.API_CALLS);
    });

    it('should export usage data', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 100,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      const exported = service.exportUsageData('tenant-1');

      expect(exported.tenantId).toBe('tenant-1');
      expect(exported.exportedAt).toBeInstanceOf(Date);
      expect(exported.meters.length).toBeGreaterThan(0);
      expect(exported.configs.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // METRICS TESTS
  // ============================================================================
  describe('Metrics', () => {
    it('should track total events received', () => {
      for (let i = 0; i < 10; i++) {
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 1,
          unit: 'calls',
        });
      }

      const metrics = service.getMetrics();
      expect(metrics.totalEventsReceived).toBe(10);
    });

    it('should track total events processed', () => {
      for (let i = 0; i < 10; i++) {
        service.recordUsage({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 1,
          unit: 'calls',
        });
      }
      jest.advanceTimersByTime(5000);

      const metrics = service.getMetrics();
      expect(metrics.totalEventsProcessed).toBe(10);
    });

    it('should track duplicate events skipped', () => {
      const idempotencyKey = 'duplicate-key';

      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 1,
        unit: 'calls',
        idempotencyKey,
      });
      jest.advanceTimersByTime(5000);

      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 1,
        unit: 'calls',
        idempotencyKey,
      });

      const metrics = service.getMetrics();
      expect(metrics.duplicateEventsSkipped).toBe(1);
    });

    it('should track error count', () => {
      const metrics = service.getMetrics();
      expect(metrics.errors).toBeDefined();
    });

    it('should return metrics snapshot (not reference)', () => {
      const metrics1 = service.getMetrics();
      const metrics2 = service.getMetrics();

      expect(metrics1).not.toBe(metrics2);
      expect(metrics1).toEqual(metrics2);
    });
  });

  // ============================================================================
  // EVENT TYPES TESTS
  // ============================================================================
  describe('Event Types', () => {
    const meterTypes = [
      { type: MeterType.API_CALLS, unit: 'calls' },
      { type: MeterType.DATA_STORAGE, unit: 'GB' },
      { type: MeterType.SENSOR_READINGS, unit: 'readings' },
      { type: MeterType.ALERTS_SENT, unit: 'alerts' },
      { type: MeterType.REPORTS_GENERATED, unit: 'reports' },
      { type: MeterType.USERS_ACTIVE, unit: 'users' },
      { type: MeterType.FARMS_ACTIVE, unit: 'farms' },
      { type: MeterType.PONDS_ACTIVE, unit: 'ponds' },
      { type: MeterType.SENSORS_ACTIVE, unit: 'sensors' },
      { type: MeterType.DATA_EXPORT, unit: 'exports' },
      { type: MeterType.INTEGRATIONS, unit: 'integrations' },
      { type: MeterType.CUSTOM, unit: 'custom' },
    ];

    meterTypes.forEach(({ type, unit }) => {
      it(`should handle ${type} metering correctly`, () => {
        const event = service.recordUsage({
          tenantId: 'tenant-1',
          meterType: type,
          quantity: 100,
          unit,
        });

        expect(event.meterType).toBe(type);
        jest.advanceTimersByTime(5000);

        const reading = service.getMeterReading('tenant-1', type);
        expect(reading?.meterType).toBe(type);
      });
    });
  });

  // ============================================================================
  // REAL-TIME TRACKING TESTS
  // ============================================================================
  describe('Real-time Usage Tracking', () => {
    it('should emit usage recorded event', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 100,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'usage.recorded',
        expect.objectContaining({
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          quantity: 100,
        }),
      );
    });

    it('should track current value in real-time', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 50,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      let reading = service.getMeterReading('tenant-1', MeterType.API_CALLS);
      expect(reading?.currentValue).toBe(50);

      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 50,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      reading = service.getMeterReading('tenant-1', MeterType.API_CALLS);
      expect(reading?.currentValue).toBe(100);
    });

    it('should update lastUpdated timestamp', () => {
      service.recordUsage({
        tenantId: 'tenant-1',
        meterType: MeterType.API_CALLS,
        quantity: 100,
        unit: 'calls',
      });
      jest.advanceTimersByTime(5000);

      const reading = service.getMeterReading('tenant-1', MeterType.API_CALLS);
      expect(reading?.lastUpdated).toBeInstanceOf(Date);
    });
  });
});
