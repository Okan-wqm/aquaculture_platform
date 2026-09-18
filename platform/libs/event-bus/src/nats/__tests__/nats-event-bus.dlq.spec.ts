import 'reflect-metadata';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';
import { stub } from '@aquaculture/testing';
// NATS v3: connect from @nats-io/transport-node; jetstream()/jetstreamManager()
// are top-level in @nats-io/jetstream.
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type {
  ConsumerAPI,
  PubAck,
  Consumers,
  JetStreamClient,
  JetStreamManager,
  StreamAPI,
} from '@nats-io/jetstream';
import type { NatsConnection, Status } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { DlqEnvelope } from '../dlq-envelope';
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

/**
 * Task 1 Step 1.6 (SENSOR-HIGH-093): the dead-letter chain. A message that
 * keeps failing is moved to AQUACULTURE_DLQ as an envelope — the original
 * is finished only AFTER the DLQ copy's PubAck; if the DLQ hop itself fails,
 * the original is NAK'd (never finished into loss).
 *
 * PLAT-HIGH-902 finishes it with `term()` rather than `ack()`. The ordering
 * property this suite exists to pin is unchanged — the DLQ PubAck still
 * strictly precedes it — but acking a dead-lettered message spells failure
 * the same way as success, which is the conflation that finding closes.
 * `term()` also raises the JetStream MSG_TERMINATED advisory an operator can
 * alert on, where an ack is silent.
 */
// The doubles whose recorded calls the assertions read back are typed FROM the
// real API signatures, so `mock.calls` is checked against what the bus actually
// passes instead of being asserted into shape at each read site.
type JsPublish = jest.Mock<
  ReturnType<JetStreamClient['publish']>,
  Parameters<JetStreamClient['publish']>
>;

