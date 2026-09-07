import 'reflect-metadata';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';
import { stub } from '@aquaculture/testing';
// NATS v3: connect from @nats-io/transport-node; jetstream()/jetstreamManager()
// are top-level in @nats-io/jetstream.
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type {
  ConsumerAPI,
  ConsumerInfo,
  PubAck,
  Consumers,
  JetStreamClient,
  JetStreamManager,
  StreamAPI,
  StreamInfo,
} from '@nats-io/jetstream';
import type { NatsConnection, Status } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { HandlerOutcome } from '../../interfaces/handler-outcome';
import {
  DEFAULT_TELEMETRY_STREAM_NAME,
  buildRoutedSubject,
  buildRoutedWildcardSubject,
  streamNameForSubject,
  subjectRootForEventType,
} from '../event-route-registry';
import { NatsEventBus } from '../nats-event-bus';

jest.mock('@aquaculture/backend-common/nats', () => ({
  buildNatsConnectionOptions: jest.fn(),
}));

jest.mock('@nats-io/transport-node', () => {
  const actual =
    jest.requireActual<typeof import('@nats-io/transport-node')>('@nats-io/transport-node');
  return { ...actual, connect: jest.fn() };
});

jest.mock('@nats-io/jetstream', () => {
  const actual = jest.requireActual<typeof import('@nats-io/jetstream')>('@nats-io/jetstream');
  return { ...actual, jetstream: jest.fn(), jetstreamManager: jest.fn() };
});

/**
 * The bus opens ONE `for await` over `connection.status()` at connect() and
 * exits when it completes; this iterable completes immediately, so the boot
 * path runs with no connection-status events. Written as a typed
 * `AsyncIterable<Status>` so the double is checked against the real
 * `NatsConnection['status']` signature rather than asserted into it.
 */
function noConnectionStatuses(): AsyncIterable<Status> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<Status> => ({
      next: (): Promise<IteratorResult<Status>> =>
        Promise.resolve({ done: true, value: undefined }),
    }),
  };
}

// The doubles whose recorded calls the assertions read back are typed FROM the
// real API signatures, so `mock.calls` is checked against what the bus actually
// passes rather than asserted into shape at each read site.
type JsPublish = jest.Mock<
  ReturnType<JetStreamClient['publish']>,
  Parameters<JetStreamClient['publish']>
>;
type StreamAdd = jest.Mock<ReturnType<StreamAPI['add']>, Parameters<StreamAPI['add']>>;
type ConsumerAdd = jest.Mock<ReturnType<ConsumerAPI['add']>, Parameters<ConsumerAPI['add']>>;

/**
 * Task 2 (SENSOR-HIGH-092): telemetry/domain stream separation. The two
 * high-rate event types route onto AQUACULTURE_TELEMETRY; everything else
 * stays on AQUACULTURE_EVENTS; boot provisions the telemetry stream with
 * Discard New; normalizeSubject accepts the telemetry root.
 */
