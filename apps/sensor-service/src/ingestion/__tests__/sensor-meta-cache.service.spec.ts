/**
 * SensorMetaCacheService unit tests — Faz 3 follow-on (cache extract).
 *
 * Pins the contract the consumer + invalidation handler share:
 *   - Cache hit returns the cached value without hitting the repo.
 *   - Cache miss hits the repo + caches the result.
 *   - Empty channel result is NOT cached (operator may be fixing
 *     misconfiguration in real time).
 *   - invalidateSensor drops both sensor + per-sensor channel entries.
 *   - invalidateTenant drops every entry whose tenantId matches.
 */

import { ObjectLiteral, Repository } from 'typeorm';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import { SensorMetaCacheService } from '../sensor-meta-cache.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID_OTHER = '22222222-2222-2222-2222-222222222222';
const SENSOR_ID = '33333333-3333-3333-3333-333333333333';
const SENSOR_ID_OTHER = '44444444-4444-4444-4444-444444444444';
const CHANNEL_ID = '55555555-5555-5555-5555-555555555555';

function fakeSensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    id: SENSOR_ID,
    tenantId: TENANT_ID,
    ...overrides,
  } as unknown as Sensor;
}

function fakeChannel(overrides: Partial<SensorDataChannel> = {}): SensorDataChannel {
  return {
    id: CHANNEL_ID,
    sensorId: SENSOR_ID,
    tenantId: TENANT_ID,
    channelKey: 'temperature',
    isEnabled: true,
    ...overrides,
  } as unknown as SensorDataChannel;
}

function makeRepo<T extends ObjectLiteral>(
  impl: Partial<Repository<T>>,
): jest.Mocked<Repository<T>> {
  return impl as unknown as jest.Mocked<Repository<T>>;
}

function makeCache(opts?: {
  sensorFindOne?: jest.Mock;
  channelFind?: jest.Mock;
}) {
  const sensorFindOne =
    opts?.sensorFindOne ?? jest.fn().mockResolvedValue(fakeSensor());
  const channelFind =
    opts?.channelFind ?? jest.fn().mockResolvedValue([fakeChannel()]);
  const sensorRepo = makeRepo<Sensor>({ findOne: sensorFindOne });
  const channelRepo = makeRepo<SensorDataChannel>({ find: channelFind });
  const svc = new SensorMetaCacheService(sensorRepo, channelRepo);
  return { svc, sensorFindOne, channelFind };
}

describe('SensorMetaCacheService', () => {
  describe('getSensor', () => {
    it('hits repo on first call, cache on subsequent calls within TTL', async () => {
      const { svc, sensorFindOne } = makeCache();
      const a = await svc.getSensor(SENSOR_ID);
      const b = await svc.getSensor(SENSOR_ID);
      const c = await svc.getSensor(SENSOR_ID);
      expect(sensorFindOne).toHaveBeenCalledTimes(1);
      expect(a?.id).toBe(SENSOR_ID);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it('returns null for unknown sensor and does NOT cache the null', async () => {
      const sensorFindOne = jest.fn().mockResolvedValue(null);
      const { svc } = makeCache({ sensorFindOne });
      expect(await svc.getSensor(SENSOR_ID)).toBeNull();
      // Second call still hits the repo — caching null would block
      // legitimate "operator just registered the sensor" recovery.
      expect(await svc.getSensor(SENSOR_ID)).toBeNull();
      expect(sensorFindOne).toHaveBeenCalledTimes(2);
    });
  });

  describe('getChannels', () => {
    it('hits repo on first call, cache on subsequent calls within TTL', async () => {
      const { svc, channelFind } = makeCache();
      const a = await svc.getChannels(SENSOR_ID);
      const b = await svc.getChannels(SENSOR_ID);
      expect(channelFind).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
      expect(a.length).toBe(1);
    });

    it('does NOT cache an empty channel array', async () => {
      const channelFind = jest.fn().mockResolvedValue([]);
      const { svc } = makeCache({ channelFind });
      expect(await svc.getChannels(SENSOR_ID)).toEqual([]);
      expect(await svc.getChannels(SENSOR_ID)).toEqual([]);
      // Repeated misses re-fetch — operator may be wiring up channels
      // right now and the cache would otherwise mask the new shape.
      expect(channelFind).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateSensor', () => {
    it('drops both the sensor entry and the per-sensor channel entry', async () => {
      const { svc, sensorFindOne, channelFind } = makeCache();
      await svc.getSensor(SENSOR_ID);
      await svc.getChannels(SENSOR_ID);
      expect(svc._testSize()).toEqual({ sensors: 1, channels: 1 });
      svc.invalidateSensor(SENSOR_ID);
      expect(svc._testSize()).toEqual({ sensors: 0, channels: 0 });
      // Subsequent reads re-fetch.
      await svc.getSensor(SENSOR_ID);
      await svc.getChannels(SENSOR_ID);
      expect(sensorFindOne).toHaveBeenCalledTimes(2);
      expect(channelFind).toHaveBeenCalledTimes(2);
    });

    it('is idempotent for unknown sensor ids (no-op)', async () => {
      const { svc } = makeCache();
      expect(() => svc.invalidateSensor(SENSOR_ID)).not.toThrow();
      expect(svc._testSize()).toEqual({ sensors: 0, channels: 0 });
    });
  });

  describe('invalidateTenant', () => {
    it('drops every entry whose value tenantId matches, leaves others intact', async () => {
      const sensorFindOne = jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        if (where.id === SENSOR_ID) {
          return Promise.resolve(fakeSensor({ tenantId: TENANT_ID }));
        }
        if (where.id === SENSOR_ID_OTHER) {
          return Promise.resolve(
            fakeSensor({ id: SENSOR_ID_OTHER, tenantId: TENANT_ID_OTHER }),
          );
        }
        return Promise.resolve(null);
      });
      const { svc } = makeCache({ sensorFindOne });
      await svc.getSensor(SENSOR_ID);
      await svc.getChannels(SENSOR_ID);
      await svc.getSensor(SENSOR_ID_OTHER);
      await svc.getChannels(SENSOR_ID_OTHER);
      expect(svc._testSize()).toEqual({ sensors: 2, channels: 2 });

      svc.invalidateTenant(TENANT_ID);

      // Only TENANT_ID's entries should be gone; other tenant intact.
      expect(svc._testSize()).toEqual({ sensors: 1, channels: 1 });
      const remaining = await svc.getSensor(SENSOR_ID_OTHER);
      expect(remaining?.tenantId).toBe(TENANT_ID_OTHER);
    });

    it('is idempotent when no entries match the tenantId', async () => {
      const { svc } = makeCache();
      await svc.getSensor(SENSOR_ID);
      svc.invalidateTenant(TENANT_ID_OTHER);
      expect(svc._testSize()).toEqual({ sensors: 1, channels: 0 });
    });
  });

  describe('TTL_MS contract', () => {
    it('exposes TTL_MS as a public static (60s) — pinned for ops', () => {
      expect(SensorMetaCacheService.TTL_MS).toBe(60_000);
    });
  });
});