describe('NatsEventBus dead-letter chain (Task 1.6)', () => {
  let consumeCallback: ((msg: unknown) => void) | null;
  let jsPublish: JsPublish;
  let bus: NatsEventBus;

  const EVENT = {
    eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    eventType: 'SensorReading',
    timestamp: '2026-08-24T00:00:00.000Z',
    tenantId: '11111111-1111-4111-8111-111111111111',
    version: 1,
    aggregateId: 's',
    aggregateType: 'Sensor',
    sensorId: 's',
    readings: { temperature: 1 },
  };

  function makeMsg(deliveryCount: number): {
    string: () => string;
    subject: string;
    seq: number;
    info: { deliveryCount: number };
    ack: jest.Mock;
    nak: jest.Mock;
    term: jest.Mock;
  } {
    return {
      string: () => JSON.stringify(EVENT),
      subject: 'events.11111111-1111-4111-8111-111111111111.SensorReading',
      seq: 77,
      info: { deliveryCount },
      ack: jest.fn(),
      nak: jest.fn(),
      term: jest.fn(),
    };
  }

  async function boot(): Promise<void> {
    const configService = new ConfigService();
    const values: Record<string, unknown> = {
      NATS_URL: 'tls://nats:4222',
      NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
      SERVICE_NAME: 'sensor-service',
      NATS_MAX_RECONNECT_ATTEMPTS: '2',
    };
    jest
      .spyOn(configService, 'get')
      .mockImplementation((key: string, defaultValue?: unknown) =>
        key in values ? values[key] : defaultValue,
      );

    consumeCallback = null;
    jsPublish = jest.fn<
      ReturnType<JetStreamClient['publish']>,
      Parameters<JetStreamClient['publish']>
    >(() => Promise.resolve(stub<PubAck>({ stream: 'AQUACULTURE_DLQ', seq: 1 })));

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
        streams: stub<StreamAPI>({
          info: jest.fn().mockRejectedValueOnce(new Error('not found')).mockResolvedValue({}),
          update: jest.fn().mockResolvedValue(undefined),
          add: jest.fn().mockResolvedValue({}),
        }),
        consumers: stub<ConsumerAPI>({ add: jest.fn().mockResolvedValue({}) }),
      }),
    );

    jest.mocked(jetstream).mockReturnValue(
      stub<JetStreamClient>({
        publish: jsPublish,
        consumers: stub<Consumers>({
          get: jest.fn().mockResolvedValue({
            consume: (opts: { callback: (msg: unknown) => void }) => {
              consumeCallback = opts.callback;
              return Promise.resolve({ stop: jest.fn() });
            },
          }),
        }),
      }),
    );

    bus = new NatsEventBus(configService);
    await bus.connect();
    await bus.subscribeTo('events.*.SensorReading', {
      handle: () => Promise.reject(new Error('db down')),
      // Required by IEventHandler. The cast this replaces hid its absence —
      // the double claimed to be a handler while missing half the contract.
      getEventType: () => 'SensorReading',
    });
    await new Promise((r) => setTimeout(r, 0));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
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

  function requireCallback(): (msg: unknown) => void {
    if (!consumeCallback) throw new Error('consume callback was not captured');
    return consumeCallback;
  }

  it('NAKs with backoff while under the delivery threshold — no DLQ, no ack', async () => {
    await boot();
    const msg = makeMsg(2);
    // The bus's consume callback is synchronous (`void this.processConsumerMessage`),
    // so there is nothing to await on the call itself — the macrotask flush below
    // is what lets the detached handling promise settle.
    requireCallback()(msg);
    await new Promise((r) => setTimeout(r, 0));

    expect(msg.nak).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.term).not.toHaveBeenCalled();
    expect(jsPublish).not.toHaveBeenCalled();
  });

  it('dead-letters at the threshold: envelope PubAck BEFORE the original ack', async () => {
    await boot();
    const msg = makeMsg(5);
    // The bus's consume callback is synchronous (`void this.processConsumerMessage`),
    // so there is nothing to await on the call itself — the macrotask flush below
    // is what lets the detached handling promise settle.
    requireCallback()(msg);
    await new Promise((r) => setTimeout(r, 0));

    expect(jsPublish).toHaveBeenCalledTimes(1);
    const firstCall = jsPublish.mock.calls[0];
    if (!firstCall) throw new Error('js.publish was not called');
    const [subject, body, opts] = firstCall;
    expect(subject).toBe('dlq.11111111-1111-4111-8111-111111111111.SensorReading');
    // `publish` accepts any Payload; the bus dead-letters a JSON string, and a
    // non-string here would be the defect this test exists to catch.
    if (typeof body !== 'string') throw new Error('the DLQ envelope was not published as a string');
    const envelope = JSON.parse(body) as DlqEnvelope;
    expect(envelope['originalSubject']).toBe(msg.subject);
    expect(envelope['originalStream']).toBe('AQUACULTURE_EVENTS');
    expect(envelope['deliveryCount']).toBe(5);
    expect(envelope['failureClass']).toBe('handler-failure');
    expect(Buffer.from(envelope['payloadBase64'], 'base64').toString('utf8')).toBe(
      JSON.stringify(EVENT),
    );
    // Identity-preserving msgID: replay tooling relies on it for dedup.
    expect(opts?.msgID).toContain('77');

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
    // Ordering: the DLQ copy must be durably stored BEFORE the original dies.
    const publishOrder = jsPublish.mock.invocationCallOrder[0];
    const termOrder = msg.term.mock.invocationCallOrder[0];
    if (publishOrder === undefined || termOrder === undefined) {
      throw new Error('ordering evidence missing');
    }
    expect(publishOrder).toBeLessThan(termOrder);
  });

  it('never finishes into loss when the DLQ hop itself fails — NAK instead', async () => {
    await boot();
    jsPublish.mockRejectedValue(new Error('dlq stream unavailable'));
    const msg = makeMsg(9);
    // The bus's consume callback is synchronous (`void this.processConsumerMessage`),
    // so there is nothing to await on the call itself — the macrotask flush below
    // is what lets the detached handling promise settle.
    requireCallback()(msg);
    await new Promise((r) => setTimeout(r, 0));

    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.term).not.toHaveBeenCalled();
    expect(msg.nak).toHaveBeenCalled();
  });
});
