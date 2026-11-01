import type { NatsConnection } from '@nats-io/nats-core';

import { PersistentNatsConnection } from '../persistent-nats-connection';

import { FakeNatsServer } from './support/fake-nats-server';

const SUBJECT = 'events.tenant-1.TankUpdated';
/** Variables the factory reads; the spec runs each test without them, then restores them. */
const ENV_KEYS: readonly string[] = [
  'NATS_URL',
  'NATS_RECONNECT_TIME_WAIT_MS',
  'NATS_MAX_RECONNECT_ATTEMPTS',
  'NATS_TLS_ENABLED',
  'NATS_TLS_CA',
  'NATS_TLS_CERT',
  'NATS_TLS_KEY',
  'NATS_AUTH_TOKEN',
  'NATS_AUTH_USER',
  'NATS_AUTH_PASS',
];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await delay(10);
  }
}

interface Subscriber {
  nats: PersistentNatsConnection;
  /** Every connection onConnected was handed. */
  connections: NatsConnection[];
  received: string[];
}

/**
 * PLAT-HIGH-939: a long-lived subscriber gets its connection whenever the
 * broker answers, keeps its subscription across any outage, and is replaced
 * when its connection closes. A real @nats-io client against a fake broker,
 * with the options the factory builds.
 */
describe('PersistentNatsConnection (PLAT-HIGH-939)', () => {
  const originalEnv = process.env;
  let broker: FakeNatsServer;
  let subscriber: Subscriber | null = null;

  const subscribe = (): Subscriber => {
    const connections: NatsConnection[] = [];
    const received: string[] = [];
    const nats = new PersistentNatsConnection({
      name: 'persistent-connection-spec',
      onConnected: (connection) => {
        connections.push(connection);
        const sub = connection.subscribe(SUBJECT);
        (async () => {
          for await (const msg of sub) {
            received.push(msg.string());
          }
        })().catch(() => undefined);
      },
    });
    subscriber = { nats, connections, received };
    return subscriber;
  };

  beforeEach(async () => {
    broker = await FakeNatsServer.onFreePort();
    process.env = {
      ...Object.fromEntries(Object.entries(originalEnv).filter(([key]) => !ENV_KEYS.includes(key))),
      NATS_URL: broker.url,
      NATS_RECONNECT_TIME_WAIT_MS: '20',
    };
  });

  afterEach(async () => {
    await subscriber?.nats.close();
    subscriber = null;
    await broker.stop();
    process.env = originalEnv;
  });

  it('connects once the broker answers, though it was away at the first attempt', async () => {
    const { nats, connections, received } = subscribe();
    nats.open();
    await delay(100);
    expect(connections).toHaveLength(0);

    await broker.start();
    await until(() => broker.sidsOn(SUBJECT).length === 1);
    broker.publish(SUBJECT, 'tank 4 updated');
    await until(() => received.length === 1);

    expect(received).toEqual(['tank 4 updated']);
    expect(connections).toHaveLength(1);
    expect(nats.isConnected()).toBe(true);
  });

  it('rides out an outage longer than the reconnect budget with the one subscription it made', async () => {
    process.env['NATS_MAX_RECONNECT_ATTEMPTS'] = '1';
    await broker.start();
    const { nats, connections, received } = subscribe();
    nats.open();
    await until(() => broker.sidsOn(SUBJECT).length === 1);

    await broker.stop();
    // Reconnect attempts every 20 ms (plus jitter) against a budget of 1.
    await delay(400);
    await broker.start();
    await until(() => broker.sidsOn(SUBJECT).length === 1);
    broker.publish(SUBJECT, 'after the outage');
    await until(() => received.length === 1);
    await delay(50);

    // The client restored its own subscription: one delivery, and the
    // connection was never replaced, so onConnected subscribed once.
    expect(received).toEqual(['after the outage']);
    expect(connections).toHaveLength(1);
  });

  it('opens a new connection when the one it had is closed, and subscribes on it', async () => {
    await broker.start();
    const { nats, connections, received } = subscribe();
    nats.open();
    await until(() => connections.length === 1);

    await connections[0]?.close();
    await until(() => connections.length === 2 && broker.sidsOn(SUBJECT).length === 1);
    broker.publish(SUBJECT, 'on the new connection');
    await until(() => received.length === 1);

    expect(received).toEqual(['on the new connection']);
    expect(nats.current).toBe(connections[1]);
  });

  it('stops trying when closed while the broker is away', async () => {
    const { nats, connections } = subscribe();
    nats.open();
    await delay(60);
    await nats.close();

    await broker.start();
    await delay(200);
    expect(broker.accepted).toBe(0);
    expect(connections).toHaveLength(0);
  });

  it('drains a live connection on close', async () => {
    await broker.start();
    const { nats } = subscribe();
    nats.open();
    await until(() => broker.sidsOn(SUBJECT).length === 1);

    await nats.close();

    expect(nats.isConnected()).toBe(false);
    expect(nats.current).toBeNull();
    await until(() => broker.sidsOn(SUBJECT).length === 0);
  });
});
