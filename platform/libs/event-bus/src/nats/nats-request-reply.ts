// NATS v3 (@nats-io/* 3.x). The v2 monolithic `nats` package split into
// nats-core (connection + Msg/Subscription primitives + typed error classes).
// StringCodec was REMOVED — pass a string directly to request()/respond()
// (the lib UTF-8-encodes it, byte-identical wire to the v2 producer) and read
// the reply via msg.string(). ErrorCode/NatsError were REMOVED in favour of
// discrete error classes — a request timeout is now `TimeoutError`.
import { TimeoutError } from '@nats-io/nats-core';
import type {
  Msg,
  NatsConnection,
  Subscription,
} from '@nats-io/nats-core';
import { Injectable, Logger } from '@nestjs/common';

import {
  IRequestReply,
  RequestReplyContext,
  RequestReplyHandler,
  RequestReplyOptions,
  RequestReplyResponderHandle,
} from '../interfaces/event-bus.interface';
import { NatsEventBus } from './nats-event-bus';

/**
 * Base class for every request-reply failure mode. Each concrete
 * subclass is a distinct operator-alarm shelf so dashboards can
 * route by exception type without string-parsing error messages.
 * ADR-031 §failure-modes calls this taxonomy out explicitly.
 */
export abstract class NatsRequestReplyError extends Error {
  public override readonly name: string;

  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
}

/**
 * Responder did not answer within the caller-supplied budget.
 * Indicates "responder alive-or-dead, broker delivered the request"
 * unknown — the retry policy is caller-owned (typically retry with
 * exponential backoff then fall back to a secondary source).
 */
export class RequestReplyTimeoutError extends NatsRequestReplyError {
  constructor(public readonly subject: string, public readonly timeoutMs: number) {
    super(
      `NATS request-reply to "${subject}" timed out after ${timeoutMs}ms`,
      'RequestReplyTimeoutError',
    );
  }
}

/**
 * NATS-side transport error: broker rejected the request, no
 * responder registered, connection drop mid-flight, etc. Distinct
 * from timeout because the remediation differs (investigate broker
 * or cert chain, not the responder).
 */
export class RequestReplyTransportError extends NatsRequestReplyError {
  constructor(
    public readonly subject: string,
    public readonly cause: Error,
  ) {
    super(
      `NATS request-reply to "${subject}" transport failed: ${cause.message}`,
      'RequestReplyTransportError',
    );
  }
}

/**
 * JSON-encode of the request body failed. Essentially only fires
 * on cyclic references or values serde cannot represent (BigInt,
 * Function). Typed separately so a runtime regression on the caller
 * side (e.g. passing a class instance with private fields) surfaces
 * as a distinct log event.
 */
export class RequestReplyEncodeError extends NatsRequestReplyError {
  constructor(
    public readonly subject: string,
    public readonly cause: Error,
  ) {
    super(
      `NATS request-reply to "${subject}" request payload encode failed: ${cause.message}`,
      'RequestReplyEncodeError',
    );
  }
}

/**
 * JSON-decode of the responder reply failed. Almost always a wire-
 * shape drift: the Rust sidecar and the TS responder disagree on
 * the serialization contract. The variant exists so an alert rule
 * can page on "decode errors trending up" — that is the signal of
 * a silent deploy-version skew between services.
 */
export class RequestReplyDecodeError extends NatsRequestReplyError {
  constructor(
    public readonly subject: string,
    public readonly cause: Error,
  ) {
    super(
      `NATS request-reply to "${subject}" response payload decode failed: ${cause.message}`,
      'RequestReplyDecodeError',
    );
  }
}

/**
 * Transport is up, the responder answered, but the answer was an
 * application-level error (e.g. the snapshot does not exist for
 * this caller). The responder writes a well-known envelope; the
 * client raises this typed error. Reason lives on the instance so
 * alert rules can filter by responder code.
 */
export class RequestReplyRemoteError extends NatsRequestReplyError {
  constructor(
    public readonly subject: string,
    public readonly code: string,
    public override readonly message: string,
  ) {
    super(
      `NATS request-reply to "${subject}" responder returned error ${code}: ${message}`,
      'RequestReplyRemoteError',
    );
  }
}

