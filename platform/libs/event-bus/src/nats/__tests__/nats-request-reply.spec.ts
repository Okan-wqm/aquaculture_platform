import 'reflect-metadata';
// NATS v3 (@nats-io/* 3.x). The v2 monolithic `nats` package split into
// nats-core (connection + Msg primitives + typed error classes).
// StringCodec was REMOVED — build the reply body by exposing `.string()`
// on the fake Msg (the unit under test reads `reply.string()`), and the
// request payload is now a plain string (the lib UTF-8-encodes it,
// byte-identical wire to the v2 producer). ErrorCode/NatsError were
// REMOVED in favour of discrete error classes — a request timeout is
// `TimeoutError`, a no-responders failure is `NoRespondersError`.
import { headers, NoRespondersError, TimeoutError } from '@nats-io/nats-core';
import type { Msg, MsgCallback, NatsConnection, Subscription } from '@nats-io/nats-core';

import { NatsEventBus } from '../nats-event-bus';
import {
  NatsRequestReply,
  RequestReplyHandlerError,
  RequestReplyDecodeError,
  RequestReplyEncodeError,
  RequestReplyPolicyError,
  RequestReplyRemoteError,
  RequestReplyTimeoutError,
  RequestReplyTransportError,
} from '../nats-request-reply';

/**
 * Unit tests for {@link NatsRequestReply}. The live NATS round
 * trip is covered by the testcontainers-rs integration suite in
 * PR-C #9; these tests pin the typed generic surface + every
 * error-classification branch without spinning up a broker.
 *
 * Strategy: build a minimal fake `NatsConnection` that lets us
 * drive the request() outcome (success / timeout / no-responders
 * / arbitrary throw) and inspect what the client encodes / decodes.
 */

/**
 * Build a minimal `NatsConnection` stub whose `request` returns
 * whatever the test supplies. Only the methods the
 * {@link NatsRequestReply} exercises are implemented — the broader
 * `NatsConnection` surface is intentionally absent to keep the
 * stub tight.
 */
function stubConnection(
  overrides: Partial<Pick<NatsConnection, 'request' | 'subscribe'>> = {},
): NatsConnection {
  const base = {
    request: jest.fn(),
    subscribe: jest.fn(),
  };
  return Object.assign(Object.create(null) as NatsConnection, base, overrides);
}

function resolvedRequestMock(message: Msg): NatsConnection['request'] {
  const request: NatsConnection['request'] = jest.fn(() => Promise.resolve(message));
  return request;
}

function rejectedRequestMock(error: Error): NatsConnection['request'] {
  const request: NatsConnection['request'] = jest.fn(() => Promise.reject(error));
  return request;
}

function unusedRequestMock(): NatsConnection['request'] {
  const request: NatsConnection['request'] = jest.fn(() => Promise.resolve(replyMsg('{}')));
  return request;
}

/**
 * Build a minimal `NatsEventBus`-shaped object exposing only
 * `getRawConnection`. Using a fake instead of a real NatsEventBus
 * keeps the tests fast + isolated from the JetStream boot path.
 */
function fakeEventBus(connection: NatsConnection | null): NatsEventBus {
  return Object.assign(Object.create(NatsEventBus.prototype) as NatsEventBus, {
    getRawConnection: () => connection,
  });
}

/**
 * Build a `Msg` the unit under test sees as a request-reply reply.
 * `reply` inbox is intentionally present (request() replies always
 * are) but the value is not consulted by the client path.
 *
 * v3: the client decodes via `reply.string()`/`reply.json()` (StringCodec
 * was removed), so the fake exposes those convenience methods. `data`
 * stays the UTF-8 bytes for internal consistency, but the client path no
 * longer reads it directly.
 */
function replyMsg(bodyJson: string): Msg {
  return {
    data: new TextEncoder().encode(bodyJson),
    string: () => bodyJson,
    json: <T>() => JSON.parse(bodyJson) as T,
    subject: 'unused',
    reply: '_INBOX.unused',
    respond: jest.fn(),
    headers: undefined,
    sid: 0,
  };
}

