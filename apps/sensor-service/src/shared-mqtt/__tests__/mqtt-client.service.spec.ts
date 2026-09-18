import { EventEmitter } from 'node:events';

import { ConfigService } from '@nestjs/config';
import type { IPublishPacket } from 'mqtt';

import { MqttClientService } from '../mqtt-client.service';

/**
 * SENSOR-CRITICAL-086 (plan CRITICAL-001, Task 1 Step 1.2): the MQTT read
 * path must not release PUBACK before the message is durably handled. The
 * client therefore (a) uses a STABLE persistent-session identity
 * (MQTT_CLIENT_ID prefix, clean:false — the old PID/timestamp clientId
 * discarded the broker-side session on every restart) and (b) overrides
 * mqtt.js handleMessage so the library's ack callback fires only after every
 * registered handler settled; a failure or 10s deadline force-reconnects
 * WITHOUT acking, so the persistent session redelivers.
 */

jest.mock('mqtt', () => {
  const connect = jest.fn();
  return { __esModule: true, connect };
});

const mqttMock = jest.requireMock('mqtt') as { connect: jest.Mock };

interface FakeClient extends EventEmitter {
  subscribe: jest.Mock;
  end: jest.Mock;
  removeAllListeners: jest.Mock;
  handleMessage?: (packet: IPublishPacket, done: (error?: Error) => void) => void;
}

function fakeClient(): FakeClient {
  const client = new EventEmitter() as FakeClient;
  client.subscribe = jest.fn((_topics: unknown, _opts: unknown, cb: (e?: Error) => void) =>
    cb(undefined),
  );
  client.end = jest.fn((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
    cb?.();
    return client;
  });
  client.removeAllListeners = jest.fn();
  return client;
}

function makeConfig(env: Record<string, string> = {}): ConfigService {
  // Real instance over a plain record: no cast shims, and get(key, default)
  // semantics match production.
  return new ConfigService(env);
}

function packet(): IPublishPacket {
  return {
    cmd: 'publish',
    topic: 'tenants/t1/devices/d1/io_data',
    payload: Buffer.from('{"v":24.5}'),
    qos: 1,
    dup: false,
    retain: false,
    messageId: 42,
  } as IPublishPacket;
}

async function connectService(
  env: Record<string, string>,
): Promise<{ service: MqttClientService; client: FakeClient }> {
  const client = fakeClient();
  mqttMock.connect.mockReturnValueOnce(client);
  const service = new MqttClientService(makeConfig(env));
  const connected = service.connect();
  client.emit('connect');
  await connected;
  return { service, client };
}

