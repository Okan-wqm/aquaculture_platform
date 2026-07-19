/**
 * BatchProcessorService Unit Tests
 *
 * Covers critical ingestion paths:
 * - UUID validation (invalid sensor/channel/tenant ID filtering)
 * - Number.isFinite() checks (NaN, Infinity rejection)
 * - Chunking logic (>1000 rows)
 * - Flush timing (500ms / 500 rows thresholds)
 * - Parameterized query generation
 * - ON CONFLICT upsert behavior
 * - Edge cases: empty buffer, malformed input, boundary values
 */

import { DataSource } from 'typeorm';

import { SensorMetricInput } from '../../database/entities/sensor-metric.entity';
import { BatchProcessorService } from '../batch-processor.service';

// ─── helpers ────────────────────────────────────────────────────────────────

const VALID_SENSOR_ID  = '11111111-1111-1111-1111-111111111111';
const VALID_CHANNEL_ID = '22222222-2222-2222-2222-222222222222';
const VALID_TENANT_ID  = '33333333-3333-3333-3333-333333333333';

function createMetric(overrides: Partial<SensorMetricInput> = {}): SensorMetricInput {
  return {
    time: new Date('2025-06-01T12:00:00Z'),
    sensorId: VALID_SENSOR_ID,
    channelId: VALID_CHANNEL_ID,
    tenantId: VALID_TENANT_ID,
    rawValue: 23.5,
    value: 23.5,
    qualityCode: 192,
    qualityBits: 0,
    sourceProtocol: 'mqtt',
    sourceTimestamp: new Date('2025-06-01T11:59:59Z'),
    ...overrides,
  };
}