function incomingMsg(bodyJson: string, reply: string, authenticatedIdentityHeader?: string): Msg {
  const messageHeaders = headers();
  if (authenticatedIdentityHeader !== undefined) {
    messageHeaders.set('authenticated-identity', authenticatedIdentityHeader);
  }

  return {
    data: new TextEncoder().encode(bodyJson),
    string: jest.fn(() => bodyJson),
    json: <T>() => JSON.parse(bodyJson) as T,
    subject: 'request.farm.marineExecutionLease',
    reply,
    respond: jest.fn(() => true),
    headers: messageHeaders,
    sid: 1,
  };
}

function firstResponseBody(message: Msg): string {
  const body = jest.mocked(message.respond).mock.calls[0]?.[0];
  if (typeof body !== 'string') {
    throw new Error('expected responder to write one string payload');
  }
  return body;
}

class FiniteSubscription implements Subscription {
  readonly closed = Promise.resolve();
  readonly callback: MsgCallback<Msg> = () => undefined;
  private unsubscribed = false;

  constructor(
    private readonly messages: readonly Msg[],
    private readonly resolveConsumed: () => void,
  ) {}

  unsubscribe(): void {
    this.unsubscribed = true;
  }

  drain(): Promise<void> {
    return Promise.resolve();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return Promise.resolve();
  }

  isDraining(): boolean {
    return false;
  }

  isClosed(): boolean {
    return this.unsubscribed;
  }

  getSubject(): string {
    return 'request.farm.marineExecutionLease';
  }

  getReceived(): number {
    return this.messages.length;
  }

  getProcessed(): number {
    return this.messages.length;
  }

  getPending(): number {
    return 0;
  }

  getID(): number {
    return 1;
  }