describe('MqttClientService durable PUBACK (SENSOR-CRITICAL-086)', () => {
  beforeEach(() => {
    mqttMock.connect.mockReset();
  });

  it('fails closed without MQTT_CLIENT_ID — persistent sessions need a stable identity', async () => {
    const service = new MqttClientService(makeConfig({}));
    await expect(service.connect()).rejects.toThrow(/MQTT_CLIENT_ID/);
    expect(mqttMock.connect).not.toHaveBeenCalled();
  });

  it('connects with a stable prefix-derived clientId and clean:false', async () => {
    await connectService({ MQTT_CLIENT_ID: 'aqua-sensor-service' });

    const [, options] = mqttMock.connect.mock.calls[0] as [string, Record<string, unknown>];
    expect(options['clean']).toBe(false);
    expect(options['clientId']).toBe('aqua-sensor-service-main');
    expect(String(options['clientId'])).not.toMatch(/\d{10,}/); // no pid/timestamp churn
  });

  it('releases PUBACK only after every handler settled', async () => {
    const { service, client } = await connectService({ MQTT_CLIENT_ID: 'aqua-x' });
    let resolveHandler!: () => void;
    service.addMessageHandler(
      (_topic, _message) => new Promise<void>((resolve) => (resolveHandler = resolve)),
    );

    const done = jest.fn();
    client.handleMessage!(packet(), done);

    await Promise.resolve();
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled(); // handler still pending → no PUBACK

    resolveHandler();
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();
  });

  it('a handler failure force-reconnects WITHOUT acking (redelivery)', async () => {
    const { service, client } = await connectService({ MQTT_CLIENT_ID: 'aqua-x' });
    service.addMessageHandler(() => Promise.reject(new Error('db down')));

    const done = jest.fn();
    client.handleMessage!(packet(), done);

    await new Promise((r) => setTimeout(r, 0));
    expect(done).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledWith(true);
  });

  it('a 10s settle deadline force-reconnects without acking', async () => {
    jest.useFakeTimers();
    try {
      const { service, client } = await connectService({ MQTT_CLIENT_ID: 'aqua-x' });
      service.addMessageHandler(() => new Promise<void>(() => undefined)); // never settles

      const done = jest.fn();
      client.handleMessage!(packet(), done);

      await Promise.resolve();
      expect(done).not.toHaveBeenCalled();
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(done).not.toHaveBeenCalled();
      expect(client.end).toHaveBeenCalledWith(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never acks a message that arrives during shutdown — it redelivers after restart', async () => {
    const { service, client } = await connectService({ MQTT_CLIENT_ID: 'aqua-x' });
    const handler = jest.fn();
    service.addMessageHandler(handler);
    await service.onModuleDestroy();

    const done = jest.fn();
    client.handleMessage!(packet(), done);

    expect(handler).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
});

// ─── SENSOR-HIGH-118: per-topic SUBSCRIBE isolation ──────────────────────────
//
// The old single-packet object subscribe made one denied filter (SUBACK 0x80)
// fail the WHOLE call — the listener stayed connected but subscribed to
// nothing. Per-topic packets isolate the denial; the denied filter surfaces
// as an error log while every other filter still subscribes.

describe('MqttClientService per-topic SUBSCRIBE isolation (SENSOR-HIGH-118)', () => {
  beforeEach(() => {
    mqttMock.connect.mockReset();
  });

  it('sends one SUBSCRIBE packet per topic (no single batched object)', async () => {
    const { service, client } = await connectService({
      MQTT_CLIENT_ID: 'aqua-sensor-service-test',
    });
    client.subscribe.mockImplementation(
      (_t: unknown, _o: unknown, cb: (e?: Error, g?: Array<{ qos: number }>) => void) =>
        cb(undefined, [{ qos: 1 }]),
    );

    await service.subscribe(
      ['sensors/#', 'aquaculture/+/sensors/#', 'tenants/+/devices/+/telemetry'],
      1,
    );

    expect(client.subscribe).toHaveBeenCalledTimes(3);
    const args = client.subscribe.mock.calls.map((c) => c[0]);
    expect(args).toEqual(['sensors/#', 'aquaculture/+/sensors/#', 'tenants/+/devices/+/telemetry']);
  });

  it('a denied filter (SUBACK 0x80) does not fail the others and does not throw', async () => {
    const { service, client } = await connectService({
      MQTT_CLIENT_ID: 'aqua-sensor-service-test',
    });
    client.subscribe.mockImplementation(
      (topic: unknown, _o: unknown, cb: (e?: Error, g?: Array<{ qos: number }>) => void) => {
        if (topic === '+/+/+/temperature-array') cb(new Error('Unspecified error'), [{ qos: 128 }]);
        else cb(undefined, [{ qos: 1 }]);
      },
    );

    await expect(
      service.subscribe(['sensors/#', '+/+/+/temperature-array', 'tenants/+/devices/+/io_data'], 1),
    ).resolves.toBeUndefined();

    expect(client.subscribe).toHaveBeenCalledTimes(3); // every packet attempted
    expect(service.isSubscribed('sensors/#')).toBe(true);
    expect(service.isSubscribed('tenants/+/devices/+/io_data')).toBe(true);
    expect(service.isSubscribed('+/+/+/temperature-array')).toBe(false); // denied, not tracked
  });

  it('treats granted qos 128 without an error object as a denial too', async () => {
    const { service, client } = await connectService({
      MQTT_CLIENT_ID: 'aqua-sensor-service-test',
    });
    client.subscribe.mockImplementation(
      (_t: unknown, _o: unknown, cb: (e?: Error, g?: Array<{ qos: number }>) => void) =>
        cb(undefined, [{ qos: 128 }]),
    );

    await expect(service.subscribe(['sensors/#'], 1)).resolves.toBeUndefined();
    expect(service.isSubscribed('sensors/#')).toBe(false);
  });

  it('still rejects when called while disconnected', async () => {
    const { service } = await connectService({ MQTT_CLIENT_ID: 'aqua-sensor-service-test' });
    Reflect.set(service, 'client', null);
    await expect(service.subscribe(['sensors/#'])).rejects.toThrow('Not connected');
  });
});
