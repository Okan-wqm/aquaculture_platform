import { DataSource, EntityManager } from 'typeorm';

import { SensorMetricInput } from '../../database/entities/sensor-metric.entity';
import { SensorMetricWriterService } from '../sensor-metric-writer.service';

/**
 * SENSOR-MEDIUM-068 (Phase 2B): the SINGLE writer for `sensor_metrics`.
 * These tests lock the one INSERT contract + the three delivery modes
 * (buffered enqueue/flush, immediate, managed) that the four ingestion paths
 * used to each hand-copy.
 *
 * They also lock the tenant-residency guarantee: `sensor_metrics` is per-tenant,
 * and the destination schema is derived from each row's own tenantId — NOT from
 * an ambient search_path (three of the four callers are process-wide singletons
 * that have none) and NOT from a shared schema. A mixed-tenant batch must fan
 * out to each tenant's schema rather than landing in one.
 */
const TENANT_A = '33333333-3333-4333-8333-333333333333';
const TENANT_B = '44444444-4444-4444-8444-444444444444';
const SCHEMA_A = 'tenant_3333333333334333';
const SCHEMA_B = 'tenant_4444444444444444';

// The writer only uses the single-argument transaction overload; narrowing
// the mock's type here avoids faking TypeORM's full overload pair.
type TransactionalDataSource = Partial<Omit<DataSource, 'transaction'>> & {
  transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T>;
};

function createService(): { service: SensorMetricWriterService; query: jest.Mock } {
  const query = jest.fn().mockResolvedValue(undefined);
  // Single-connection fake: the transaction callback sees the SAME query mock,
  // so SQL/param assertions cover the SET LOCAL + INSERT sequence.
  const transaction = async <T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> => {
    const manager: Partial<EntityManager> = { query };
    return fn(manager as EntityManager);
  };
  const dataSource: TransactionalDataSource = { query, transaction };
  const service = new SensorMetricWriterService(dataSource as DataSource);
  return { service, query };
}

