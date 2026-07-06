/**
 * WaterTemperatureService — latest water temperature per tank, picking the most
 * recent of the linked-sensor reading and the latest manual measurement.
 */
import { DataSource, EntityManager } from 'typeorm';

const runInTenantRead = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantRead(ds, schema, tenantId, cb),
}));

import { WaterTemperatureService } from '../water-temperature.service';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const TANK = 'bbbbbbbb-2222-4333-8444-555555555555';

interface Row {
  celsius: string | number;
  measuredAt: string;
}

/**
 * Route the mocked query to the sensor or the manual result by the SQL text.
 * Reads run inside the (mocked) fail-closed runInTenantRead boundary, exactly
 * like production — the callback receives a manager whose query is routed.
 */
function routingService(sensor: Row[], manual: Row[]): WaterTemperatureService {
  const query = jest.fn((sql: string) => {
    if (sql.includes('sensor_temperature_latest')) return Promise.resolve(sensor);
    if (sql.includes('water_quality_measurements')) return Promise.resolve(manual);
    return Promise.resolve([]);
  });
  runInTenantRead.mockImplementation(
    async (_ds, _schema, _tenant, cb: (qr: { manager: Partial<EntityManager> }) => Promise<unknown>) =>
      cb({ manager: { query } as Partial<EntityManager> }),
  );
  return new WaterTemperatureService({} as Partial<DataSource> as DataSource);
}

const at = (iso: string, celsius: number): Row => ({ celsius, measuredAt: iso });

describe('WaterTemperatureService', () => {
  it('returns the linked-sensor reading when only the sensor has data', async () => {
    const service = routingService([at('2026-07-04T10:00:00.000Z', 12.5)], []);
    expect(await service.getCurrentTemperature(TENANT, TANK)).toMatchObject({
      celsius: 12.5,
      source: 'sensor',
      measuredAt: expect.any(Date),
    });
  });

  it('returns the manual reading when only a manual measurement exists', async () => {
    const service = routingService([], [at('2026-07-04T10:00:00.000Z', 9)]);
    expect(await service.getCurrentTemperature(TENANT, TANK)).toMatchObject({
      celsius: 9,
      source: 'manual',
      measuredAt: expect.any(Date),
    });
  });

  it('prefers the sensor reading when it is the more recent of the two', async () => {
    const service = routingService(
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
    const service = routingService(
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
    const service = routingService([], []);
    expect(await service.getCurrentTemperature(TENANT, TANK)).toBeNull();
  });

  it('resolves the sensor via temperatureSensorId inside the tenant boundary, with NO schema interpolation', async () => {
    let sensorSql = '';
    const query = jest.fn((sql: string) => {
      if (sql.includes('sensor_temperature_latest')) {
        sensorSql = sql;
      }
      return Promise.resolve([]);
    });
    runInTenantRead.mockImplementation(
      async (_ds, schema: string, tenant: string, cb: (qr: { manager: Partial<EntityManager> }) => Promise<unknown>) => {
        expect(schema).toBe('farm');
        expect(tenant).toBe(TENANT);
        return cb({ manager: { query } as Partial<EntityManager> });
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
});
