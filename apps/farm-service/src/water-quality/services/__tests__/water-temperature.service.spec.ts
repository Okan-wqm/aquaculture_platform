/**
 * WaterTemperatureService — latest water temperature per tank, picking the most
 * recent of the linked-sensor reading and the latest manual measurement.
 *
 * BULKHEAD (2026-07-06 incident): each source reads under its own SAVEPOINT;
 * an infrastructure failure of one source degrades to null-for-that-source
 * (loud: error log + farm_water_temperature_read_failures_total) instead of
 * aborting the caller — the failure that blanked equipmentList.batchMetrics
 * (mobile lost all fish counts) and killed every tank's daily feeding plan.
 */
import { DataSource, EntityManager } from 'typeorm';

const runInTenantRead = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantRead(ds, schema, tenantId, cb),
}));

import { FarmDomainMetricsService } from '../../../common/metrics/farm-domain-metrics.service';
import { WaterTemperatureService } from '../water-temperature.service';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const TANK = 'bbbbbbbb-2222-4333-8444-555555555555';

interface Row {
  celsius: string | number;
  measuredAt: string;
}

type SourceResult = Row[] | Error;

interface Harness {
  service: WaterTemperatureService;
  savepointCalls: string[];
  metrics: { recordWaterTemperatureReadFailure: jest.Mock };
}

/**
 * Route the mocked reads to the sensor or the manual result by the SQL text —
 * a source given an Error REJECTS (infrastructure failure, e.g. permission
 * denied). Reads run inside the (mocked) fail-closed runInTenantRead boundary;
 * the callback receives a queryRunner whose top-level query records SAVEPOINT
 * traffic and whose manager.query serves the source reads, exactly like the
 * production QueryRunner shape.
 */
function harness(sensor: SourceResult, manual: SourceResult): Harness {
  const savepointCalls: string[] = [];
  const managerQuery = jest.fn((sql: string) => {
    if (sql.includes('sensor_temperature_latest')) {
      return sensor instanceof Error ? Promise.reject(sensor) : Promise.resolve(sensor);
    }
    if (sql.includes('water_quality_measurements')) {
      return manual instanceof Error ? Promise.reject(manual) : Promise.resolve(manual);
    }
    return Promise.resolve([]);
  });
  const runnerQuery = jest.fn((sql: string) => {
    savepointCalls.push(sql);
    return Promise.resolve([]);
  });
  runInTenantRead.mockImplementation(
    async (
      _ds,
      _schema,
      _tenant,
      cb: (qr: { query: jest.Mock; manager: Partial<EntityManager> }) => Promise<unknown>,
    ) => cb({ query: runnerQuery, manager: { query: managerQuery } as Partial<EntityManager> }),
  );
  const metrics = { recordWaterTemperatureReadFailure: jest.fn() };
  const service = new WaterTemperatureService(
    {} as Partial<DataSource> as DataSource,
    metrics as Partial<FarmDomainMetricsService> as FarmDomainMetricsService,
  );
  return { service, savepointCalls, metrics };
}

const at = (iso: string, celsius: number): Row => ({ celsius, measuredAt: iso });