/**
 * Wire envelope the responder writes when it surfaces an
 * application-level error. A successful reply is the raw `Res`
 * JSON; an error reply is an object with `__error: true`. Keeping
 * both shapes on the same subject lets the typed client choose
 * based on bytes alone without a separate error subject per
 * handler.
 */
interface RequestReplyErrorEnvelope {
  __error: true;
  code: string;
  message: string;
}

function isErrorEnvelope(v: unknown): v is RequestReplyErrorEnvelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    '__error' in v &&
    (v as { __error?: unknown }).__error === true &&
    typeof (v as { code?: unknown }).code === 'string' &&
    typeof (v as { message?: unknown }).message === 'string'
  );
}

/**
 * Typed NATS request-reply primitive (ADR-031).
 *
 * WHY this class is separate from {@link NatsEventBus} — the event
 * bus is pub/sub with JetStream durability; request-reply is core
 * NATS with a short synchronous round trip. Merging the two would
 * pull request-reply into the JetStream setup path, widening
 * cognitive complexity for readers who only care about events.
 * Splitting keeps each class single-responsibility while still
 * sharing the single mTLS connection ADR-015 mandates (obtained
 * via {@link NatsEventBus.getRawConnection}).
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-019
 */
@Injectable()
export class NatsRequestReply implements IRequestReply {
  private readonly logger = new Logger(NatsRequestReply.name);

  constructor(private readonly eventBus: NatsEventBus) {}

  async requestTyped<Req, Res>(
    subject: string,
    request: Req,
    options: RequestReplyOptions,
  ): Promise<Res> {
    const connection = this.eventBus.getRawConnection();
    if (connection === null) {
      throw new RequestReplyTransportError(
        subject,
        new Error('NATS connection is not established'),
      );
    }

    // ENCODE — typed generic → JSON string. JSON.stringify throws
    // TypeError for BigInt / cyclic refs; wrap so the caller sees
    // the canonical Encode shelf rather than a raw TypeError.
    // v3: request() accepts the string directly (UTF-8 encoded by the
    // lib) — no StringCodec.encode(). Byte-identical wire to v2.
    let payload: string;
    try {
      const json = JSON.stringify(request);
      if (json === undefined) {
        // `undefined` serialises to undefined; this would send an
        // empty body which the responder would struggle to decode.
        // Refuse the request at the caller boundary instead.
        throw new TypeError(
          'request body serialises to undefined (JSON.stringify returned undefined)',
        );
      }
      payload = json;
    } catch (e) {
      throw new RequestReplyEncodeError(
        subject,
        e instanceof Error ? e : new Error(String(e)),
      );
    }

    // ROUND-TRIP — core NATS request. noMux=true would create a
    // dedicated subscriber per call; the muxed default is both
    // cheaper and the canonical path for short replies.
    let reply: Msg;
    try {
      reply = await connection.request(subject, payload, {
        timeout: options.timeoutMs,
      });
    } catch (e) {
      // v3: a request that exceeds its timeout budget rejects with the
      // discrete TimeoutError class (replacing v2's
      // `NatsError + ErrorCode.Timeout` sentinel check).
      if (e instanceof TimeoutError) {
        throw new RequestReplyTimeoutError(subject, options.timeoutMs);
      }
      // NoResponders + every other transport-class failure land
      // here. Wrap uniformly so alert rules see one variant.
      throw new RequestReplyTransportError(
        subject,
        e instanceof Error ? e : new Error(String(e)),
      );
    }

    // DECODE — bytes → Res. A malformed reply (non-JSON, shape
    // mismatch) is a contract drift, not a transport problem.
    let parsed: unknown;
    try {
      // v3: reply.string() replaces StringCodec.decode(reply.data) — same UTF-8 bytes.
      parsed = JSON.parse(reply.string());
    } catch (e) {
      throw new RequestReplyDecodeError(
        subject,
        e instanceof Error ? e : new Error(String(e)),
      );
    }

    // Structured remote-error envelope — responder surfaced an
    // application-level failure. Raise typed so the caller can
    // branch on code without parsing log strings.
    if (isErrorEnvelope(parsed)) {
      throw new RequestReplyRemoteError(subject, parsed.code, parsed.message);
    }

    return parsed as Res;
  }

