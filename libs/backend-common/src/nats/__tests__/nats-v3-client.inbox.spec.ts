/**
 * SEC-HIGH-098 completion — the proxy must actually SUBSCRIBE the scoped
 * reply inbox the broker grants. Live failure this pins: messaging registered
 * its NatsV3Client with only `serviceName: 'messaging-service'`; the factory
 * scoped the CONNECTION options, but publish() read `this.options.inboxPrefix`
 * (undefined) → nats-core default `_INBOX.<nuid>` → the scoped-only broker
 * grant denied the subscription → every request-reply (request.ai.isEnabled
 * et al.) died as a silent Permissions Violation and callers defaulted to
 * "disabled".
 */
import 'reflect-metadata';

import { NatsV3Client } from '../nats-v3-client.proxy';

interface Captured {
  inbox: string;
  pattern: string;
}

function buildClient(serviceName?: string, inboxPrefix?: string): {
  client: NatsV3Client;
  captured: Captured[];
} {
  const client = new NatsV3Client(
    (serviceName || inboxPrefix
      ? { ...(serviceName ? { serviceName } : {}), ...(inboxPrefix ? { inboxPrefix } : {}) }
      : {}) as ConstructorParameters<typeof NatsV3Client>[0],
  );
  const captured: Captured[] = [];
  const fakeConnection = {
    subscribe: (inbox: string) => {
      captured.push({ inbox, pattern: 'sub' });
      return { unsubscribe: () => undefined };
    },
    publish: (pattern: string, _data: Uint8Array, opts: { reply: string }) => {
      captured.push({ inbox: opts.reply, pattern });
      return undefined;
    },
  };
  // The proxy guards publish() behind assertConnection(); inject the fake.
  (client as unknown as { natsConnection: unknown }).natsConnection = fakeConnection;
  // connect() would open a socket — pre-set the resolved fields publish() uses.
  (client as unknown as { effectiveInboxPrefix?: string }).effectiveInboxPrefix =
    inboxPrefix ? inboxPrefix.replace(/\.+$/, '') : serviceName ? `_INBOX${serviceName.toUpperCase().replace(/-/g, '_')}` : undefined;
  return { client, captured };
}


function fire(client: NatsV3Client, pattern: string): void {
  // publish() subscribes + publishes synchronously; the callback only fires
  // on a REPLY, which this broker-less harness never delivers.
  (client as unknown as { publish: (p: unknown, cb: (w: unknown) => void) => () => void }).publish(
    { pattern, data: {} },
    () => undefined,
  );
}

describe('NatsV3Client reply-inbox scoping (SEC-HIGH-098 completion)', () => {
  it('serviceName-only registration subscribes the SCOPED inbox, not the default _INBOX.', async () => {
    const { client, captured } = buildClient('messaging-service');
    fire(client, 'request.ai.isEnabled');
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect(c.inbox.startsWith('_INBOXMESSAGING_SERVICE.')).toBe(true);
      expect(c.inbox.startsWith('_INBOX.')).toBe(false);
    }
  });

  it('an explicit inboxPrefix still wins over the factory default', async () => {
    const { client, captured } = buildClient('messaging-service', '_INBOXCUSTOM.');
    fire(client, 'x.y');
    for (const c of captured) {
      expect(c.inbox.startsWith('_INBOXCUSTOM.')).toBe(true);
    }
  });

  it('a trailing-dot prefix is normalized (createInbox adds its own separator)', async () => {
    const { client, captured } = buildClient(undefined, '_INBOXDOTTED..');
    fire(client, 'x.y');
    for (const c of captured) {
      expect(c.inbox).not.toContain('..');
    }
  });
});
