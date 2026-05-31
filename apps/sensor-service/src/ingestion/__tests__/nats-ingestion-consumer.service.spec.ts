/**
 * NatsIngestionConsumerService unit tests — Faz 3 stage 2.
 *
 * Covers the Rust-sidecar → NestJS bridge contract:
 *   - SensorMetricIngested events from the sidecar are already
 *     persisted by Rust before outbox dispatch; this consumer never
 *     writes them a second time.
 *   - The typed SensorReadingEvent is re-emitted for downstream
 *     consumers, with channelKey selecting the readingXxx field.
 *   - Drops on unknown sensor / unknown channel / tenant mismatch
 *     never throw (would re-poison the JetStream consumer).
 *   - Cache TTL prevents redundant DB hits within the 60s window.
 */

import {
  IEventBus,
  IEventHandler,
} from '@platform/event-bus';
import { type SensorMetricIngestedEvent } from '@platform/event-contracts';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import { NatsIngestionConsumerService } from '../nats-ingestion-consumer.service';

const TENANT_ID  = '11111111-1111-1111-1111-111111111111';
const SENSOR_ID  = '22222222-2222-2222-2222-222222222222';
const CHANNEL_ID = '33333333-3333-3333-3333-333333333333';
const FARM_ID    = '44444444-4444-4444-4444-444444444444';
const POND_ID    = '55555555-5555-5555-5555-555555555555';

function fakeSensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    id: SENSOR_ID,
    tenantId: TENANT_ID,
    farmId: FARM_ID,
    pondId: POND_ID,
    ...overrides,
  } as unknown as Sensor;
}

function fakeChannel(channelKey: string, overrides: Partial<SensorDataChannel> = {}): SensorDataChannel {
  return {
    id: CHANNEL_ID,
    sensorId: SENSOR_ID,
    tenantId: TENANT_ID,
    channelKey,
    isEnabled: true,
    ...overrides,
  } as unknown as SensorDataChannel;
}

function fakeEvent(overrides: Partial<SensorMetricIngestedEvent> = {}): SensorMetricIngestedEvent {
  return {
    eventId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    eventType: 'SensorMetricIngested',
    timestamp: '2026-04-21T12:00:00.000Z',
    tenantId: TENANT_ID,
    version: 1,
    aggregateId: SENSOR_ID,
    aggregateType: 'Sensor',
    sensorId: SENSOR_ID,
    channelId: CHANNEL_ID,
    rawValue: 24.5,
    value: 24.5,
    qualityCode: 1,
    producerTs: 1_730_000_000_000,
    ...overrides,
  } as unknown as SensorMetricIngestedEvent;
}

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

function makeService(opts?: {
  bus?: IEventBus | null;
  sensor?: Sensor | null;
  channels?: SensorDataChannel[];
}) {
  // Faz 3 follow-on: cache extracted to SensorMetaCacheService. The
  // test uses a thin stub that returns whatever the test scenario
  // dictates, mirroring the real service's contract (null for missing
  // sensor, array for channels). No DB roundtrip in tests.
  const sensorMaybe =
    opts?.sensor === undefined ? fakeSensor() : opts.sensor;
  const channelArr = opts?.channels ?? [fakeChannel('temperature')];
  const metaCache = {
    getSensor: jest.fn().mockResolvedValue(sensorMaybe),
    getChannels: jest.fn().mockResolvedValue(channelArr),
    invalidateSensor: jest.fn(),
    invalidateTenant: jest.fn(),
  } as const;
  const bus = opts?.bus === undefined ? makeBus() : opts.bus;
  const svc = new NatsIngestionConsumerService(
    metaCache as unknown as import('../sensor-meta-cache.service').SensorMetaCacheService,
    bus,
  );
  return { svc, metaCache, bus };
}

