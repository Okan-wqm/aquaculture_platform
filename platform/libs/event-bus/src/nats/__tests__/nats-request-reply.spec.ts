import 'reflect-metadata';
// NATS v3 (@nats-io/* 3.x). The v2 monolithic `nats` package split into
// nats-core (connection + Msg primitives + typed error classes).
// StringCodec was REMOVED — build the reply body by exposing `.string()`
// on the fake Msg (the unit under test reads `reply.string()`), and the
// request payload is now a plain string (the lib UTF-8-encodes it,
// byte-identical wire to the v2 producer). ErrorCode/NatsError were
// REMOVED in favour of discrete error classes — a request timeout is
// `TimeoutError`, a no-responders failure is `NoRespondersError`.
import { NoRespondersError, TimeoutError } from '@nats-io/nats-core';
import type { Msg, NatsConnection } from '@nats-io/nats-core';
import { NatsEventBus } from '../nats-event-bus';
import {
  NatsRequestReply,
  RequestReplyDecodeError,
  RequestReplyEncodeError,
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
  return { ...base, ...overrides } as unknown as NatsConnection;
}

/**
 * Build a minimal `NatsEventBus`-shaped object exposing only
 * `getRawConnection`. Using a fake instead of a real NatsEventBus
 * keeps the tests fast + isolated from the JetStream boot path.
 */
function fakeEventBus(connection: NatsConnection | null): NatsEventBus {
  return {
    getRawConnection: () => connection,
  } as unknown as NatsEventBus;
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

describe('NatsRequestReply — requestTyped', () => {
  it('round-trips happy-path JSON', async () => {
    interface Req { a: number }
    interface Res { b: string }

    const responseJson = JSON.stringify({ b: 'ok' });
    const connection = stubConnection({
      request: jest.fn().mockResolvedValue(replyMsg(responseJson)) as unknown as NatsConnection['request'],
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
    const [[, payload]] = (connection.request as jest.Mock).mock.calls;
    expect(payload).toBe('{"a":42}');
  });

  it('raises RequestReplyTimeoutError on NATS timeout', async () => {
    // v3: a request timeout rejects with the discrete TimeoutError class
    // (replacing v2's `new NatsError(msg, ErrorCode.Timeout)` sentinel).
    const timeoutErr = new TimeoutError();
    const connection = stubConnection({
      request: jest.fn().mockRejectedValue(timeoutErr) as unknown as NatsConnection['request'],
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
      request: jest.fn().mockRejectedValue(transportErr) as unknown as NatsConnection['request'],
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
      request: jest.fn() as unknown as NatsConnection['request'],
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    // BigInt is not JSON-encodable — JSON.stringify throws
    // TypeError. The client wraps as RequestReplyEncodeError so
    // callers see the canonical shelf.
    await expect(
      rr.requestTyped<{ n: bigint }, object>(
        'ns.subj',
        { n: 1n },
        { timeoutMs: 50 },
      ),
    ).rejects.toBeInstanceOf(RequestReplyEncodeError);

    // AND the request was never actually sent.
    expect(connection.request).not.toHaveBeenCalled();
  });

  it('raises RequestReplyDecodeError when the reply is not valid JSON', async () => {
    const connection = stubConnection({
      request: jest.fn().mockResolvedValue(replyMsg('not json')) as unknown as NatsConnection['request'],
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
      request: jest.fn().mockResolvedValue(replyMsg(envelope)) as unknown as NatsConnection['request'],
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
