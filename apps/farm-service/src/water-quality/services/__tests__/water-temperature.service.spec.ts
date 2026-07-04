/**
 * WaterTemperatureService — latest water temperature per tank, picking the most
 * recent of the linked-sensor reading and the latest manual measurement.
 */
import { DataSource } from 'typeorm';
import { WaterTemperatureService } from '../water-temperature.service';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const TANK = 'bbbbbbbb-2222-4333-8444-555555555555';

interface Row {
  celsius: string | number;
  measuredAt: string;
}

/** Route the mocked query to the sensor or the manual result by the SQL text. */
function routingService(sensor: Row[], manual: Row[]): WaterTemperatureService {
  const query = jest.fn((sql: string) => {
    if (sql.includes('sensor_temperature_latest')) return Promise.resolve(sensor);
    if (sql.includes('water_quality_measurements')) return Promise.resolve(manual);
    return Promise.resolve([]);
  });
  const dataSource = { query } as Partial<DataSource> as DataSource;
  return new WaterTemperatureService(dataSource);
}

const at = (iso: string, celsius: number): Row => ({ celsius, measuredAt: iso });

describe('WaterTemperatureService', () => {
  it('returns the linked-sensor reading when only the sensor has data', async () => {
    const service = routingService([at('2026-07-04T10:00:00.000Z', 12.5)], []);
    expect(await service.getCurrentTemperature(TENANT, TANK)).toEqual({
      celsius: 12.5,
      source: 'sensor',
    });
  });

  it('returns the manual reading when only a manual measurement exists', async () => {
    const service = routingService([], [at('2026-07-04T10:00:00.000Z', 9)]);
    expect(await service.getCurrentTemperature(TENANT, TANK)).toEqual({
      celsius: 9,
      source: 'manual',
    });
  });

  it('prefers the sensor reading when it is the more recent of the two', async () => {
    const service = routingService(
      [at('2026-07-04T12:00:00.000Z', 14)], // newer
      [at('2026-07-04T08:00:00.000Z', 10)],
    );
    expect(await service.getCurrentTemperature(TENANT, TANK)).toEqual({
      celsius: 14,
      source: 'sensor',
    });
  });

  it('prefers the manual reading when it is the more recent of the two', async () => {
    const service = routingService(
      [at('2026-07-04T08:00:00.000Z', 14)],
      [at('2026-07-04T12:00:00.000Z', 11)], // newer
    );
    expect(await service.getCurrentTemperature(TENANT, TANK)).toEqual({
      celsius: 11,
      source: 'manual',
    });
  });

  it('returns null when neither source has a temperature', async () => {
    const service = routingService([], []);
    expect(await service.getCurrentTemperature(TENANT, TANK)).toBeNull();
  });

  it('resolves the sensor via equipment.temperatureSensorId and the tank id', async () => {
    let sensorSql = '';
    const query = jest.fn((sql: string) => {
      if (sql.includes('sensor_temperature_latest')) {
        sensorSql = sql;
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
    const service = new WaterTemperatureService({ query } as Partial<DataSource> as DataSource);
    await service.getCurrentTemperature(TENANT, TANK);
    // Resolves the container's sensor from either the tanks or the equipment table.
    expect(sensorSql).toContain('tanks');
    expect(sensorSql).toContain('equipment');
    expect(sensorSql).toContain('temperatureSensorId');
    expect(sensorSql).toContain('sensor_temperature_latest');
  });
});
