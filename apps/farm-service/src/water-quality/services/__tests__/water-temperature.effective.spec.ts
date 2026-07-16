/**
 * getEffectiveTemperaturesForUnits (feeding-protocol SSoT Faz 3, C-3/K-11).
 *
 * Pinler: taze sensör kesin önceliklidir; sensörü çözülemeyen üniteler manuel
 * girişe iner; hiçbiri yoksa kaynak AÇIKÇA 'none' (çağıran çarpan 1.0 uygular
 * — sessiz default sıcaklık yok, P-20); manuel sorgu yalnız sensörle
 * çözülemeyen üniteler için koşar (toplu okuma disiplini).
 */
import { WaterTemperatureService } from '../water-temperature.service';

jest.mock('@aquaculture/backend-common/database', () => ({
  runInTenantRead: jest.fn(
    async (
      _ds: unknown,
      _schema: string,
      _tenantId: string,
      cb: (qr: unknown) => Promise<unknown>,
    ) => cb(globalThis.__wtQueryRunner),
  ),
}));

declare global {
  var __wtQueryRunner: { query: jest.Mock; manager: { query: jest.Mock } };
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT_SENSOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNIT_MANUAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNIT_NONE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('WaterTemperatureService.getEffectiveTemperaturesForUnits', () => {
  let managerQuery: jest.Mock;
  let service: WaterTemperatureService;

  beforeEach(() => {
    managerQuery = jest.fn();
    globalThis.__wtQueryRunner = {
      query: jest.fn().mockResolvedValue(undefined), // SAVEPOINT komutları
      manager: { query: managerQuery },
    };
    service = new WaterTemperatureService({} as never, undefined);
  });

  it('resolves sensor-first, falls back to manual, and labels the rest none', async () => {
    managerQuery
      // 1. toplu sensör okuması
      .mockResolvedValueOnce([
        {
          unitId: UNIT_SENSOR,
          celsius: '12.5',
          measuredAt: '2026-07-16T08:00:00.000Z',
          sensorId: 'sensor-1',
        },
      ])
      // 2. yalnız çözülemeyenler için manuel okuma
      .mockResolvedValueOnce([
        { unitId: UNIT_MANUAL, celsius: '10.1', measuredAt: '2026-07-16T06:00:00.000Z' },
      ]);

    const result = await service.getEffectiveTemperaturesForUnits(TENANT, [
      UNIT_SENSOR,
      UNIT_MANUAL,
      UNIT_NONE,
    ]);

    expect(result.get(UNIT_SENSOR)).toMatchObject({
      celsius: 12.5,
      source: 'sensor',
      sensorId: 'sensor-1',
    });
    expect(result.get(UNIT_MANUAL)).toMatchObject({ celsius: 10.1, source: 'manual' });
    expect(result.get(UNIT_NONE)).toEqual({ celsius: null, source: 'none' });

    // Manuel sorgu sensörle çözülen üniteyi TEKRAR sormaz.
    const manualParams = managerQuery.mock.calls[1]?.[1];
    expect(manualParams?.[0]).toEqual([UNIT_MANUAL, UNIT_NONE]);
  });

  it('skips the manual query entirely when sensors resolved every unit', async () => {
    managerQuery.mockResolvedValueOnce([
      {
        unitId: UNIT_SENSOR,
        celsius: '14',
        measuredAt: '2026-07-16T08:00:00.000Z',
        sensorId: 'sensor-1',
      },
    ]);

    const result = await service.getEffectiveTemperaturesForUnits(TENANT, [UNIT_SENSOR]);

    expect(result.get(UNIT_SENSOR)?.source).toBe('sensor');
    expect(managerQuery).toHaveBeenCalledTimes(1);
  });

  it('returns an empty map for an empty unit list without touching the database', async () => {
    const result = await service.getEffectiveTemperaturesForUnits(TENANT, []);
    expect(result.size).toBe(0);
    expect(managerQuery).not.toHaveBeenCalled();
  });

  it('degrades a failing source to none for that source only (bulkhead)', async () => {
    managerQuery
      .mockRejectedValueOnce(new Error('missing grant'))
      .mockResolvedValueOnce([
        { unitId: UNIT_SENSOR, celsius: '9.9', measuredAt: '2026-07-16T05:00:00.000Z' },
      ]);

    const result = await service.getEffectiveTemperaturesForUnits(TENANT, [UNIT_SENSOR]);

    expect(result.get(UNIT_SENSOR)).toMatchObject({ celsius: 9.9, source: 'manual' });
  });
});
