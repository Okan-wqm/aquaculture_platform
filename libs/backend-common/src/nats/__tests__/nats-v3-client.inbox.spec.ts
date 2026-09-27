import { stub } from '@aquaculture/testing';
import type { Msg, MsgCallback, NatsConnection, Subscription } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import { firstValueFrom } from 'rxjs';

import { NatsV3Client } from '../nats-v3-client.proxy';

jest.mock('@nats-io/transport-node', () => ({ connect: jest.fn() }));
const connectMock = jest.mocked(connect);

/**
 * INFRA-HIGH-187: the reply inbox a request subscribes must be the one the
 * broker grants the connection's identity. `publish()` used to build it from
 * the registration option alone — `createInbox(undefined)` = `_INBOX.<nuid>`
 * — so under the scoped grants (`_INBOX<IDENTITY>.>`, INFRA-HIGH-179) every
 * ClientProxy request on the platform subscribed a subject the broker
 * refused and waited for an answer that could never arrive (aqua-nats
 * 2026-09-20 19:37Z: ten `Subscription Violation … "_INBOX.…"` for
 * gateway_service in one second). The connection is stubbed; the factory is
 * real, so the prefix under test is the one production uses.
 */

const ENV_KEYS = [
  'NATS_URL',
  'NATS_TLS_ENABLED',
  'NATS_TLS_CA',
  'NATS_TLS_CERT',
  'NATS_TLS_KEY',
  'NATS_AUTH_USER',
  'NATS_AUTH_PASS',
  'NATS_AUTH_TOKEN',
  'NODE_ENV',
] as const;

interface CapturedRequest {
  readonly inbox: string;
  readonly subject: string;
  readonly reply: string | undefined;
}

/**
 * A connection whose subscribe/publish record the request/reply pair and
 * answer every request immediately, so `send()` resolves through the real
 * ClientProxy/deserializer path.
 */
function connectionDouble(captured: CapturedRequest[]): NatsConnection {
  let pendingInbox = '';
  let pendingCallback: MsgCallback<Msg> | undefined;
  return stub<NatsConnection>({
    subscribe: (subject: string, opts?: { callback?: MsgCallback<Msg> }): Subscription => {
      pendingInbox = subject;
      pendingCallback = opts?.callback;
      return stub<Subscription>({ unsubscribe: (): void => undefined });
    },
    publish: (subject: string, _data?: unknown, opts?: { reply?: string }): void => {
      captured.push({ inbox: pendingInbox, subject, reply: opts?.reply });
      const response = JSON.stringify({ response: { ok: true }, isDisposed: true });
      void pendingCallback?.(
        null,
        stub<Msg>({
          subject: pendingInbox,
          data: new TextEncoder().encode(response),
          headers: undefined,
        }),
      );
    },
  });
}

describe('NatsV3Client — the reply inbox follows the connection (INFRA-HIGH-187)', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    process.env['NATS_URL'] = 'nats://localhost:4222';
    process.env['NATS_TLS_ENABLED'] = 'false';
    process.env['NODE_ENV'] = 'test';
    for (const key of ['NATS_TLS_CA', 'NATS_TLS_CERT', 'NATS_TLS_KEY', 'NATS_AUTH_TOKEN']) {
      Reflect.deleteProperty(process.env, key);
    }
    process.env['NATS_AUTH_USER'] = 'dev';
    process.env['NATS_AUTH_PASS'] = 'dev';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  async function requestThrough(client: NatsV3Client): Promise<CapturedRequest> {
    const captured: CapturedRequest[] = [];
    // The transport is the double; connect() itself is real, so the prefix
    // under test is the one the factory put on the connection options.
    connectMock.mockResolvedValueOnce(connectionDouble(captured));
    await client.connect();
    await firstValueFrom(client.send('request.messaging.verifyMembership', { channelId: 'c' }));
    const [request] = captured;
    if (request === undefined || captured.length !== 1) {
      throw new Error(`expected exactly one request, saw ${captured.length}`);
    }
    return request;
  }

  it('subscribes the reply under the identity-scoped prefix the factory chose for the connection', async () => {
    const client = new NatsV3Client({ serviceName: 'gateway-api-websocket' });
    const request = await requestThrough(client);

    expect(request.subject).toBe('request.messaging.verifyMembership');
    expect(request.inbox).toMatch(/^_INBOXGATEWAY_API_WEBSOCKET\.[A-Za-z0-9]+$/);
    expect(request.reply).toBe(request.inbox);
  });

  it('honours an explicit registration prefix for a separately granted reply channel', async () => {
    const client = new NatsV3Client({
      serviceName: 'billing-service',
      inboxPrefix: '_INBOXBILLINGCFG',
    });
    const request = await requestThrough(client);

    expect(request.inbox).toMatch(/^_INBOXBILLINGCFG\.[A-Za-z0-9]+$/);
  });

  it('never falls back to the ungranted default `_INBOX.` root', async () => {
    const client = new NatsV3Client({ serviceName: 'admin-api-service' });
    const request = await requestThrough(client);

    expect(request.inbox.startsWith('_INBOX.')).toBe(false);
  });
});
