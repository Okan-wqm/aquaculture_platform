/**
 * WaterTemperatureService — latest manual water temperature per tank (Phase 2a).
 */
import { DataSource } from 'typeorm';
import { WaterTemperatureService } from '../water-temperature.service';

function serviceWith(queryImpl: jest.Mock): WaterTemperatureService {
  const dataSource = { query: queryImpl } as Partial<DataSource> as DataSource;
  return new WaterTemperatureService(dataSource);
}

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const TANK = 'bbbbbbbb-2222-4333-8444-555555555555';

describe('WaterTemperatureService', () => {
  it('returns the latest manual temperature for a tank', async () => {
    const query = jest.fn().mockResolvedValue([{ temperature: '12.50' }]);
    const service = serviceWith(query);

    const result = await service.getCurrentTemperature(TENANT, TANK);

    expect(result).toEqual({ celsius: 12.5, source: 'manual' });
    // schema-qualified + newest-first + non-null temperature only
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('water_quality_measurements');
    expect(sql).toContain('"temperature" IS NOT NULL');
    expect(sql).toContain('ORDER BY "measuredAt" DESC');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([TENANT, TANK]);
  });

  it('matches on either tankId or equipmentId', async () => {
    const query = jest.fn().mockResolvedValue([{ temperature: 9 }]);
    const service = serviceWith(query);
    await service.getCurrentTemperature(TENANT, TANK);
    expect(query.mock.calls[0][0]).toContain('("tankId" = $2 OR "equipmentId" = $2)');
  });

  it('returns null when there is no temperature on record', async () => {
    const service = serviceWith(jest.fn().mockResolvedValue([]));
    expect(await service.getCurrentTemperature(TENANT, TANK)).toBeNull();
  });

  it('returns null when the newest row has a null temperature', async () => {
    const service = serviceWith(jest.fn().mockResolvedValue([{ temperature: null }]));
    expect(await service.getCurrentTemperature(TENANT, TANK)).toBeNull();
  });
});
