/**
 * NatsIngestionConsumerService unit tests — Faz 3 stage 2.
 *
 * Covers the Rust-sidecar → NestJS bridge contract:
 *   - SensorMetricIngested events from the sidecar are persisted via
 *     the existing SensorMetricWriterService.enqueue path.
 *   - The typed SensorReadingEvent is re-emitted for downstream
 *     consumers, with channelKey selecting the readingXxx field.
 *   - Drops on unknown sensor / unknown channel / tenant mismatch
 *     never throw (would re-poison the JetStream consumer).
 *   - Cache TTL prevents redundant DB hits within the 60s window.
 */

import { ConfigService } from '@nestjs/config';

import {
  IEventBus,
  IEventHandler,
} from '@platform/event-bus';
import { type SensorMetricIngestedEvent } from '@platform/event-contracts';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import { SensorMetricWriterService } from '../sensor-metric-writer.service';
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

function makeBatch(): jest.Mocked<SensorMetricWriterService> {
  const mock: Partial<jest.Mocked<SensorMetricWriterService>> = {
    enqueue: jest.fn(),
    enqueueBatch: jest.fn(),
  };
  return mock as jest.Mocked<SensorMetricWriterService>;
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
  batch?: jest.Mocked<SensorMetricWriterService>;
  fanout?: { fanoutMetric: jest.Mock; drainStats: jest.Mock } | null;
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
  const batch = opts?.batch ?? makeBatch();
  const bus = opts?.bus === undefined ? makeBus() : opts.bus;
  const config = { get: jest.fn() } as unknown as ConfigService;
  const fanout = opts?.fanout === undefined ? null : opts.fanout;
  const svc = new NatsIngestionConsumerService(
    batch,
    config,
    metaCache as unknown as import('../sensor-meta-cache.service').SensorMetaCacheService,
    bus,
    // Structural stub — TagValueFanoutService has private members, so the
    // plain object stub is injected via `as never` (repo test convention).
    fanout as never,
  );
  return { svc, metaCache, batch, bus, fanout };
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

  describe('handle — drop semantics (no throw, no enqueue)', () => {
    it('drops events for unknown sensorId', async () => {
      const batch = makeBatch();
      const { svc } = makeService({ sensor: null, batch });
      await svc.handle(fakeEvent());
      expect(batch.enqueue).not.toHaveBeenCalled();
    });

    it('drops events when payload tenantId mismatches sensor tenantId', async () => {
      const batch = makeBatch();
      const sensor = fakeSensor({ tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
      const { svc } = makeService({ sensor, batch });
      await svc.handle(fakeEvent({ tenantId: TENANT_ID }));
      expect(batch.enqueue).not.toHaveBeenCalled();
    });

    it('drops events for unknown channelId', async () => {
      const batch = makeBatch();
      const { svc } = makeService({
        channels: [fakeChannel('temperature', { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })],
        batch,
      });
      await svc.handle(fakeEvent());
      expect(batch.enqueue).not.toHaveBeenCalled();
    });

    it('never throws on drop paths (would poison JetStream consumer)', async () => {
      const { svc } = makeService({ sensor: null });
      await expect(svc.handle(fakeEvent())).resolves.toEqual({ kind: 'ack' });
    });

    it('drops events that fail JSON Schema validation BEFORE touching the cache', async () => {
      // qualityCode: 99 violates the 0..=3 bound the schema enforces.
      // The event would have been rejected by the Rust producer's
      // serde(deny_unknown_fields), but the consumer-side validator
      // catches the case where a future producer somehow emits this.
      const batch = makeBatch();
      const metaCache = {
        getSensor: jest.fn().mockResolvedValue(fakeSensor()),
        getChannels: jest.fn().mockResolvedValue([fakeChannel('temperature')]),
        invalidateSensor: jest.fn(),
        invalidateTenant: jest.fn(),
      };
      const svc = new NatsIngestionConsumerService(
        batch,
        { get: jest.fn() } as unknown as ConfigService,
        metaCache as unknown as import('../sensor-meta-cache.service').SensorMetaCacheService,
        makeBus(),
        null,
      );
      await svc.handle(fakeEvent({ qualityCode: 99 }));
      // Schema rejection short-circuits BEFORE the cache lookup —
      // proves the validator runs first (defence in depth, not a
      // post-hoc check).
      expect(metaCache.getSensor).not.toHaveBeenCalled();
      expect(batch.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('handle — happy path', () => {
    it('enqueues a SensorMetricInput onto BatchProcessor (event-side farm/pond honored)', async () => {
      // Faz 3 follow-on: the sidecar populates `event.farmId` /
      // `event.pondId` from its warm cache. The consumer MUST honor
      // those values (event-side is the SoT when the cache was warm
      // at publish time). This test threads explicit event-side
      // values that match the sensor row to keep the assertion shape
      // unchanged from the pre-Faz-3-follow-on behaviour while
      // proving the new fallback chain accepts the event-side path.
      const batch = makeBatch();
      const { svc } = makeService({ batch });
      await svc.handle(
        fakeEvent({ farmId: FARM_ID, pondId: POND_ID }),
      );
      expect(batch.enqueue).toHaveBeenCalledTimes(1);
      const firstCall = batch.enqueue.mock.calls[0];
      if (!firstCall) throw new Error('expected at least one enqueue call');
      const arg = firstCall[0];
      expect(arg).toMatchObject({
        sensorId: SENSOR_ID,
        channelId: CHANNEL_ID,
        tenantId: TENANT_ID,
        rawValue: 24.5,
        value: 24.5,
        qualityCode: 1,
        sourceProtocol: 'rust-sidecar',
        farmId: FARM_ID,
        pondId: POND_ID,
      });
      // time / sourceTimestamp must be Date (not number) — match the
      // existing SensorMetricInput contract.
      expect(arg.time).toBeInstanceOf(Date);
      expect(arg.sourceTimestamp).toBeInstanceOf(Date);
      // 1_730_000_000_000 ms since UNIX epoch = 2024-10-27T03:33:20Z.
      // Pin the producerTs → time conversion so a future Date(0)
      // refactor cannot silently shift the persisted timestamp.
      expect(arg.time?.toISOString()).toBe('2024-10-27T03:33:20.000Z');
    });

    it('fans the metric out to the /scada control plane after enqueue (SENSOR-HIGH-046)', async () => {
      const batch = makeBatch();
      const fanout = {
        fanoutMetric: jest.fn().mockResolvedValue(undefined),
        drainStats: jest.fn().mockReturnValue({ pushed: 0, unmapped: 0 }),
      };
      const { svc } = makeService({ batch, fanout });

      await svc.handle(fakeEvent());

      expect(batch.enqueue).toHaveBeenCalledTimes(1); // persistence unaffected
      expect(fanout.fanoutMetric).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        sensorId: SENSOR_ID,
        channelId: CHANNEL_ID,
        value: 24.5,
        timestampMs: 1_730_000_000_000,
        qualityCode: 1,
      });
    });

    it('handles events normally when the fanout service is not mounted', async () => {
      const batch = makeBatch();
      const { svc } = makeService({ batch, fanout: null });
      await expect(svc.handle(fakeEvent())).resolves.toEqual({ kind: 'ack' });
      expect(batch.enqueue).toHaveBeenCalledTimes(1);
    });

    it('publishes a typed SensorReadingEvent after enqueue (event-side farm/pond honored)', async () => {
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
      // farm B / pond B. The consumer MUST prefer A on BOTH the
      // SensorMetricInput AND the typed SensorReadingEvent — proving
      // the fallback chain `event.* ?? sensor.* ?? undefined` actually
      // walks left-to-right.
      const EVENT_FARM = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const EVENT_POND = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
      const SENSOR_FARM = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa';
      const SENSOR_POND = 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb';
      const batch = makeBatch();
      const bus = makeBus();
      const { svc } = makeService({
        batch,
        bus,
        sensor: fakeSensor({ farmId: SENSOR_FARM, pondId: SENSOR_POND }),
      });
      await svc.handle(
        fakeEvent({ farmId: EVENT_FARM, pondId: EVENT_POND }),
      );
      // SensorMetricInput receives the EVENT-side ids.
      const enqArg = batch.enqueue.mock.calls[0]?.[0];
      if (!enqArg) throw new Error('expected enqueue arg');
      expect(enqArg.farmId).toBe(EVENT_FARM);
      expect(enqArg.pondId).toBe(EVENT_POND);
      // Typed event also carries the EVENT-side ids.
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
      // both the SensorMetricInput AND the typed event surface the
      // sensor-side values.
      const batch = makeBatch();
      const bus = makeBus();
      const { svc } = makeService({
        batch,
        bus,
        sensor: fakeSensor({ farmId: FARM_ID, pondId: POND_ID }),
      });
      await svc.handle(
        // Explicitly omit farmId / pondId from the event — the
        // sidecar's cold-path emission shape.
        fakeEvent({ farmId: undefined, pondId: undefined }),
      );
      const enqArg = batch.enqueue.mock.calls[0]?.[0];
      if (!enqArg) throw new Error('expected enqueue arg');
      expect(enqArg.farmId).toBe(FARM_ID);
      expect(enqArg.pondId).toBe(POND_ID);
      const typedEv = bus.publish.mock.calls[0]?.[0] as unknown as Record<
        string,
        unknown
      >;
      expect(typedEv['farmId']).toBe(FARM_ID);
      expect(typedEv['pondId']).toBe(POND_ID);
    });

    it('publish failure does not abort persistence — enqueue already happened', async () => {
      const bus = makeBus();
      bus.publish.mockRejectedValueOnce(new Error('broker down'));
      const batch = makeBatch();
      const { svc } = makeService({ bus, batch });
      await expect(svc.handle(fakeEvent())).resolves.toEqual({ kind: 'ack' });
      expect(batch.enqueue).toHaveBeenCalledTimes(1);
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