describe('WaterTemperatureService', () => {
  it('returns the linked-sensor reading when only the sensor has data', async () => {
    const { service } = harness([at('2026-07-04T10:00:00.000Z', 12.5)], []);
    expect(await service.getCurrentTemperature(TENANT, TANK)).toEqual({
      celsius: 12.5,
      source: 'sensor',
      measuredAt: expect.any(Date),
    });
  });

  it('returns the manual reading when only a manual measurement exists', async () => {
    const { service } = harness([], [at('2026-07-04T10:00:00.000Z', 9)]);
    expect(await service.getCurrentTemperature(TENANT, TANK)).toEqual({
      celsius: 9,
      source: 'manual',
      measuredAt: expect.any(Date),
    });
  });

  it('prefers the sensor reading when it is the more recent of the two', async () => {
    const { service } = harness(
      [at('2026-07-04T12:00:00.000Z', 14)], // newer
      [at('2026-07-04T08:00:00.000Z', 10)],
    );
    expect(await service.getCurrentTemperature(TENANT, TANK)).toMatchObject({
      celsius: 14,
      source: 'sensor',
      measuredAt: expect.any(Date),
    });
  });

  it('prefers the manual reading when it is the more recent of the two', async () => {
    const { service } = harness(
      [at('2026-07-04T08:00:00.000Z', 14)],
      [at('2026-07-04T12:00:00.000Z', 11)], // newer
    );
    expect(await service.getCurrentTemperature(TENANT, TANK)).toMatchObject({
      celsius: 11,
      source: 'manual',
      measuredAt: expect.any(Date),
    });
  });

  it('returns null when neither source has a temperature', async () => {
    const { service } = harness([], []);
    expect(await service.getCurrentTemperature(TENANT, TANK)).toBeNull();
  });

  describe('bulkhead: per-source SAVEPOINT isolation (2026-07-06 incident)', () => {
    it('degrades a failing sensor source to the manual reading instead of throwing', async () => {
      const { service, savepointCalls, metrics } = harness(
        new Error('permission denied for table sensor_temperature_latest'),
        [at('2026-07-04T10:00:00.000Z', 9)],
      );

      expect(await service.getCurrentTemperature(TENANT, TANK)).toEqual({
        celsius: 9,
        source: 'manual',
        measuredAt: expect.any(Date),
      });
      // the failed source was rolled back to its savepoint, not left to poison
      // the surrounding READ COMMITTED transaction (25P02)
      expect(savepointCalls).toContain('ROLLBACK TO SAVEPOINT water_temperature_source');
      expect(metrics.recordWaterTemperatureReadFailure).toHaveBeenCalledWith({ source: 'sensor' });
    });

    it('degrades a failing manual source to the sensor reading instead of throwing', async () => {
      const { service, metrics } = harness(
        [at('2026-07-04T10:00:00.000Z', 12.5)],
        new Error('permission denied for table water_quality_measurements'),
      );

      expect(await service.getCurrentTemperature(TENANT, TANK)).toEqual({
        celsius: 12.5,
        source: 'sensor',
        measuredAt: expect.any(Date),
      });
      expect(metrics.recordWaterTemperatureReadFailure).toHaveBeenCalledWith({ source: 'manual' });
    });

    it('returns null (never throws) when BOTH sources fail — callers keep their default-temperature path', async () => {
      const { service, metrics } = harness(new Error('boom-sensor'), new Error('boom-manual'));

      expect(await service.getCurrentTemperature(TENANT, TANK)).toBeNull();
      expect(metrics.recordWaterTemperatureReadFailure).toHaveBeenCalledTimes(2);
    });

    it('releases the savepoint on the happy path (no rollbacks, no metric)', async () => {
      const { service, savepointCalls, metrics } = harness(
        [at('2026-07-04T10:00:00.000Z', 12.5)],
        [],
      );

      await service.getCurrentTemperature(TENANT, TANK);
      expect(savepointCalls.filter((s) => s.startsWith('SAVEPOINT'))).toHaveLength(2);
      expect(savepointCalls.filter((s) => s.startsWith('RELEASE'))).toHaveLength(2);
      expect(savepointCalls.filter((s) => s.startsWith('ROLLBACK'))).toHaveLength(0);
      expect(metrics.recordWaterTemperatureReadFailure).not.toHaveBeenCalled();
    });
  });

  it('resolves the sensor via temperatureSensorId inside the tenant boundary, with NO schema interpolation', async () => {
    let sensorSql = '';
    const managerQuery = jest.fn((sql: string) => {
      if (sql.includes('sensor_temperature_latest')) {
        sensorSql = sql;
      }
      return Promise.resolve([]);
    });
    runInTenantRead.mockImplementation(
      async (
        _ds,
        schema: string,
        tenant: string,
        cb: (qr: { query: jest.Mock; manager: Partial<EntityManager> }) => Promise<unknown>,
      ) => {
        expect(schema).toBe('farm');
        expect(tenant).toBe(TENANT);
        return cb({
          query: jest.fn().mockResolvedValue([]),
          manager: { query: managerQuery } as Partial<EntityManager>,
        });
      },
    );
    const service = new WaterTemperatureService({} as Partial<DataSource> as DataSource);
    await service.getCurrentTemperature(TENANT, TANK);
    // Resolves the container's sensor from either the tanks or the equipment table.
    expect(sensorSql).toContain('tanks');
    expect(sensorSql).toContain('equipment');
    expect(sensorSql).toContain('temperatureSensorId');
    expect(sensorSql).toContain('sensor_temperature_latest');
    // GSEC-HIGH-001: table names are UNQUALIFIED — the pinned search_path routes
    // them; no tenant-derived schema string is ever interpolated into SQL.
    expect(sensorSql).not.toContain('tenant_');
    expect(sensorSql).not.toContain('".tanks');
  });

  describe('getPeriodTemperature', () => {
    const SITE = 'dddddddd-4444-4555-8666-777777777777';

    function periodService(
      sensorRows: Array<Record<string, unknown>>,
      manualRows: Array<Record<string, unknown>>,
    ): WaterTemperatureService {
      const query = jest.fn((sql: string) => {
        if (sql.includes('sensor_temperature_daily')) return Promise.resolve(sensorRows);
        if (sql.includes('water_quality_measurements')) return Promise.resolve(manualRows);
        return Promise.resolve([]);
      });
      runInTenantRead.mockImplementation(
        async (
          _ds,
          _schema,
          _tenant,
          cb: (qr: { manager: Partial<EntityManager> }) => Promise<unknown>,
        ) => cb({ manager: { query } as Partial<EntityManager> }),
      );
      return new WaterTemperatureService({} as Partial<DataSource> as DataSource);
    }

    it('returns the sensor-daily period mean (sumC/sampleCount) with coverage', async () => {
      // 100°C over 8 samples across 6 days → mean 12.5.
      const service = periodService(
        [{ sumC: '100', sampleCount: '8', minC: '11.8', maxC: '13.1', coverageDays: '6' }],
        [],
      );
      expect(await service.getPeriodTemperature(TENANT, SITE, '2026-06-29', '2026-07-05')).toEqual({
        celsius: 12.5,
        source: 'sensor',
        coverageDays: 6,
        minC: 11.8,
        maxC: 13.1,
      });
    });

    it('falls back to the manual period average when no sensor daily rows exist', async () => {
      const service = periodService(
        [{ sumC: null, sampleCount: '0', minC: null, maxC: null, coverageDays: '0' }],
        [{ avgC: '10.256', minC: '9.5', maxC: '11.0', coverageDays: '2' }],
      );
      expect(await service.getPeriodTemperature(TENANT, SITE, '2026-06-29', '2026-07-05')).toEqual({
        celsius: 10.26,
        source: 'manual',
        coverageDays: 2,
        minC: 9.5,
        maxC: 11,
      });
    });

    it('returns null when neither source has data in the period (caller blocks)', async () => {
      const service = periodService(
        [{ sumC: null, sampleCount: '0', minC: null, maxC: null, coverageDays: '0' }],
        [{ avgC: null, minC: null, maxC: null, coverageDays: '0' }],
      );
      expect(
        await service.getPeriodTemperature(TENANT, SITE, '2026-06-29', '2026-07-05'),
      ).toBeNull();
    });
  });
});