  getMax(): number | undefined {
    return undefined;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Msg> {
    await Promise.resolve();
    for (const message of this.messages) {
      yield message;
    }
    this.resolveConsumed();
  }
}

function finiteSubscription(messages: readonly Msg[]): {
  subscription: Subscription;
  consumed: Promise<void>;
} {
  let resolveConsumed = (): void => undefined;
  const consumed = new Promise<void>((resolve) => {
    resolveConsumed = resolve;
  });

  const subscription = new FiniteSubscription(messages, resolveConsumed);

  return { subscription, consumed };
}

function subscribeMock(subscription: Subscription): NatsConnection['subscribe'] {
  const subscribe: NatsConnection['subscribe'] = jest.fn(() => subscription);
  return subscribe;
}

const MARINE_RESPONDER_OPTIONS = {
  replyInboxPolicy: {
    mode: 'exact-prefix',
    prefix: '_INBOXMARINEANALYSIS',
  },
  errorPolicy: {
    mode: 'sanitized',
    allowedCodes: ['HANDLER_ERROR', 'LEASE_FENCED'],
    fallbackCode: 'HANDLER_ERROR',
  },
} as const;

describe('NatsRequestReply — requestTyped', () => {
  it('round-trips happy-path JSON', async () => {
    interface Req {
      a: number;
    }
    interface Res {
      b: string;
    }

    const responseJson = JSON.stringify({ b: 'ok' });
    const connection = stubConnection({
      request: resolvedRequestMock(replyMsg(responseJson)),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    const result = await rr.requestTyped<Req, Res>(
      'policy.ingest_backend.snapshot',
      { a: 42 },
      { timeoutMs: 500 },
    );

    expect(result).toEqual({ b: 'ok' });
    // v3: request() is given the JSON string directly (StringCodec.encode
    // removed); the lib UTF-8-encodes it, byte-identical wire to v2.
    expect(connection.request).toHaveBeenCalledWith(
      'policy.ingest_backend.snapshot',
      expect.any(String),
      { timeout: 500 },
    );
    // The string payload must be the JSON we supplied, byte-for-byte.
    const payload = jest.mocked(connection.request).mock.calls[0]?.[1];
    expect(payload).toBe('{"a":42}');
  });

  it('raises RequestReplyTimeoutError on NATS timeout', async () => {
    // v3: a request timeout rejects with the discrete TimeoutError class
    // (replacing v2's `new NatsError(msg, ErrorCode.Timeout)` sentinel).
    const timeoutErr = new TimeoutError();
    const connection = stubConnection({
      request: rejectedRequestMock(timeoutErr),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    const attempt = rr.requestTyped<object, object>(
      'policy.ingest_backend.snapshot',
      {},
      { timeoutMs: 25 },
    );
    await expect(attempt).rejects.toBeInstanceOf(RequestReplyTimeoutError);
    await expect(attempt).rejects.toMatchObject({
      subject: 'policy.ingest_backend.snapshot',
      timeoutMs: 25,
    });
  });

  it('raises RequestReplyTransportError on NoResponders + other transport errors', async () => {
    // v3: a missing responder rejects with the discrete NoRespondersError
    // class (replacing v2's `new NatsError(msg, ErrorCode.NoResponders)`).
    // It is not a TimeoutError, so the client maps it to the transport shelf.
    const transportErr = new NoRespondersError('ns.subj');
    const connection = stubConnection({
      request: rejectedRequestMock(transportErr),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    await expect(
      rr.requestTyped<object, object>('ns.subj', {}, { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(RequestReplyTransportError);
  });

  it('raises RequestReplyTransportError when the connection is null', async () => {
    const rr = new NatsRequestReply(fakeEventBus(null));

    await expect(
      rr.requestTyped<object, object>('ns.subj', {}, { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(RequestReplyTransportError);
  });

  it('raises RequestReplyEncodeError on non-encodable request bodies', async () => {
    const connection = stubConnection({
      request: unusedRequestMock(),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    // BigInt is not JSON-encodable — JSON.stringify throws
    // TypeError. The client wraps as RequestReplyEncodeError so
    // callers see the canonical shelf.
    await expect(
      rr.requestTyped<{ n: bigint }, object>('ns.subj', { n: 1n }, { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(RequestReplyEncodeError);

    // AND the request was never actually sent.
    expect(connection.request).not.toHaveBeenCalled();
  });

  it('raises RequestReplyDecodeError when the reply is not valid JSON', async () => {
    const connection = stubConnection({
      request: resolvedRequestMock(replyMsg('not json')),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    await expect(
      rr.requestTyped<object, object>('ns.subj', {}, { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(RequestReplyDecodeError);
  });

  it('raises RequestReplyRemoteError when the responder returns an error envelope', async () => {
    // The wire shape {"__error":true,"code":"X","message":"Y"} is
    // the responder's way of surfacing an application-level error
    // over the same subject. The client converts it into the typed
    // `RequestReplyRemoteError` so callers can branch on `.code`.
    const envelope = JSON.stringify({
      __error: true,
      code: 'SNAPSHOT_UNAVAILABLE',
      message: 'no snapshot',
    });
    const connection = stubConnection({
      request: resolvedRequestMock(replyMsg(envelope)),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    const attempt = rr.requestTyped<object, object>(
      'policy.ingest_backend.snapshot',
      {},
      { timeoutMs: 50 },
    );
    await expect(attempt).rejects.toBeInstanceOf(RequestReplyRemoteError);
    await expect(attempt).rejects.toMatchObject({
      code: 'SNAPSHOT_UNAVAILABLE',
      message: 'no snapshot',
    });
  });

  it('validates and discards a bounded remote message in sanitized mode', async () => {
    const secret = 'provider-token-super-secret';
    const envelope = JSON.stringify({
      __error: true,
      code: 'LEASE_FENCED',
      message: secret,
    });
    const connection = stubConnection({
      request: resolvedRequestMock(replyMsg(envelope)),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    const attempt = rr.requestTyped<object, object>(
      'request.farm.marineExecutionRenew',
      {},
      {
        timeoutMs: 50,
        remoteErrorPolicy: {
          mode: 'sanitized',
          allowedCodes: ['LEASE_FENCED'],
        },
      },
    );

    const error = await attempt.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestReplyRemoteError);
    expect(error).toMatchObject({ code: 'LEASE_FENCED', sanitized: true });
    expect(String(error)).not.toContain(secret);
    expect((error as Error).stack).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('accepts the exact Rust-compatible code and UTF-8 message bounds', async () => {
    const code = `A${'B'.repeat(63)}`;
    const message = 'x'.repeat(2_048);
    const connection = stubConnection({
      request: resolvedRequestMock(replyMsg(JSON.stringify({ __error: true, code, message }))),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    const error = await rr
      .requestTyped<object, object>(
        'request.farm.marineExecutionRenew',
        {},
        {
          timeoutMs: 50,
          remoteErrorPolicy: {
            mode: 'sanitized',
            allowedCodes: [code],
          },
        },
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code, sanitized: true });
    expect(String(error)).not.toContain(message);
  });

  it.each([
    {
      name: 'lowercase code',
      envelope: { __error: true, code: 'lease_denied', message: 'Request failed' },
    },
    {
      name: 'overlong code',
      envelope: { __error: true, code: `A${'B'.repeat(64)}`, message: 'Request failed' },
    },
    {
      name: 'code outside the caller allowlist',
      envelope: { __error: true, code: 'NOT_ALLOWED', message: 'Request failed' },
    },
    {
      name: 'overlong message',
      envelope: { __error: true, code: 'LEASE_FENCED', message: 'x'.repeat(2_049) },
    },
    {
      name: 'UTF-8 byte-overlong message',
      envelope: { __error: true, code: 'LEASE_FENCED', message: 'é'.repeat(1_025) },
    },
    {
      name: 'empty message',
      envelope: { __error: true, code: 'LEASE_FENCED', message: '' },
    },
    {
      name: 'open envelope',
      envelope: {
        __error: true,
        code: 'LEASE_FENCED',
        message: 'Request failed',
        detail: 'must not cross the boundary',
      },
    },
  ])('rejects a $name error envelope as sanitized contract drift', async ({ envelope }) => {
    const connection = stubConnection({
      request: resolvedRequestMock(replyMsg(JSON.stringify(envelope))),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    await expect(
      rr.requestTyped<object, object>(
        'request.farm.marineExecutionRenew',
        {},
        {
          timeoutMs: 50,
          remoteErrorPolicy: {
            mode: 'sanitized',
            allowedCodes: ['LEASE_FENCED'],
          },
        },
      ),
    ).rejects.toBeInstanceOf(RequestReplyDecodeError);
  });

  it('does not retain invalid JSON bytes in a sanitized decode error', async () => {
    const secret = 'provider-token-in-invalid-json';
    const connection = stubConnection({
      request: resolvedRequestMock(replyMsg(`{"token":"${secret}"`)),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    const error = await rr
      .requestTyped<object, object>(
        'request.farm.marineExecutionRenew',
        {},
        {
          timeoutMs: 50,
          remoteErrorPolicy: {
            mode: 'sanitized',
            allowedCodes: ['LEASE_FENCED'],
          },
        },
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RequestReplyDecodeError);
    expect(String(error)).not.toContain(secret);
    expect((error as Error).stack).not.toContain(secret);
  });
});

describe('NatsRequestReply — hardened responder', () => {
  it('accepts exactly one concrete suffix under the configured inbox prefix', async () => {
    const message = incomingMsg(
      '{"jobId":"018f65f2-c964-77c9-89a1-4d17ee6f9674"}',
      '_INBOXMARINEANALYSIS.7JxUVhVtVq5jQv0HWpUx3B',
      'attacker-controlled-header',
    );
    const { subscription, consumed } = finiteSubscription([message]);
    const connection = stubConnection({
      subscribe: subscribeMock(subscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));
    const handler = jest.fn(() => Promise.resolve({ decision: 'CONTINUE' }));

    await rr.respond('request.farm.marineExecutionLease', handler, MARINE_RESPONDER_OPTIONS);
    await consumed;

    expect(handler).toHaveBeenCalledWith(
      { jobId: '018f65f2-c964-77c9-89a1-4d17ee6f9674' },
      {
        subject: 'request.farm.marineExecutionLease',
        replySubject: '_INBOXMARINEANALYSIS.7JxUVhVtVq5jQv0HWpUx3B',
        // The library surfaces the self-asserted header verbatim. This proves
        // it is transport metadata, not a broker-derived certificate identity.
        untrustedAuthenticatedIdentityHeader: 'attacker-controlled-header',
      },
    );
    expect(message.respond).toHaveBeenCalledWith('{"decision":"CONTINUE"}');
  });

  it.each([
    ['default inbox', '_INBOX.defaultToken'],
    ['wrong scoped inbox', '_INBOXOTHER.oneToken'],
    ['wildcard suffix', '_INBOXMARINEANALYSIS.*'],
    ['tail wildcard suffix', '_INBOXMARINEANALYSIS.>'],
    ['multi-token suffix', '_INBOXMARINEANALYSIS.one.two'],
    ['missing suffix', '_INBOXMARINEANALYSIS'],
  ])('rejects a %s before decode or handler execution', async (_name, reply) => {
    const message = incomingMsg('{not-json', reply);
    const { subscription, consumed } = finiteSubscription([message]);
    const connection = stubConnection({
      subscribe: subscribeMock(subscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));
    const handler = jest.fn(() => Promise.resolve({ accepted: true }));

    await rr.respond('request.farm.marineExecutionLease', handler, MARINE_RESPONDER_OPTIONS);
    await consumed;

    expect(message.string).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(message.respond).not.toHaveBeenCalled();
  });

  it('emits only an allowlisted fallback code and generic message for thrown secrets', async () => {
    const secret = 'signed-url-and-provider-token';
    const message = incomingMsg('{}', '_INBOXMARINEANALYSIS.oneToken');
    const { subscription, consumed } = finiteSubscription([message]);
    const connection = stubConnection({
      subscribe: subscribeMock(subscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    await rr.respond(
      'request.farm.marineExecutionLease',
      () => Promise.reject(new Error(secret)),
      MARINE_RESPONDER_OPTIONS,
    );
    await consumed;

    const wireBody = firstResponseBody(message);
    expect(JSON.parse(wireBody)).toEqual({
      __error: true,
      code: 'HANDLER_ERROR',
      message: 'Request failed',
    });
    expect(wireBody).not.toContain(secret);
  });

  it('does not expose JSON parser text from a malformed request', async () => {
    const secret = 'credential-inside-malformed-json';
    const message = incomingMsg(`{"credential":"${secret}"`, '_INBOXMARINEANALYSIS.oneToken');
    const { subscription, consumed } = finiteSubscription([message]);
    const connection = stubConnection({
      subscribe: subscribeMock(subscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));
    const handler = jest.fn(() => Promise.resolve({ accepted: true }));

    await rr.respond('request.farm.marineCredentialLease', handler, MARINE_RESPONDER_OPTIONS);
    await consumed;

    const wireBody = firstResponseBody(message);
    expect(JSON.parse(wireBody)).toEqual({
      __error: true,
      code: 'HANDLER_ERROR',
      message: 'Request failed',
    });
    expect(wireBody).not.toContain(secret);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not expose response encoder exceptions', async () => {
    const secret = 'signed-url-inside-to-json-error';
    const message = incomingMsg('{}', '_INBOXMARINEANALYSIS.oneToken');
    const { subscription, consumed } = finiteSubscription([message]);
    const connection = stubConnection({
      subscribe: subscribeMock(subscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));
    const response = {
      toJSON(): never {
        throw new Error(secret);
      },
    };

    await rr.respond(
      'request.farm.marineArtifactLease',
      () => Promise.resolve(response),
      MARINE_RESPONDER_OPTIONS,
    );
    await consumed;

    const wireBody = firstResponseBody(message);
    expect(JSON.parse(wireBody)).toEqual({
      __error: true,
      code: 'HANDLER_ERROR',
      message: 'Request failed',
    });
    expect(wireBody).not.toContain(secret);
  });

  it('does not derive a sanitized code from a thrown Error name', async () => {
    const message = incomingMsg('{}', '_INBOXMARINEANALYSIS.oneToken');
    const { subscription, consumed } = finiteSubscription([message]);
    const connection = stubConnection({
      subscribe: subscribeMock(subscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));
    const forged = new Error('secret-provider-body');
    forged.name = 'LEASE_FENCED';

    await rr.respond(
      'request.farm.marineExecutionRenew',
      () => Promise.reject(forged),
      MARINE_RESPONDER_OPTIONS,
    );
    await consumed;

    const wireBody = firstResponseBody(message);
    expect(JSON.parse(wireBody)).toEqual({
      __error: true,
      code: 'HANDLER_ERROR',
      message: 'Request failed',
    });
    expect(wireBody).not.toContain(forged.message);
  });

  it('emits an explicitly allowlisted handler code without its thrown message', async () => {
    const message = incomingMsg('{}', '_INBOXMARINEANALYSIS.oneToken');
    const { subscription, consumed } = finiteSubscription([message]);
    const connection = stubConnection({
      subscribe: subscribeMock(subscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    await rr.respond(
      'request.farm.marineExecutionRenew',
      () => Promise.reject(new RequestReplyHandlerError('LEASE_FENCED')),
      MARINE_RESPONDER_OPTIONS,
    );
    await consumed;

    const wireBody = firstResponseBody(message);
    expect(JSON.parse(wireBody)).toEqual({
      __error: true,
      code: 'LEASE_FENCED',
      message: 'Request failed',
    });
  });

  it('accepts the longest scoped inbox prefix deployable as a 120-character ACL subject', async () => {
    const prefix = `_INBOX${'A'.repeat(112)}`;
    const { subscription, consumed } = finiteSubscription([]);
    const connection = stubConnection({
      subscribe: subscribeMock(subscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    await rr.respond('request.farm.marineExecutionLease', () => Promise.resolve({}), {
      ...MARINE_RESPONDER_OPTIONS,
      replyInboxPolicy: { mode: 'exact-prefix', prefix },
    });
    await consumed;

    expect(prefix).toHaveLength(118);
    expect(connection.subscribe).toHaveBeenCalledWith('request.farm.marineExecutionLease');
  });

  it.each([
    ['default prefix', '_INBOX'],
    ['wildcard prefix', '_INBOX*'],
    ['multi-token prefix', '_INBOX.MARINE'],
    ['lowercase scoped prefix', '_INBOXmarine'],
    ['hyphenated scoped prefix', '_INBOX-MARINE'],
    ['119-character scoped prefix', `_INBOX${'A'.repeat(113)}`],
    ['lowercase code', 'lease_fenced'],
    ['overlong code', `A${'B'.repeat(64)}`],
  ])('fails registration for an invalid %s policy value', async (kind, value) => {
    const connection = stubConnection();
    const rr = new NatsRequestReply(fakeEventBus(connection));
    const options = kind.includes('prefix')
      ? {
          ...MARINE_RESPONDER_OPTIONS,
          replyInboxPolicy: { mode: 'exact-prefix' as const, prefix: value },
        }
      : {
          ...MARINE_RESPONDER_OPTIONS,
          errorPolicy: {
            mode: 'sanitized' as const,
            allowedCodes: [value] as [string],
            fallbackCode: value,
          },
        };

    await expect(
      rr.respond('request.farm.marineExecutionLease', () => Promise.resolve({}), options),
    ).rejects.toBeInstanceOf(RequestReplyPolicyError);
    expect(connection.subscribe).not.toHaveBeenCalled();
  });
});

describe('NatsRequestReply — error hierarchy', () => {
  it('every variant is distinguishable by instanceof', () => {
    // Alert rules pattern-match by variant; merging any two shelves
    // would silently lose routing. Pin the variant identity.
    const t = new RequestReplyTimeoutError('x', 10);
    const x = new RequestReplyTransportError('x', new Error('x'));
    const e = new RequestReplyEncodeError('x', new Error('x'));
    const d = new RequestReplyDecodeError('x', new Error('x'));
    const r = new RequestReplyRemoteError('x', 'C', 'm');
    expect(t).not.toBeInstanceOf(RequestReplyTransportError);
    expect(t).not.toBeInstanceOf(RequestReplyEncodeError);
    expect(t).not.toBeInstanceOf(RequestReplyDecodeError);
    expect(t).not.toBeInstanceOf(RequestReplyRemoteError);
    expect(x).not.toBeInstanceOf(RequestReplyTimeoutError);
    expect(e).not.toBeInstanceOf(RequestReplyDecodeError);
    expect(d).not.toBeInstanceOf(RequestReplyEncodeError);
    expect(r).not.toBeInstanceOf(RequestReplyTransportError);
  });

  it('timeout surfaces subject + budget on the instance', () => {
    const err = new RequestReplyTimeoutError('foo.bar', 250);
    expect(err.subject).toBe('foo.bar');
    expect(err.timeoutMs).toBe(250);
    expect(err.name).toBe('RequestReplyTimeoutError');
  });

  it('remote error surfaces code + message on the instance', () => {
    const err = new RequestReplyRemoteError('foo.bar', 'DENIED', 'not authorised');
    expect(err.code).toBe('DENIED');
    expect(err.message).toBe('not authorised');
    expect(err.name).toBe('RequestReplyRemoteError');
  });
});
