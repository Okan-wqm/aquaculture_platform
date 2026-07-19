import { DataSource, EntityManager } from 'typeorm';

import { SensorMetricInput } from '../../database/entities/sensor-metric.entity';
import { SensorMetricWriterService } from '../sensor-metric-writer.service';

/**
 * SENSOR-MEDIUM-068 (Phase 2B): the SINGLE writer for sensor.sensor_metrics.
 * These tests lock the one INSERT contract + the three delivery modes
 * (buffered enqueue/flush, immediate, managed) that the four ingestion paths
 * used to each hand-copy.
 */
function createService(): { service: SensorMetricWriterService; query: jest.Mock } {
  const query = jest.fn().mockResolvedValue(undefined);
  const dataSource: Partial<DataSource> = { query };
  const service = new SensorMetricWriterService(dataSource as DataSource);
  return { service, query };
}

function createMetric(overrides: Partial<SensorMetricInput> = {}): SensorMetricInput {
  return {
    time: new Date('2026-03-14T12:00:00.000Z'),
    sensorId: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    tenantId: '33333333-3333-4333-8333-333333333333',
    rawValue: 24.5,
    value: 24.5,
    qualityCode: 192,
    qualityBits: 0,
    sourceProtocol: 'mqtt',
    sourceTimestamp: new Date('2026-03-14T12:00:00.000Z'),
    ...overrides,
  };
}

describe('SensorMetricWriterService (SENSOR-MEDIUM-068)', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('buildInsertSql', () => {
    it('targets the single cross-tenant hypertable with the re-publish conflict semantic', () => {
      const { service } = createService();
      const sql = service.buildInsertSql(2);
      expect(sql).toContain('INSERT INTO sensor.sensor_metrics');
      expect(sql).toContain('ON CONFLICT (time, sensor_id, channel_id) DO UPDATE');
      expect(sql).toContain('value        = EXCLUDED.value');
      // 2 rows × 19 params → $1 … $38.
      expect(sql).toContain('$19');
      expect(sql).toContain('$38');
      expect(sql).not.toContain('$39');
    });
  });

  describe('marshalParams', () => {
    it('emits exactly 19 params per row in the column order', () => {
      const { service } = createService();
      const params = service.marshalParams([createMetric()]);
      expect(params).toHaveLength(19);
      expect(params[0]).toBe('2026-03-14T12:00:00.000Z'); // time
      expect(params[1]).toBe('11111111-1111-4111-8111-111111111111'); // sensor_id
      expect(params[3]).toBe('33333333-3333-4333-8333-333333333333'); // tenant_id
      expect(params[11]).toBe(24.5); // raw_value
      expect(params[12]).toBe(24.5); // value
      expect(params[15]).toBe('mqtt'); // source_protocol
    });
  });

  describe('writeImmediate', () => {
    it('writes valid metrics via the service connection', async () => {
      const { service, query } = createService();
      await service.writeImmediate([createMetric()]);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO sensor.sensor_metrics');
      expect(params).toHaveLength(19);
    });

    it('drops rows with an invalid UUID', async () => {
      const { service, query } = createService();
      await service.writeImmediate([createMetric({ sensorId: 'not-a-uuid' })]);
      expect(query).not.toHaveBeenCalled();
    });

    it('drops rows with a non-finite value (would corrupt aggregates)', async () => {
      const { service, query } = createService();
      await service.writeImmediate([createMetric({ value: Number.POSITIVE_INFINITY })]);
      await service.writeImmediate([createMetric({ rawValue: Number.NaN })]);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('writeManaged', () => {
    it('writes on the caller transaction manager, not the service connection', async () => {
      const { service, query } = createService();
      const managerQuery = jest.fn().mockResolvedValue(undefined);
      const manager: Partial<EntityManager> = { query: managerQuery };
      await service.writeManaged([createMetric()], manager as EntityManager);
      expect(managerQuery).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
      const [sql] = managerQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO sensor.sensor_metrics');
    });
  });

  describe('enqueue + flush (buffered path)', () => {
    it('coalesces enqueued metrics and writes them on flush', async () => {
      const { service, query } = createService();
      service.enqueue(createMetric());
      service.enqueue(createMetric({ time: new Date('2026-03-14T12:00:01.000Z') }));
      expect(query).not.toHaveBeenCalled(); // buffered, not yet flushed
      await service.flush();
      expect(query).toHaveBeenCalledTimes(1);
      const [, params] = query.mock.calls[0]!;
      expect(params).toHaveLength(38); // 2 rows × 19
    });

    it('flush is a no-op on an empty buffer', async () => {
      const { service, query } = createService();
      await service.flush();
      expect(query).not.toHaveBeenCalled();
    });
  });
});