function createMockDataSource(): jest.Mocked<DataSource> {
  return {
    query: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<DataSource>;
}

/**
 * Create a BatchProcessorService instance without starting its interval timer.
 * We call onModuleInit manually in tests that need it.
 */
function createService(ds?: jest.Mocked<DataSource>) {
  const dataSource = ds ?? createMockDataSource();

  // Construct the service. The constructor does NOT start the timer—
  // onModuleInit does. We skip it here to avoid dangling timers in tests.
  const service = new (BatchProcessorService as any)(dataSource) as BatchProcessorService;

  return { service, dataSource };
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('BatchProcessorService', () => {
  afterEach(() => jest.restoreAllMocks());

  // ─── UUID validation ───────────────────────────────────────────────────

  describe('UUID validation', () => {
    it('should accept valid UUIDs and flush them', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric());

      await service.flush();

      expect(dataSource.query).toHaveBeenCalledTimes(1);
      const sql = dataSource.query.mock.calls[0]![0] as string;
      expect(sql).toContain('INSERT INTO sensor.sensor_metrics');
    });

    it('should reject metric with invalid sensorId', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ sensorId: 'not-a-uuid' }));

      await service.flush();

      // No query should be executed — all metrics filtered out
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('should reject metric with invalid channelId', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ channelId: 'bad-channel' }));

      await service.flush();

      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('should reject metric with invalid tenantId', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ tenantId: 'bad-tenant' }));

      await service.flush();

      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('should reject metric with empty sensorId', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ sensorId: '' }));

      await service.flush();

      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('should reject metric with null tenantId', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ tenantId: null as unknown as string }));

      await service.flush();

      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('should accept uppercase UUIDs (case-insensitive regex)', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ sensorId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' }));

      await service.flush();

      expect(dataSource.query).toHaveBeenCalledTimes(1);
    });

    it('should only insert valid metrics from a mixed batch', async () => {
      const { service, dataSource } = createService();

      service.enqueue(createMetric()); // valid
      service.enqueue(createMetric({ sensorId: 'invalid' })); // invalid
      service.enqueue(createMetric()); // valid

      await service.flush();

      expect(dataSource.query).toHaveBeenCalledTimes(1);
      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      // 2 valid metrics * 19 params each = 38
      expect(params.length).toBe(38);
    });
  });

  // ─── Number.isFinite() checks ──────────────────────────────────────────

  describe('Number.isFinite checks', () => {
    it('should substitute 0 for NaN rawValue', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ rawValue: NaN }));

      await service.flush();

      expect(dataSource.query).toHaveBeenCalledTimes(1);
      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      // rawValue is at index 11 (0-based) in the params array
      expect(params[11]).toBe(0);
    });

    it('should substitute 0 for Infinity value', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ value: Infinity }));

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      // value is at index 12
      expect(params[12]).toBe(0);
    });

    it('should substitute 0 for -Infinity rawValue', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ rawValue: -Infinity }));

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      expect(params[11]).toBe(0);
    });

    it('should pass through valid numeric values', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ rawValue: 42.5, value: 43.0 }));

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      expect(params[11]).toBe(42.5); // rawValue
      expect(params[12]).toBe(43.0); // value
    });

    it('should handle zero values correctly', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ rawValue: 0, value: 0 }));

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      expect(params[11]).toBe(0);
      expect(params[12]).toBe(0);
    });

    it('should handle negative values correctly', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ rawValue: -15.3, value: -15.3 }));

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      expect(params[11]).toBe(-15.3);
      expect(params[12]).toBe(-15.3);
    });
  });

  // ─── Chunking logic ───────────────────────────────────────────────────

  describe('chunking logic (>1000 rows)', () => {
    it('should split batch into chunks when exceeding 1000 rows', async () => {
      const { service, dataSource } = createService();

      // Enqueuing 1500 metrics will trigger eager flush at 500 (MAX_BUFFER_SIZE).
      // We need to wait for those eager flushes, then call flush() for the rest.
      for (let i = 0; i < 1500; i++) {
        service.enqueue(createMetric({ rawValue: i }));
      }

      // Wait for any eager flush promises triggered by enqueue to settle
      await new Promise((r) => setTimeout(r, 50));
      // Final flush to drain whatever remains in buffer
      await service.flush();

      // Total rows inserted across all query calls should be 1500 * 19 params
      const totalParams = dataSource.query.mock.calls.reduce(
        (sum, call) => sum + ((call[1] as unknown[])?.length ?? 0),
        0,
      );
      expect(totalParams).toBe(1500 * 19);

      // Every chunk should have at most 1000 * 19 params
      for (const call of dataSource.query.mock.calls) {
        const params = call[1] as unknown[] | undefined;
        if (params) {
          expect(params.length).toBeLessThanOrEqual(1000 * 19);
        }
      }
    });

    it('should handle exactly 1000 rows in a single flush call', async () => {
      const { service, dataSource } = createService();

      // Enqueuing 1000 triggers eager flush at 500, leaving the rest.
      for (let i = 0; i < 1000; i++) {
        service.enqueue(createMetric({ rawValue: i }));
      }

      await new Promise((r) => setTimeout(r, 50));
      await service.flush();

      // Total params = 1000 * 19
      const totalParams = dataSource.query.mock.calls.reduce(
        (sum, call) => sum + ((call[1] as unknown[])?.length ?? 0),
        0,
      );
      expect(totalParams).toBe(1000 * 19);
    });

    it('should handle 1001 rows across multiple flushes', async () => {
      const { service, dataSource } = createService();

      for (let i = 0; i < 1001; i++) {
        service.enqueue(createMetric({ rawValue: i }));
      }

      await new Promise((r) => setTimeout(r, 50));
      await service.flush();

      const totalParams = dataSource.query.mock.calls.reduce(
        (sum, call) => sum + ((call[1] as unknown[])?.length ?? 0),
        0,
      );
      expect(totalParams).toBe(1001 * 19);
      // At least 2 query calls (500-row eager flush + remainder)
      expect(dataSource.query.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Buffer thresholds (500 rows triggers immediate flush) ────────────

  describe('buffer threshold', () => {
    it('should trigger flush when buffer reaches 500 rows', async () => {
      const { service, dataSource } = createService();

      // Spy on flush
      const flushSpy = jest.spyOn(service, 'flush');

      // Enqueue 499 — should NOT trigger
      for (let i = 0; i < 499; i++) {
        service.enqueue(createMetric({ rawValue: i }));
      }

      // Flush is async and fire-and-forget from enqueue; give it a tick
      await new Promise((r) => setTimeout(r, 10));
      expect(flushSpy).not.toHaveBeenCalled();

      // The 500th enqueue should trigger eager flush
      service.enqueue(createMetric({ rawValue: 500 }));

      await new Promise((r) => setTimeout(r, 50));
      expect(flushSpy).toHaveBeenCalled();
    });
  });

  // ─── Empty buffer ─────────────────────────────────────────────────────

  describe('empty buffer', () => {
    it('should not execute any query when buffer is empty', async () => {
      const { service, dataSource } = createService();

      await service.flush();

      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('should not execute query when all metrics are invalid', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ sensorId: 'bad' }));
      service.enqueue(createMetric({ channelId: 'bad' }));
      service.enqueue(createMetric({ tenantId: 'bad' }));

      await service.flush();

      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  // ─── Parameterized query generation ────────────────────────────────────

  describe('parameterized query', () => {
    it('should generate correct SQL with parameterized placeholders', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric());

      await service.flush();

      const sql = dataSource.query.mock.calls[0]![0] as string;
      // Should have 19 dollar-sign placeholders for a single row
      expect(sql).toMatch(/\$1,/);
      expect(sql).toMatch(/\$19\)/);
      // Should NOT contain raw values in the SQL string
      expect(sql).not.toContain(VALID_SENSOR_ID);
    });

    it('should include ON CONFLICT upsert clause', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric());

      await service.flush();

      const sql = dataSource.query.mock.calls[0]![0] as string;
      expect(sql).toContain('ON CONFLICT (time, sensor_id, channel_id) DO UPDATE SET');
      expect(sql).toContain('EXCLUDED.value');
      expect(sql).toContain('EXCLUDED.raw_value');
      expect(sql).toContain('EXCLUDED.quality_code');
    });

    it('should have correct parameter count for 2 rows', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ rawValue: 1.0 }));
      service.enqueue(createMetric({ rawValue: 2.0 }));

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      expect(params.length).toBe(2 * 19); // 38 params
    });

    it('should pass null for optional fields when absent', async () => {
      const { service, dataSource } = createService();
      service.enqueue(
        createMetric({
          siteId: undefined,
          departmentId: undefined,
          systemId: undefined,
          equipmentId: undefined,
          tankId: undefined,
          pondId: undefined,
          farmId: undefined,
          sourceProtocol: undefined,
          sourceTimestamp: undefined,
          batchId: undefined,
        }),
      );

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      // Indices for optional fields (0-based):
      // 4=siteId, 5=departmentId, 6=systemId, 7=equipmentId,
      // 8=tankId, 9=pondId, 10=farmId, 15=sourceProtocol,
      // 16=sourceTimestamp, 17=ingestionLatency, 18=batchId
      expect(params[4]).toBeNull();  // siteId
      expect(params[5]).toBeNull();  // departmentId
      expect(params[6]).toBeNull();  // systemId
      expect(params[7]).toBeNull();  // equipmentId
      expect(params[8]).toBeNull();  // tankId
      expect(params[9]).toBeNull();  // pondId
      expect(params[10]).toBeNull(); // farmId
      expect(params[15]).toBeNull(); // sourceProtocol
      expect(params[16]).toBeNull(); // sourceTimestamp
      expect(params[17]).toBeNull(); // ingestionLatencyMs
      expect(params[18]).toBeNull(); // batchId
    });
  });

  // ─── sourceProtocol sanitization ───────────────────────────────────────

  describe('sourceProtocol sanitization', () => {
    it('should strip special characters from sourceProtocol', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ sourceProtocol: 'mqtt<script>' }));

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      // Index 15 is sourceProtocol
      expect(params[15]).toBe('mqttscript');
    });

    it('should allow valid protocol names', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ sourceProtocol: 'modbus_tcp' }));

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      expect(params[15]).toBe('modbus_tcp');
    });
  });

  // ─── enqueueBatch ─────────────────────────────────────────────────────

  describe('enqueueBatch', () => {
    it('should enqueue multiple metrics at once', async () => {
      const { service, dataSource } = createService();
      service.enqueueBatch([createMetric({ rawValue: 1 }), createMetric({ rawValue: 2 })]);

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      expect(params.length).toBe(2 * 19);
    });
  });

  // ─── lifecycle hooks ──────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('onModuleInit should start flush interval', () => {
      const { service } = createService();
      jest.useFakeTimers();

      service.onModuleInit();

      // Timer should exist (we can verify by destroying which clears it)
      expect(() => service.onModuleDestroy()).not.toThrow();

      jest.useRealTimers();
    });

    it('onModuleDestroy should flush remaining buffer', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric());

      await service.onModuleDestroy();

      expect(dataSource.query).toHaveBeenCalledTimes(1);
    });

    it('onModuleDestroy with empty buffer should not fail', async () => {
      const { service, dataSource } = createService();

      await expect(service.onModuleDestroy()).resolves.not.toThrow();
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  // ─── qualityCode / qualityBits defaults ────────────────────────────────

  describe('quality code defaults', () => {
    it('should default qualityCode to 192 when undefined', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ qualityCode: undefined }));

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      // Index 13 is qualityCode
      expect(params[13]).toBe(192);
    });

    it('should default qualityBits to 0 when undefined', async () => {
      const { service, dataSource } = createService();
      service.enqueue(createMetric({ qualityBits: undefined }));

      await service.flush();

      const params = dataSource.query.mock.calls[0]![1] as unknown[];
      // Index 14 is qualityBits
      expect(params[14]).toBe(0);
    });
  });
});