  async respond<Req, Res>(
    subject: string,
    handler: RequestReplyHandler<Req, Res>,
  ): Promise<RequestReplyResponderHandle> {
    const connection = this.eventBus.getRawConnection();
    if (connection === null) {
      throw new RequestReplyTransportError(
        subject,
        new Error('NATS connection is not established'),
      );
    }

    const subscription = connection.subscribe(subject);
    this.logger.log(`request-reply responder online: ${subject}`);

    // Drive the subscription on a background task so respond()
    // returns after setup without blocking the caller.
    void this.consumeRequests(subject, subscription, handler);

    return {
      subject,
      drain: async () => {
        await subscription.drain();
      },
    };
  }

  private async consumeRequests<Req, Res>(
    subject: string,
    subscription: Subscription,
    handler: RequestReplyHandler<Req, Res>,
  ): Promise<void> {
    for await (const msg of subscription) {
      try {
        await this.handleOneRequest(subject, msg, handler);
      } catch (e) {
        this.logger.error(
          `request-reply handler uncaught: subject=${subject}`,
          e instanceof Error ? e.stack : String(e),
        );
      }
    }
  }

  private async handleOneRequest<Req, Res>(
    subject: string,
    msg: Msg,
    handler: RequestReplyHandler<Req, Res>,
  ): Promise<void> {
    // Messages with no reply inbox are not request-reply — they are
    // plain publishes that happened to match the subject. Drop them
    // quietly so a hand-fired publish cannot exhaust handler
    // threads.
    if (!msg.reply) {
      this.logger.warn(
        `request-reply: received message with no reply inbox on ${subject}; dropping`,
      );
      return;
    }

    // DECODE the incoming request body.
    // v3: msg.string() replaces StringCodec.decode(msg.data) — same UTF-8 bytes.
    let request: Req;
    try {
      request = JSON.parse(msg.string()) as Req;
    } catch (e) {
      this.writeErrorEnvelope(msg, 'INVALID_REQUEST', (e as Error).message);
      return;
    }

    // Extract the authenticated identity if the transport surfaced
    // it (mTLS cert CN on production). Not all transports populate
    // this, so the context stays optional.
    const headerIdentity = msg.headers?.get('authenticated-identity');
    const context: RequestReplyContext = {
      subject,
      authenticatedIdentity: headerIdentity && headerIdentity.length > 0
        ? headerIdentity
        : undefined,
    };

    // INVOKE the handler. Any throw becomes a remote-error envelope
    // so the client raises a typed `RequestReplyRemoteError`
    // instead of hanging until its timeout.
    let response: Res;
    try {
      response = await handler(request, context);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = e instanceof Error && e.name !== 'Error' ? e.name : 'HANDLER_ERROR';
      this.writeErrorEnvelope(msg, code, message);
      return;
    }

    // ENCODE the response. If this throws the responder has a bug,
    // but the caller would hang — surface as a remote-error so the
    // caller receives SOMETHING.
    try {
      const json = JSON.stringify(response);
      if (json === undefined) {
        this.writeErrorEnvelope(msg, 'ENCODE_ERROR', 'response serialises to undefined');
        return;
      }
      // v3: respond() accepts the string directly (UTF-8 encoded by the lib) —
      // no StringCodec.encode(). Byte-identical wire to the v2 producer.
      msg.respond(json);
    } catch (e) {
      this.writeErrorEnvelope(
        msg,
        'ENCODE_ERROR',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  private writeErrorEnvelope(msg: Msg, code: string, message: string): void {
    const envelope: RequestReplyErrorEnvelope = {
      __error: true,
      code,
      message,
    };
    try {
      // v3: respond() accepts the string directly — no StringCodec.encode().
      msg.respond(JSON.stringify(envelope));
    } catch (e) {
      this.logger.error(
        `request-reply: failed to write error envelope`,
        e instanceof Error ? e.stack : String(e),
      );
    }
  }
}
