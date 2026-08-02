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
import type { Msg, NatsConnection, Subscription } from '@nats-io/nats-core';

import { CoreNatsConnectionSnapshot, NatsEventBus } from '../nats-event-bus';
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
  return { ...base, ...overrides } as NatsConnection;
}

/**
 * Build a minimal `NatsEventBus`-shaped object exposing only
 * `getRawConnection`. Using a fake instead of a real NatsEventBus
 * keeps the tests fast + isolated from the JetStream boot path.
 */
function fakeEventBus(connection: NatsConnection | null): NatsEventBus {
  const snapshot = {
    connection,
    generation: connection === null ? 0 : 1,
    state: connection === null ? ('disconnected' as const) : ('connected' as const),
  };
  return Object.assign({} as NatsEventBus, {
    getRawConnection: () => connection,
    getCoreConnectionSnapshot: () => snapshot,
    onCoreConnectionLifecycle: (listener: (value: typeof snapshot) => void) => {
      listener(snapshot);
      return () => undefined;
    },
    setCoreResponderAvailability: jest.fn(),
    disconnect: jest.fn().mockResolvedValue(undefined),
  });
}

function controlledEventBus(initialConnection: NatsConnection): {
  eventBus: NatsEventBus;
  emit(snapshot: CoreNatsConnectionSnapshot): void;
} {
  let snapshot: CoreNatsConnectionSnapshot = {
    connection: initialConnection,
    generation: 1,
    state: 'connected',
  };
  const listeners = new Set<(value: CoreNatsConnectionSnapshot) => void>();
  const eventBus = Object.assign({} as NatsEventBus, {
    getRawConnection: () => snapshot.connection,
    getCoreConnectionSnapshot: () => snapshot,
    onCoreConnectionLifecycle: (listener: (value: CoreNatsConnectionSnapshot) => void) => {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    setCoreResponderAvailability: jest.fn(),
    disconnect: jest.fn().mockResolvedValue(undefined),
  });
  return {
    eventBus,
    emit: (nextSnapshot) => {
      snapshot = nextSnapshot;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function stubSubscription(overrides: Partial<Subscription>): Subscription {
  return {
    closed: new Promise<void>(() => undefined),
    unsubscribe: jest.fn(),
    drain: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as Subscription;
}

function pendingMessageIterator(): AsyncIterator<Msg> {
  return {
    next: () => new Promise<IteratorResult<Msg>>(() => undefined),
  };
}

function completedMessageIterator(): AsyncIterator<Msg> {
  return {
    next: () => Promise.resolve({ done: true, value: undefined }),
  };
}

function failingMessageIterator(error: Error): AsyncIterator<Msg> {
  return {
    next: () => Promise.reject(error),
  };
}

function messageThenPendingIterator(messages: readonly Msg[]): AsyncIterator<Msg> {
  let index = 0;
  return {
    next: () => {
      const message = messages[index];
      if (message === undefined) {
        return new Promise<IteratorResult<Msg>>(() => undefined);
      }
      index += 1;
      return Promise.resolve({ done: false, value: message });
    },
  };
}

function resolveEmptyResponse(): Promise<object> {
  return Promise.resolve({});
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
    interface Req {
      a: number;
    }
    interface Res {
      b: string;
    }

    const responseJson = JSON.stringify({ b: 'ok' });
    const connection = stubConnection({
      request: jest.fn().mockResolvedValue(replyMsg(responseJson)) as NatsConnection['request'],
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
      request: jest.fn().mockRejectedValue(timeoutErr) as NatsConnection['request'],
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
      request: jest.fn().mockRejectedValue(transportErr) as NatsConnection['request'],
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
      request: jest.fn() as NatsConnection['request'],
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
      request: jest.fn().mockResolvedValue(replyMsg('not json')) as NatsConnection['request'],
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
      request: jest.fn().mockResolvedValue(replyMsg(envelope)) as NatsConnection['request'],
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

describe('NatsRequestReply — responder', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('clears failed initial registration health and permits the same key to retry', async () => {
    const activeSubscription = stubSubscription({
      [Symbol.asyncIterator]: pendingMessageIterator,
    });
    const connection = stubConnection({
      subscribe: jest
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('initial subscribe failed');
        })
        .mockReturnValue(activeSubscription),
    });
    const eventBus = fakeEventBus(connection);
    const rr = new NatsRequestReply(eventBus);

    await expect(
      rr.respond<object, object>('request.farm.validateSiteAssignment', resolveEmptyResponse, {
        queue: 'farm-service',
      }),
    ).rejects.toBeInstanceOf(RequestReplyTransportError);
    expect(eventBus.setCoreResponderAvailability).toHaveBeenLastCalledWith(
      expect.any(String),
      true,
    );

    const retried = await rr.respond<object, object>(
      'request.farm.validateSiteAssignment',
      resolveEmptyResponse,
      { queue: 'farm-service' },
    );
    expect(connection.subscribe).toHaveBeenCalledTimes(2);
    await retried.drain();
  });

  it('re-subscribes exactly once when the responder iterator terminates with an error', async () => {
    jest.useFakeTimers();
    const failedSubscription = stubSubscription({
      [Symbol.asyncIterator]: () =>
        failingMessageIterator(new Error('subscription transport failed')),
    });
    const activeSubscription = stubSubscription({
      [Symbol.asyncIterator]: pendingMessageIterator,
    });
    const connection = stubConnection({
      subscribe: jest
        .fn()
        .mockReturnValueOnce(failedSubscription)
        .mockReturnValue(activeSubscription),
    });
    const eventBus = fakeEventBus(connection);
    const rr = new NatsRequestReply(eventBus);

    const handle = await rr.respond<object, object>(
      'request.farm.validateSiteAssignment',
      resolveEmptyResponse,
    );
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(100);

    expect(connection.subscribe).toHaveBeenCalledTimes(2);
    expect(eventBus.disconnect).not.toHaveBeenCalled();
    expect(eventBus.setCoreResponderAvailability).toHaveBeenLastCalledWith(
      expect.any(String),
      true,
    );
    await handle.drain();
  });

  it('recovers when an iterator completes without throwing', async () => {
    jest.useFakeTimers();
    const completedSubscription = stubSubscription({
      [Symbol.asyncIterator]: completedMessageIterator,
    });
    const activeSubscription = stubSubscription({
      [Symbol.asyncIterator]: pendingMessageIterator,
    });
    const connection = stubConnection({
      subscribe: jest
        .fn()
        .mockReturnValueOnce(completedSubscription)
        .mockReturnValue(activeSubscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));

    const handle = await rr.respond<object, object>(
      'request.farm.validateSiteAssignment',
      resolveEmptyResponse,
    );
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(100);

    expect(connection.subscribe).toHaveBeenCalledTimes(2);
    await handle.drain();
    expect(activeSubscription.drain).toHaveBeenCalledTimes(1);
  });

  it('propagates the queue group to the Core NATS subscription', async () => {
    const drain = jest.fn().mockResolvedValue(undefined);
    const subscription = stubSubscription({
      drain,
      [Symbol.asyncIterator]: pendingMessageIterator,
    });
    const connection = stubConnection();
    const subscribe = jest.spyOn(connection, 'subscribe').mockReturnValue(subscription);
    const rr = new NatsRequestReply(fakeEventBus(connection));

    const handle = await rr.respond<object, object>(
      'request.farm.validateSiteAssignment',
      resolveEmptyResponse,
      { queue: 'farm-service' },
    );

    expect(subscribe).toHaveBeenCalledWith('request.farm.validateSiteAssignment', {
      queue: 'farm-service',
    });
    await handle.drain();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate subject-and-queue registrations in one process', async () => {
    const subscription = stubSubscription({
      [Symbol.asyncIterator]: pendingMessageIterator,
    });
    const connection = stubConnection({
      subscribe: jest.fn().mockReturnValue(subscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));
    const first = await rr.respond<object, object>(
      'request.farm.validateSiteAssignment',
      resolveEmptyResponse,
      { queue: 'farm-service' },
    );

    await expect(
      rr.respond<object, object>('request.farm.validateSiteAssignment', resolveEmptyResponse, {
        queue: 'farm-service',
      }),
    ).rejects.toBeInstanceOf(RequestReplyTransportError);
    expect(connection.subscribe).toHaveBeenCalledTimes(1);
    await first.drain();
  });

  it('forces unsubscribe after a drain failure before allowing re-registration', async () => {
    const firstSubscription = stubSubscription({
      drain: jest.fn().mockRejectedValue(new Error('drain failed')),
      [Symbol.asyncIterator]: pendingMessageIterator,
    });
    const secondSubscription = stubSubscription({
      [Symbol.asyncIterator]: pendingMessageIterator,
    });
    const connection = stubConnection({
      subscribe: jest
        .fn()
        .mockReturnValueOnce(firstSubscription)
        .mockReturnValue(secondSubscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));
    const first = await rr.respond<object, object>(
      'request.farm.validateSiteAssignment',
      resolveEmptyResponse,
      { queue: 'farm-service' },
    );

    await expect(first.drain()).rejects.toBeInstanceOf(AggregateError);
    expect(firstSubscription.unsubscribe).toHaveBeenCalledTimes(1);

    const second = await rr.respond<object, object>(
      'request.farm.validateSiteAssignment',
      resolveEmptyResponse,
      { queue: 'farm-service' },
    );
    expect(connection.subscribe).toHaveBeenCalledTimes(2);
    await second.drain();
  });

  it('cancels pending recovery when the responder is drained', async () => {
    jest.useFakeTimers();
    const failedSubscription = stubSubscription({
      [Symbol.asyncIterator]: () =>
        failingMessageIterator(new Error('subscription transport failed')),
    });
    const connection = stubConnection({
      subscribe: jest.fn().mockReturnValue(failedSubscription),
    });
    const rr = new NatsRequestReply(fakeEventBus(connection));
    const handle = await rr.respond<object, object>(
      'request.farm.validateSiteAssignment',
      resolveEmptyResponse,
    );
    await Promise.resolve();

    await handle.drain();
    await jest.runAllTimersAsync();

    expect(connection.subscribe).toHaveBeenCalledTimes(1);
  });

  it('reconciles onto a replacement connection generation without duplicate responders', async () => {
    const firstSubscription = stubSubscription({
      [Symbol.asyncIterator]: pendingMessageIterator,
    });
    const secondSubscription = stubSubscription({
      [Symbol.asyncIterator]: pendingMessageIterator,
    });
    const firstConnection = stubConnection({
      subscribe: jest.fn().mockReturnValue(firstSubscription),
    });
    const secondConnection = stubConnection({
      subscribe: jest.fn().mockReturnValue(secondSubscription),
    });
    const controlled = controlledEventBus(firstConnection);
    const rr = new NatsRequestReply(controlled.eventBus);
    const handle = await rr.respond<object, object>(
      'request.farm.validateSiteAssignment',
      resolveEmptyResponse,
      { queue: 'farm-service' },
    );

    controlled.emit({
      connection: firstConnection,
      generation: 1,
      state: 'disconnected',
    });
    controlled.emit({
      connection: secondConnection,
      generation: 2,
      state: 'connected',
    });
    await Promise.resolve();
    await Promise.resolve();
    controlled.emit({
      connection: secondConnection,
      generation: 2,
      state: 'connected',
    });
    await Promise.resolve();

    expect(firstConnection.subscribe).toHaveBeenCalledTimes(1);
    expect(firstSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(secondConnection.subscribe).toHaveBeenCalledTimes(1);
    await handle.drain();
    expect(secondSubscription.drain).toHaveBeenCalledTimes(1);
  });

  it('does not create a replacement responder until the old subscription is stopped', async () => {
    jest.useFakeTimers();
    const unsubscribe = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('unsubscribe failed');
      })
      .mockImplementation(() => undefined);
    const firstSubscription = stubSubscription({
      unsubscribe,
      [Symbol.asyncIterator]: pendingMessageIterator,
    });
    const secondSubscription = stubSubscription({
      [Symbol.asyncIterator]: pendingMessageIterator,
    });
    const firstConnection = stubConnection({
      subscribe: jest.fn().mockReturnValue(firstSubscription),
    });
    const secondConnection = stubConnection({
      subscribe: jest.fn().mockReturnValue(secondSubscription),
    });
    const controlled = controlledEventBus(firstConnection);
    const rr = new NatsRequestReply(controlled.eventBus);
    const handle = await rr.respond<object, object>(
      'request.farm.validateSiteAssignment',
      resolveEmptyResponse,
      { queue: 'farm-service' },
    );

    controlled.emit({
      connection: firstConnection,
      generation: 1,
      state: 'disconnected',
    });
    controlled.emit({
      connection: secondConnection,
      generation: 2,
      state: 'connected',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(secondConnection.subscribe).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(100);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(secondConnection.subscribe).toHaveBeenCalledTimes(1);
    await handle.drain();
  });

  it('keeps one bounded-delay recovery timer without giving up permanently', async () => {
    jest.useFakeTimers();
    const connection = stubConnection({
      subscribe: jest.fn().mockImplementation(() =>
        stubSubscription({
          [Symbol.asyncIterator]: () =>
            failingMessageIterator(new Error('persistent subscription failure')),
        }),
      ),
    });
    const eventBus = fakeEventBus(connection);
    const rr = new NatsRequestReply(eventBus);
    const handle = await rr.respond<object, object>(
      'request.farm.validateSiteAssignment',
      resolveEmptyResponse,
    );

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await jest.runOnlyPendingTimersAsync();
    }

    expect(connection.subscribe).toHaveBeenCalledTimes(13);
    expect(jest.getTimerCount()).toBe(1);
    expect(eventBus.setCoreResponderAvailability).toHaveBeenLastCalledWith(
      expect.any(String),
      false,
    );
    await handle.drain();
  });

  it('never copies a forgeable authenticated-identity header into handler context', async () => {
    const subject = 'request.farm.validateSiteAssignment';
    const forgedHeaders = headers();
    forgedHeaders.set('authenticated-identity', 'CN=auth_service');

    let resolveResponse!: () => void;
    const responseWritten = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const requestMessage: Msg = {
      ...replyMsg(
        JSON.stringify({
          tenantId: '7ad63561-8e14-4a61-942b-bf296be39fb7',
          siteId: '4dc41dfa-2645-45dc-a951-af7516e9cb9e',
        }),
      ),
      subject,
      reply: '_INBOX.site-assignment',
      headers: forgedHeaders,
      respond: jest.fn(() => {
        resolveResponse();
        return true;
      }),
    };
    const drain = jest.fn().mockResolvedValue(undefined);
    const subscription = stubSubscription({
      drain,
      [Symbol.asyncIterator]: () => messageThenPendingIterator([requestMessage]),
    });
    const connection = stubConnection({
      subscribe: jest.fn().mockReturnValue(subscription),
    });
    const handler = jest.fn(
      (_request: object, _context: { subject: string }): Promise<{ assignable: boolean }> =>
        Promise.resolve({ assignable: true }),
    );
    const rr = new NatsRequestReply(fakeEventBus(connection));

    const handle = await rr.respond<object, { assignable: boolean }>(subject, handler, {
      queue: 'farm-service',
    });
    await responseWritten;

    expect(handler).toHaveBeenCalledWith(
      {
        tenantId: '7ad63561-8e14-4a61-942b-bf296be39fb7',
        siteId: '4dc41dfa-2645-45dc-a951-af7516e9cb9e',
      },
      { subject },
    );

    await handle.drain();
    expect(drain).toHaveBeenCalledTimes(1);
  });
});
