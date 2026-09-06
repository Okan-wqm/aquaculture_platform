/**
 * SensorCacheInvalidationHandler unit tests — Faz 3 follow-on.
 *
 * Pins the contract:
 *   - Subscribes to the THREE lifecycle subjects on boot.
 *   - Each lifecycle event drops EXACTLY the matching sensor's
 *     cache entry (sensor + channels).
 *   - Failure semantics: cache exception logged, never thrown
 *     (idempotent redelivery is fine; poisoning the consumer is not).
 *   - Lifecycle: onModuleDestroy unsubscribes cleanly.
 */

import { IEventBus, IEventHandler } from '@platform/event-bus';
import type {
  SensorConfigurationUpdatedEvent,
  SensorReactivatedEvent,
  SensorSuspendedEvent,
} from '@platform/event-contracts';

import { SensorCacheInvalidationHandler } from '../sensor-cache-invalidation.handler';
import { SensorMetaCacheService } from '../sensor-meta-cache.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const SENSOR_ID = '22222222-2222-2222-2222-222222222222';

function makeBus(): jest.Mocked<IEventBus> {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
    subscribeTo: jest.fn().mockResolvedValue(undefined),
    unsubscribeFrom: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    publishBatch: jest.fn().mockResolvedValue(undefined),
    publishTo: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
  } as unknown as jest.Mocked<IEventBus>;
}

function makeCache() {
  return {
    invalidateSensor: jest.fn(),
    invalidateTenant: jest.fn(),
    getSensor: jest.fn(),
    getChannels: jest.fn(),
  } as unknown as jest.Mocked<SensorMetaCacheService>;
}

function makeHandler(opts?: {
  bus?: IEventBus | null;
  cache?: jest.Mocked<SensorMetaCacheService>;
}) {
  const cache = opts?.cache ?? makeCache();
  const bus = opts?.bus === undefined ? makeBus() : opts.bus;
  const handler = new SensorCacheInvalidationHandler(cache, bus);
  return { handler, cache, bus };
}

const SUBJECTS = [
  'events.*.SensorConfigurationUpdated',
  'events.*.SensorSuspended',
  'events.*.SensorReactivated',
];

const lifecycleEventCases: Array<[string, () => SensorConfigurationUpdatedEvent | SensorSuspendedEvent | SensorReactivatedEvent]> = [
  [
    'SensorConfigurationUpdated',
    () =>
      ({
        eventId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        eventType: 'SensorConfigurationUpdated',
        timestamp: '2026-04-21T12:00:00.000Z',
        tenantId: TENANT_ID,
        sensorId: SENSOR_ID,
        protocolCode: 'MQTT',
        changedFields: ['channels'],
        version: 1,
      } as unknown as SensorConfigurationUpdatedEvent),
  ],
  [
    'SensorSuspended',
    () =>
      ({
        eventId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        eventType: 'SensorSuspended',
        timestamp: '2026-04-21T12:00:00.000Z',
        tenantId: TENANT_ID,
        sensorId: SENSOR_ID,
        reason: 'admin',
        version: 1,
      } as unknown as SensorSuspendedEvent),
  ],
  [
    'SensorReactivated',
    () =>
      ({
        eventId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        eventType: 'SensorReactivated',
        timestamp: '2026-04-21T12:00:00.000Z',
        tenantId: TENANT_ID,
        sensorId: SENSOR_ID,
        version: 1,
      } as unknown as SensorReactivatedEvent),
  ],
];

describe('SensorCacheInvalidationHandler', () => {
  describe('IEventHandler contract', () => {
    it('implements IEventHandler<SensorLifecycleEvent>', () => {
      const { handler } = makeHandler();
      const asHandler: IEventHandler = handler;
      expect(typeof asHandler.handle).toBe('function');
      expect(typeof asHandler.getEventType).toBe('function');
    });

    it('getEventType returns a descriptive multi-subject string', () => {
      const { handler } = makeHandler();
      // Three subjects subscribed; getEventType is informational only.
      expect(handler.getEventType()).toMatch(/Sensor/);
    });
  });

  describe('lifecycle', () => {
    it('subscribes to all three lifecycle subjects when bus present', async () => {
      const bus = makeBus();
      const { handler } = makeHandler({ bus });
      try {
        await handler.onModuleInit();
        for (const subject of SUBJECTS) {
          expect(bus.subscribeTo).toHaveBeenCalledWith(subject, handler);
        }
      } finally {
        await handler.onModuleDestroy();
      }
    });

    it('logs warning + skips subscribe when bus absent', async () => {
      const { handler } = makeHandler({ bus: null });
      await expect(handler.onModuleInit()).resolves.toBeUndefined();
    });

    it('unsubscribes from all three subjects on destroy', async () => {
      const bus = makeBus();
      const { handler } = makeHandler({ bus });
      await handler.onModuleInit();
      await handler.onModuleDestroy();
      for (const subject of SUBJECTS) {
        expect(bus.unsubscribeFrom).toHaveBeenCalledWith(subject);
      }
    });

    it('onModuleDestroy is no-op when bus absent', async () => {
      const { handler } = makeHandler({ bus: null });
      await expect(handler.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('handle — invalidation', () => {
    it.each(lifecycleEventCases)(
      '%s drops the matching sensor cache entry',
      async (_name, makeEvent) => {
        const { handler, cache } = makeHandler();
        await handler.handle(makeEvent());
        expect(cache.invalidateSensor).toHaveBeenCalledTimes(1);
        expect(cache.invalidateSensor).toHaveBeenCalledWith(SENSOR_ID);
      },
    );

    it('never throws when the cache implementation throws (avoids JetStream poison-pill)', async () => {
      const cache = makeCache();
      cache.invalidateSensor.mockImplementation(() => {
        throw new Error('cache boom');
      });
      const { handler } = makeHandler({ cache });
      // The handler MUST catch the throw and acknowledge — invalidation is
      // idempotent and the cache self-heals on TTL, so a buggy cache layer
      // must not lock the entire lifecycle subscription in redelivery.
      await expect(
        handler.handle(lifecycleEventCases[0]![1]()),
      ).resolves.toEqual({ kind: 'ack' });
    });
  });
});