function createMetric(overrides: Partial<SensorMetricInput> = {}): SensorMetricInput {
  return {
    time: new Date('2026-03-14T12:00:00.000Z'),
    sensorId: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    tenantId: TENANT_A,
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
    it('targets the TENANT schema with the re-publish conflict semantic', () => {
      const { service } = createService();
      const sql = service.buildInsertSql(SCHEMA_A, 2);
      expect(sql).toContain(`INSERT INTO "${SCHEMA_A}".sensor_metrics`);
      expect(sql).toContain('ON CONFLICT (time, sensor_id, channel_id) DO UPDATE');
      expect(sql).toContain('value        = EXCLUDED.value');
      // 2 rows × 19 params → $1 … $38.
      expect(sql).toContain('$19');
      expect(sql).toContain('$38');
      expect(sql).not.toContain('$39');
    });

    it('never emits a shared-schema metric INSERT', () => {
      const { service } = createService();
      const sql = service.buildInsertSql(SCHEMA_A, 1);
      expect(sql).not.toContain('sensor.sensor_metrics');
    });

    it('rejects a schema identifier that is not a tenant schema (SEC-M13)', () => {
      const { service } = createService();
      expect(() => service.buildInsertSql('sensor', 1)).toThrow(/Invalid schema name/);
      expect(() => service.buildInsertSql('tenant_x"; DROP TABLE users; --', 1)).toThrow(
        /Invalid schema name/,
      );
    });
  });

  describe('marshalParams', () => {
    it('emits exactly 19 params per row in the column order', () => {
      const { service } = createService();
      const params = service.marshalParams([createMetric()]);
      expect(params).toHaveLength(19);
      expect(params[0]).toBe('2026-03-14T12:00:00.000Z'); // time
      expect(params[1]).toBe('11111111-1111-4111-8111-111111111111'); // sensor_id
      expect(params[3]).toBe(TENANT_A); // tenant_id
      expect(params[11]).toBe(24.5); // raw_value
      expect(params[12]).toBe(24.5); // value
      expect(params[15]).toBe('mqtt'); // source_protocol
    });
  });

  describe('writeImmediate', () => {
    it("writes into the row's OWN tenant schema via the service connection", async () => {
      const { service, query } = createService();
      await service.writeImmediate([createMetric()]);
      expect(query).toHaveBeenCalledTimes(2); // SET LOCAL timeouts + INSERT
      const [sql, params] = query.mock.calls[1]!;
      expect(sql).toContain(`INSERT INTO "${SCHEMA_A}".sensor_metrics`);
      expect(params).toHaveLength(19);
    });

    it('fans a MIXED-tenant batch out to each tenant schema', async () => {
      const { service, query } = createService();

      await service.writeImmediate([
        createMetric({ tenantId: TENANT_A }),
        createMetric({ tenantId: TENANT_B }),
      ]);

      expect(query).toHaveBeenCalledTimes(4); // (SET LOCAL + INSERT) × 2 tenants
      const targets = query.mock.calls.map(([sql]) => String(sql));
      expect(targets.some((s) => s.includes(`"${SCHEMA_A}".sensor_metrics`))).toBe(true);
      expect(targets.some((s) => s.includes(`"${SCHEMA_B}".sensor_metrics`))).toBe(true);
      // Neither tenant's rows may be written into the other's schema. The SET
      // LOCAL timeout statement carries no params and no schema target.
      for (const [sql, params] of query.mock.calls) {
        if (!params) continue;
        const schema = String(sql).includes(SCHEMA_A) ? TENANT_A : TENANT_B;
        expect(params[3]).toBe(schema);
      }
    });

    it("does not discard other tenants' rows when one tenant fails, and surfaces the failure", async () => {
      const { service, query } = createService();
      query.mockImplementation((sql: string) =>
        String(sql).includes(SCHEMA_A)
          ? Promise.reject(new Error('disk full'))
          : Promise.resolve(undefined),
      );

      await expect(
        service.writeImmediate([
          createMetric({ tenantId: TENANT_A }),
          createMetric({ tenantId: TENANT_B }),
        ]),
      ).rejects.toThrow(/disk full/);

      // Tenant B's insert was still attempted — one tenant's failure does not
      // silently drop every other tenant's telemetry.
      const targets = query.mock.calls.map(([sql]) => String(sql));
      expect(targets.some((s) => s.includes(`"${SCHEMA_B}".sensor_metrics`))).toBe(true);
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
    it('writes on the caller transaction manager, into the tenant schema', async () => {
      const { service, query } = createService();
      const managerQuery = jest.fn().mockResolvedValue(undefined);
      const manager: Partial<EntityManager> = { query: managerQuery };
      await service.writeManaged([createMetric()], manager as EntityManager);
      expect(managerQuery).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
      const [sql] = managerQuery.mock.calls[0]!;
      expect(sql).toContain(`INSERT INTO "${SCHEMA_A}".sensor_metrics`);
    });

    it('propagates a failure so the caller transaction rolls back (SENSOR-CRITICAL-001)', async () => {
      const { service } = createService();
      const managerQuery = jest.fn().mockRejectedValue(new Error('deadlock detected'));
      const manager: Partial<EntityManager> = { query: managerQuery };

      await expect(
        service.writeManaged([createMetric()], manager as EntityManager),
      ).rejects.toThrow('deadlock detected');
    });
  });

  describe('enqueue + flush (buffered path)', () => {
    it('coalesces enqueued metrics and writes them on flush', async () => {
      const { service, query } = createService();
      service.enqueue(createMetric());
      service.enqueue(createMetric({ time: new Date('2026-03-14T12:00:01.000Z') }));
      expect(query).not.toHaveBeenCalled(); // buffered, not yet flushed
      await service.flush();
      expect(query).toHaveBeenCalledTimes(2); // SET LOCAL timeouts + INSERT
      const [, params] = query.mock.calls[1]!;
      expect(params).toHaveLength(38); // 2 rows × 19, same tenant → one INSERT
    });

    it('flush is a no-op on an empty buffer', async () => {
      const { service, query } = createService();
      await service.flush();
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('enqueue → Promise<WriteOutcome> (ack-after-commit contract)', () => {
    it('resolves only after the row batch commits, with the tenant outcome', async () => {
      const { service } = createService();
      const outcome = service.enqueue(createMetric());
      let settled = false;
      outcome.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false); // not committed yet — no early ack

      await service.flush();
      await expect(outcome).resolves.toEqual({
        tenantId: TENANT_A,
        committedRows: 1,
      });
    });

    it('rejects only the failing tenant waiters after one bounded retry', async () => {
      const { service, query } = createService();
      query.mockImplementation((sql: string) =>
        String(sql).includes(SCHEMA_A)
          ? Promise.reject(new Error('disk full'))
          : Promise.resolve(undefined),
      );

      const a = service.enqueue(createMetric({ tenantId: TENANT_A }));
      const b = service.enqueue(createMetric({ tenantId: TENANT_B }));

      await expect(service.flush()).rejects.toThrow(/disk full/);
      await expect(a).rejects.toThrow(/disk full/);
      await expect(b).resolves.toEqual({ tenantId: TENANT_B, committedRows: 1 });

      // Bounded retry: exactly two attempts for the failing tenant, then the
      // waiter rejects — source redelivery owns later attempts.
      const aAttempts = query.mock.calls
        .map(([sql]) => String(sql))
        .filter((s) => s.includes(SCHEMA_A)).length;
      expect(aAttempts).toBe(2);
    });

    it('recovers within the single bounded retry', async () => {
      const { service, query } = createService();
      let attempts = 0;
      query.mockImplementation((sql: string) => {
        if (String(sql).includes(SCHEMA_A)) {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error('transient deadlock'));
        }
        return Promise.resolve(undefined);
      });

      const a = service.enqueue(createMetric());
      await service.flush();
      await expect(a).resolves.toEqual({ tenantId: TENANT_A, committedRows: 1 });
    });

    it('settles an invalid row immediately as a zero-row discard (poison skip)', async () => {
      const { service, query } = createService();
      const outcome = service.enqueue(createMetric({ sensorId: 'not-a-uuid' }));
      await expect(outcome).resolves.toEqual({
        tenantId: TENANT_A,
        committedRows: 0,
      });
      await service.flush();
      expect(query).not.toHaveBeenCalled();
    });

    it('a stale redelivery cannot overwrite a newer corrected value (upsert guard)', () => {
      const { service } = createService();
      const sql = service.buildInsertSql(SCHEMA_A, 1);
      expect(sql).toContain('WHERE COALESCE(EXCLUDED.source_timestamp, EXCLUDED.time)');
      expect(sql).toContain('>= COALESCE(sensor_metrics.source_timestamp, sensor_metrics.time)');
    });

    it('bounds each tenant batch with statement/lock timeouts', async () => {
      const { service, query } = createService();
      await service.writeImmediate([createMetric()]);
      const setLocal = String(query.mock.calls[0][0]);
      expect(setLocal).toContain('SET LOCAL');
      expect(setLocal).toContain("statement_timeout = '5s'");
      expect(setLocal).toContain("lock_timeout = '1s'");
    });
  });
});