describe('NatsIngestionConsumerService', () => {
  describe('IEventHandler contract', () => {
    it('exposes SUBJECT_PATTERN as the eventType', () => {
      const { svc } = makeService();
      expect(svc.getEventType()).toBe('events.*.SensorMetricIngested');
    });

    it('implements IEventHandler<SensorMetricIngestedEvent>', () => {
      const { svc } = makeService();
      const asHandler: IEventHandler<SensorMetricIngestedEvent> = svc;
      expect(typeof asHandler.handle).toBe('function');
      expect(typeof asHandler.getEventType).toBe('function');
    });
  });

  describe('lifecycle', () => {
    it('onModuleInit subscribes to SUBJECT_PATTERN when bus present', async () => {
      const bus = makeBus();
      const { svc } = makeService({ bus });
      try {
        await svc.onModuleInit();
        expect(bus.subscribeTo).toHaveBeenCalledWith(
          'events.*.SensorMetricIngested',
          svc,
        );
      } finally {
        // onModuleInit started a 60s statsTimer — cleanup so jest does
        // not flag an open handle.
        await svc.onModuleDestroy();
      }
    });

    it('onModuleInit logs warning when bus absent', async () => {
      const { svc } = makeService({ bus: null });
      // Must not throw — degradation is allowed when EVENT_BUS is not
      // wired (e.g. in unit tests of unrelated modules).
      await expect(svc.onModuleInit()).resolves.toBeUndefined();
    });

    it('onModuleDestroy unsubscribes when bus present', async () => {
      const bus = makeBus();
      const { svc } = makeService({ bus });
      await svc.onModuleInit();
      await svc.onModuleDestroy();
      expect(bus.unsubscribeFrom).toHaveBeenCalledWith(
        'events.*.SensorMetricIngested',
      );
    });

    it('onModuleDestroy is no-op when bus absent', async () => {
      const { svc } = makeService({ bus: null });
      await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('handle — drop semantics (no throw, no publish)', () => {
    it('drops events for unknown sensorId', async () => {
      const bus = makeBus();
      const { svc } = makeService({ sensor: null, bus });
      await svc.handle(fakeEvent());
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('drops events when payload tenantId mismatches sensor tenantId', async () => {
      const bus = makeBus();
      const sensor = fakeSensor({ tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
      const { svc } = makeService({ sensor, bus });
      await svc.handle(fakeEvent({ tenantId: TENANT_ID }));
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('drops events for unknown channelId', async () => {
      const bus = makeBus();
      const { svc } = makeService({
        channels: [fakeChannel('temperature', { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })],
        bus,
      });
      await svc.handle(fakeEvent());
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('never throws on drop paths (would poison JetStream consumer)', async () => {
      const { svc } = makeService({ sensor: null });
      await expect(svc.handle(fakeEvent())).resolves.toBeUndefined();
    });

    it('drops events that fail JSON Schema validation BEFORE touching the cache', async () => {
      // qualityCode: 99 violates the 0..=3 bound the schema enforces.
      // The event would have been rejected by the Rust producer's
      // serde(deny_unknown_fields), but the consumer-side validator
      // catches the case where a future producer somehow emits this.
      const metaCache = {
        getSensor: jest.fn().mockResolvedValue(fakeSensor()),
        getChannels: jest.fn().mockResolvedValue([fakeChannel('temperature')]),
        invalidateSensor: jest.fn(),
        invalidateTenant: jest.fn(),
      };
      const bus = makeBus();
      const svc = new NatsIngestionConsumerService(
        metaCache as unknown as import('../sensor-meta-cache.service').SensorMetaCacheService,
        bus,
      );
      await svc.handle(fakeEvent({ qualityCode: 99 }));
      // Schema rejection short-circuits BEFORE the cache lookup —
      // proves the validator runs first (defence in depth, not a
      // post-hoc check).
      expect(metaCache.getSensor).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  describe('handle — happy path', () => {
    it('publishes a typed SensorReadingEvent after Rust outbox dispatch (event-side farm/pond honored)', async () => {
      const bus = makeBus();
      const { svc } = makeService({ bus });
      await svc.handle(
        fakeEvent({ farmId: FARM_ID, pondId: POND_ID }),
      );
      expect(bus.publish).toHaveBeenCalledTimes(1);
      const firstCall = bus.publish.mock.calls[0];
      if (!firstCall) throw new Error('expected at least one publish call');
      // Cast through unknown — IEvent does not have a string index
      // signature, so the direct cast is rejected. The intent here is
      // shape introspection, not type narrowing.
      const ev = firstCall[0] as unknown as Record<string, unknown>;
      expect(ev['eventType']).toBe('SensorReading');
      expect(ev['sensorId']).toBe(SENSOR_ID);
      expect(ev['tenantId']).toBe(TENANT_ID);
      expect(ev['farmId']).toBe(FARM_ID);
      expect(ev['pondId']).toBe(POND_ID);
      expect(ev['readingTemperature']).toBe(24.5);
    });

    it('event-side farm/pond preferred over sensor cache when both present', async () => {
      // Faz 3 follow-on architectural payoff: the sidecar's resolved
      // farm/pond is the SoT when present. Sensor row in the consumer
      // cache might be stale relative to the sidecar's view (the
      // sidecar's lookup-responder reply is fresher than the
      // consumer's TTL-bounded cache after a recent write).
      //
      // Test setup: event carries farm A / pond A; sensor row carries
      // farm B / pond B. The consumer MUST prefer A on the typed
      // SensorReadingEvent — proving the fallback chain
      // `event.* ?? sensor.* ?? undefined` actually walks left-to-right.
      const EVENT_FARM = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const EVENT_POND = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
      const SENSOR_FARM = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa';
      const SENSOR_POND = 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb';
      const bus = makeBus();
      const { svc } = makeService({
        bus,
        sensor: fakeSensor({ farmId: SENSOR_FARM, pondId: SENSOR_POND }),
      });
      await svc.handle(
        fakeEvent({ farmId: EVENT_FARM, pondId: EVENT_POND }),
      );
      const typedEv = bus.publish.mock.calls[0]?.[0] as unknown as Record<
        string,
        unknown
      >;
      expect(typedEv['farmId']).toBe(EVENT_FARM);
      expect(typedEv['pondId']).toBe(EVENT_POND);
    });

    it('falls back to sensor cache farm/pond when event has none', async () => {
      // Cache-miss path on the sidecar side: the sidecar leaves
      // event.farmId / event.pondId absent. The consumer's own cache
      // covers the gap — defence-in-depth + cold-path correctness.
      // Test: event has no farm/pond; sensor row carries the values;
      // the typed event surfaces the sensor-side values.
      const bus = makeBus();
      const { svc } = makeService({
        bus,
        sensor: fakeSensor({ farmId: FARM_ID, pondId: POND_ID }),
      });
      await svc.handle(
        // Explicitly omit farmId / pondId from the event — the
        // sidecar's cold-path emission shape.
        fakeEvent({ farmId: undefined, pondId: undefined }),
      );
      const typedEv = bus.publish.mock.calls[0]?.[0] as unknown as Record<
        string,
        unknown
      >;
      expect(typedEv['farmId']).toBe(FARM_ID);
      expect(typedEv['pondId']).toBe(POND_ID);
    });

    it('publish failure does not throw — persistence already happened in Rust', async () => {
      const bus = makeBus();
      bus.publish.mockRejectedValueOnce(new Error('broker down'));
      const { svc } = makeService({ bus });
      await expect(svc.handle(fakeEvent())).resolves.toBeUndefined();
      expect(bus.publish).toHaveBeenCalledTimes(1);
    });
  });

  describe('typed-event mapper — channelKey dispatch', () => {
    const cases: Array<[string, keyof typeof readingFields]> = [
      ['temperature', 'readingTemperature'],
      ['Temp', 'readingTemperature'],
      ['ph', 'readingPh'],
      ['do', 'readingDissolvedOxygen'],
      ['dissolved_oxygen', 'readingDissolvedOxygen'],
      ['dissolvedOxygen', 'readingDissolvedOxygen'],
      ['salinity', 'readingSalinity'],
      ['ammonia', 'readingAmmonia'],
      ['nitrite', 'readingNitrite'],
      ['nitrate', 'readingNitrate'],
      ['turbidity', 'readingTurbidity'],
      ['water_level', 'readingWaterLevel'],
      ['waterLevel', 'readingWaterLevel'],
      ['level', 'readingWaterLevel'],
    ];

    const readingFields = {
      readingTemperature: true,
      readingPh: true,
      readingDissolvedOxygen: true,
      readingSalinity: true,
      readingAmmonia: true,
      readingNitrite: true,
      readingNitrate: true,
      readingTurbidity: true,
      readingWaterLevel: true,
    } as const;

    it.each(cases)(
      'channelKey "%s" → typed field "%s"',
      (channelKey, expectedField) => {
        const { svc } = makeService();
        const ev = svc._testBuildTypedReadingEvent(
          fakeEvent({ value: 99.9 }),
          fakeSensor(),
          fakeChannel(channelKey),
        );
        // Cast through unknown — SensorReadingEvent has no string
        // index signature; the intent is field-name lookup.
        const r = ev as unknown as Record<string, unknown>;
        expect(r[expectedField]).toBe(99.9);
      },
    );

    it('unknown channelKey omits all readingXxx fields', () => {
      const { svc } = makeService();
      const ev = svc._testBuildTypedReadingEvent(
        fakeEvent(),
        fakeSensor(),
        fakeChannel('exotic_unmapped_channel'),
      );
      const r = ev as unknown as Record<string, unknown>;
      for (const k of Object.keys(readingFields)) {
        expect(r[k]).toBeUndefined();
      }
      // The typed event still carries sensor + tenant + base fields.
      expect(ev.eventType).toBe('SensorReading');
      expect(ev.sensorId).toBe(SENSOR_ID);
    });
  });

  describe('cache delegation', () => {
    it('asks SensorMetaCacheService once per handle for sensor + channels', async () => {
      const { svc, metaCache } = makeService();
      await svc.handle(fakeEvent());
      await svc.handle(fakeEvent());
      await svc.handle(fakeEvent());
      // The TTL behaviour is owned by SensorMetaCacheService — this
      // test pins that the consumer asks the cache (not the DB)
      // exactly once per event for each of sensor + channels.
      expect(metaCache.getSensor).toHaveBeenCalledTimes(3);
      expect(metaCache.getChannels).toHaveBeenCalledTimes(3);
    });
  });
});