describe('Event route registry + telemetry stream (Task 2)', () => {
  let jsPublish: JsPublish;
  let consumersAdd: ConsumerAdd;
  let streamsAdd: StreamAdd;
  let streamsUpdate: jest.Mock;
  let streamsInfo: jest.Mock;

  async function boot(overrides: Record<string, unknown> = {}): Promise<NatsEventBus> {
    const configService = new ConfigService();
    const values: Record<string, unknown> = {
      NATS_URL: 'tls://nats:4222',
      NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
      SERVICE_NAME: 'sensor-service',
      NATS_MAX_RECONNECT_ATTEMPTS: '2',
      ...overrides,
    };
    jest
      .spyOn(configService, 'get')
      .mockImplementation((key: string, defaultValue?: unknown) =>
        key in values ? values[key] : defaultValue,
      );

    jsPublish = jest.fn<
      ReturnType<JetStreamClient['publish']>,
      Parameters<JetStreamClient['publish']>
    >(() => Promise.resolve(stub<PubAck>({ stream: 'X', seq: 1 })));
    consumersAdd = jest.fn<ReturnType<ConsumerAPI['add']>, Parameters<ConsumerAPI['add']>>(() =>
      Promise.resolve(stub<ConsumerInfo>({})),
    );
    streamsAdd = jest.fn<ReturnType<StreamAPI['add']>, Parameters<StreamAPI['add']>>(() =>
      Promise.resolve(stub<StreamInfo>({})),
    );
    streamsUpdate = jest.fn().mockResolvedValue(undefined);
    // Main stream already exists (→ update); DLQ + telemetry streams are
    // "not found" on this boot (→ add), which is what the assertions pin.
    streamsInfo = jest
      .fn()
      .mockImplementation((name: string) =>
        name === 'AQUACULTURE_EVENTS'
          ? Promise.resolve({})
          : Promise.reject(new Error('stream not found')),
      );

    // `stub`, not `collaborator`: a NatsConnection stands in for a VALUE here.
    // The bus legitimately READS members this boot path never sets (`info`,
    // consulted by the replica clamp) and must see `undefined` there, exactly
    // as a real connection to a standalone server yields.
    const connection = stub<NatsConnection>({
      status: () => noConnectionStatuses(),
      closed: () => new Promise<void>(() => undefined),
      drain: jest.fn(() => Promise.resolve()),
      close: jest.fn(() => Promise.resolve()),
      isClosed: () => false,
    });
    jest.mocked(connect).mockResolvedValue(connection);

    jest.mocked(jetstreamManager).mockResolvedValue(
      stub<JetStreamManager>({
        streams: stub<StreamAPI>({ info: streamsInfo, add: streamsAdd, update: streamsUpdate }),
        consumers: stub<ConsumerAPI>({ add: consumersAdd }),
      }),
    );
    jest.mocked(jetstream).mockReturnValue(
      stub<JetStreamClient>({
        publish: jsPublish,
        consumers: stub<Consumers>({
          get: jest.fn().mockResolvedValue({
            consume: () => Promise.resolve({ stop: jest.fn() }),
          }),
        }),
      }),
    );

    const bus = new NatsEventBus(configService);
    await bus.connect();
    return bus;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.mocked(buildNatsConnectionOptions).mockReturnValue({
      servers: ['tls://nats:4222'],
      reconnect: true,
      maxReconnectAttempts: 2,
      reconnectTimeWait: 1,
      authMode: 'mtls-cert',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('registry', () => {
    it('routes the two high-rate types to telemetry, everything else to events', () => {
      expect(subjectRootForEventType('SensorMetricIngested')).toBe('telemetry');
      expect(subjectRootForEventType('SensorReading')).toBe('telemetry');
      expect(subjectRootForEventType('BatchHarvested')).toBe('events');
      expect(subjectRootForEventType('TenantProvisioned')).toBe('events');
    });

    it('builds canonical routed subjects with the SSoT segment assertions', () => {
      expect(buildRoutedSubject('11111111-1111-4111-8111-111111111111', 'SensorReading')).toBe(
        'telemetry.11111111-1111-4111-8111-111111111111.SensorReading',
      );
      expect(buildRoutedSubject('t1', 'BatchCreated')).toBe('events.t1.BatchCreated');
      expect(buildRoutedWildcardSubject('SensorMetricIngested')).toBe(
        'telemetry.*.SensorMetricIngested',
      );
      expect(() => buildRoutedSubject('bad/tenant', 'SensorReading')).toThrow(/forbidden/);
    });

    it('maps subjects to their owning stream', () => {
      const streams = { main: 'AQUACULTURE_EVENTS', telemetry: DEFAULT_TELEMETRY_STREAM_NAME };
      expect(streamNameForSubject('telemetry.t1.SensorReading', streams)).toBe(
        DEFAULT_TELEMETRY_STREAM_NAME,
      );
      expect(streamNameForSubject('events.t1.BatchCreated', streams)).toBe('AQUACULTURE_EVENTS');
    });
  });

  describe('bus wiring', () => {
    it('boot provisions the telemetry stream with Discard New and a sized byte cap', async () => {
      await boot();

      const telemetryAdd = streamsAdd.mock.calls.find(
        (call) => call[0]['name'] === DEFAULT_TELEMETRY_STREAM_NAME,
      );
      if (!telemetryAdd) throw new Error('the telemetry stream was never added');
      const config = telemetryAdd[0];
      expect(config['subjects']).toEqual(['telemetry.>']);
      expect(config['discard']).toBe('new');
      expect(Number(config['max_bytes'])).toBeGreaterThan(0);
    });

    it('applies bounded allocation reductions to the actual stream declarations', async () => {
      await boot({ NATS_TELEMETRY_MAX_BYTES: '32768', NATS_DLQ_MAX_BYTES: '1024' });
      expect(streamsAdd).toHaveBeenCalledWith(expect.objectContaining({
        name: DEFAULT_TELEMETRY_STREAM_NAME,
        max_bytes: 32768,
      }));
      expect(streamsAdd).toHaveBeenCalledWith(expect.objectContaining({
        name: 'AQUACULTURE_DLQ',
        max_bytes: 1024,
      }));
    });

    it('publishes SensorReading onto the telemetry root', async () => {
      const bus = await boot();
      await bus.publish({
        eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        eventType: 'SensorReading',
        timestamp: '2026-08-25T00:00:00.000Z',
        tenantId: '11111111-1111-4111-8111-111111111111',
        version: 1,
        aggregateId: 's',
        aggregateType: 'Sensor',
      });

      const subjects = jsPublish.mock.calls.map((call) => call[0]);
      expect(subjects).toContain('telemetry.11111111-1111-4111-8111-111111111111.SensorReading');
    });

    it('keeps domain events on the events root (no behavior change)', async () => {
      const bus = await boot();
      await bus.publish({
        eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        eventType: 'BatchCreated',
        timestamp: '2026-08-25T00:00:00.000Z',
        tenantId: '11111111-1111-4111-8111-111111111111',
        version: 1,
        aggregateId: 'b',
        aggregateType: 'Batch',
      });

      const subjects = jsPublish.mock.calls.map((call) => call[0]);
      expect(subjects).toContain('events.11111111-1111-4111-8111-111111111111.BatchCreated');
      expect(subjects.some((s) => s.startsWith('telemetry.'))).toBe(false);
    });

    it('subscribes SensorReading with a durable on AQUACULTURE_TELEMETRY', async () => {
      const bus = await boot();
      await bus.subscribeWildcard('SensorReading', {
        // PLAT-HIGH-902: a handler reports a delivery outcome; `Promise.resolve()`
        // is no longer spellable, which is the point of the contract.
        handle: () => Promise.resolve(HandlerOutcome.ack()),
        // Required by IEventHandler. The cast this replaces hid its absence —
        // the double claimed to be a handler while missing half the contract.
        getEventType: () => 'SensorReading',
      });

      const call = consumersAdd.mock.calls.find(
        (c) => c[1]['filter_subject'] === 'telemetry.*.SensorReading',
      );
      if (!call) throw new Error('no telemetry consumer was added for SensorReading');
      expect(call[0]).toBe(DEFAULT_TELEMETRY_STREAM_NAME);
    });
  });
});
