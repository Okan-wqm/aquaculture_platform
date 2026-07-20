// NATS v3 (@nats-io/* 3.x). The v2 monolithic `nats` package split into
// nats-core (connection + Msg/Subscription primitives + typed error classes).
// StringCodec was REMOVED — pass a string directly to request()/respond()
// (the lib UTF-8-encodes it, byte-identical wire to the v2 producer) and read
// the reply via msg.string(). ErrorCode/NatsError were REMOVED in favour of
// discrete error classes — a request timeout is now `TimeoutError`.
import { TimeoutError } from '@nats-io/nats-core';
import type { Msg, Subscription } from '@nats-io/nats-core';
import { Injectable, Logger } from '@nestjs/common';

import type {
  IRequestReply,
  RequestReplyContext,
  RequestReplyHandler,
  RequestReplyOptions,
  RequestReplyResponderHandle,
  RequestReplyResponderOptions,
  RequestReplySanitizedRemoteErrorPolicy,
  RequestReplySanitizedResponderErrorPolicy,
  RequestReplyScopedInboxPolicy,
} from '../interfaces/event-bus.interface';

import { NatsEventBus } from './nats-event-bus';

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ALLOWED_ERROR_CODES = 64;
const MAX_REMOTE_ERROR_MESSAGE_BYTES = 2_048;
// services.schema.json caps an ACL subject at 120 characters. A scoped
// subscription is `<prefix>.>`, leaving 118 bytes for the ASCII-only prefix.
const MAX_SCOPED_INBOX_PREFIX_BYTES = 118;
const SANITIZED_ERROR_MESSAGE = 'Request failed';

interface CompiledRemoteErrorPolicy {
  readonly allowedCodes: ReadonlySet<string>;
}

interface CompiledResponderOptions {
  readonly replyInboxPrefix?: string;
  readonly errorPolicy?: {
    readonly allowedCodes: ReadonlySet<string>;
    readonly fallbackCode: string;
  };
}

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
  constructor(
    public readonly subject: string,
    public readonly timeoutMs: number,
  ) {
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

/** Registration/caller policy is malformed and cannot be enforced safely. */
export class RequestReplyPolicyError extends NatsRequestReplyError {
  constructor(
    public readonly subject: string,
    reason: string,
  ) {
    super(
      `NATS request-reply policy for "${subject}" is invalid: ${reason}`,
      'RequestReplyPolicyError',
    );
  }
}

/**
 * A handler may throw this type to request one stable public error code.
 * Sanitized responders emit the code only when their registration policy
 * explicitly allowlists it; the Error message is always generic.
 */
export class RequestReplyHandlerError extends Error {
  public override readonly name = 'RequestReplyHandlerError';

  constructor(public readonly code: string) {
    super(SANITIZED_ERROR_MESSAGE);
    if (!ERROR_CODE_PATTERN.test(code)) {
      throw new RangeError('request-reply handler code must match [A-Z][A-Z0-9_]{0,63}');
    }
  }
}

/**
 * Transport is up, the responder answered, but the answer was an
 * application-level error (e.g. the snapshot does not exist for
 * this caller). The responder writes a well-known envelope; the
 * client raises this typed error. The stable code lives on the instance so
 * alert rules can filter by it; sanitized mode never retains the remote
 * message.
 */
export class RequestReplyRemoteError extends NatsRequestReplyError {
  public readonly subject: string;
  public readonly code: string;
  public readonly sanitized: boolean;

  constructor(subject: string, code: string, remoteMessage: string, sanitized = false) {
    super(
      sanitized
        ? `NATS request-reply to "${subject}" responder returned error ${code}`
        : remoteMessage,
      'RequestReplyRemoteError',
    );
    this.subject = subject;
    this.code = code;
    this.sanitized = sanitized;
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
    isUnknownRecord(v) &&
    v['__error'] === true &&
    typeof v['code'] === 'string' &&
    typeof v['message'] === 'string'
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsErrorEnvelopeMarker(value: unknown): boolean {
  return isUnknownRecord(value) && Object.prototype.hasOwnProperty.call(value, '__error');
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateErrorCode(code: string): boolean {
  return ERROR_CODE_PATTERN.test(code);
}

function compileAllowedCodes(subject: string, codes: readonly string[]): ReadonlySet<string> {
  if (codes.length === 0 || codes.length > MAX_ALLOWED_ERROR_CODES) {
    throw new RequestReplyPolicyError(
      subject,
      `allowedCodes must contain between 1 and ${MAX_ALLOWED_ERROR_CODES} entries`,
    );
  }

  const allowedCodes = new Set<string>();
  for (const code of codes) {
    if (!validateErrorCode(code)) {
      throw new RequestReplyPolicyError(
        subject,
        'every allowed code must match [A-Z][A-Z0-9_]{0,63}',
      );
    }
    if (allowedCodes.has(code)) {
      throw new RequestReplyPolicyError(subject, 'allowedCodes must not contain duplicate entries');
    }
    allowedCodes.add(code);
  }
  return allowedCodes;
}

function compileRemoteErrorPolicy(
  subject: string,
  policy: RequestReplySanitizedRemoteErrorPolicy | undefined,
): CompiledRemoteErrorPolicy | undefined {
  if (policy === undefined) {
    return undefined;
  }
  if (policy.mode !== 'sanitized') {
    throw new RequestReplyPolicyError(subject, 'remote error policy mode must be sanitized');
  }
  return { allowedCodes: compileAllowedCodes(subject, policy.allowedCodes) };
}

function isConcreteInboxToken(value: string): boolean {
  return (
    value.length > 0 &&
    utf8ByteLength(value) <= MAX_SCOPED_INBOX_PREFIX_BYTES &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function compileReplyInboxPolicy(
  subject: string,
  policy: RequestReplyScopedInboxPolicy | undefined,
): string | undefined {
  if (policy === undefined) {
    return undefined;
  }
  if (
    policy.mode !== 'exact-prefix' ||
    !isConcreteInboxToken(policy.prefix) ||
    !/^_INBOX[A-Z][A-Z0-9]*$/.test(policy.prefix)
  ) {
    throw new RequestReplyPolicyError(
      subject,
      'reply inbox prefix must match _INBOX[A-Z][A-Z0-9]* and contain at most 118 bytes',
    );
  }
  return policy.prefix;
}

function compileResponderErrorPolicy(
  subject: string,
  policy: RequestReplySanitizedResponderErrorPolicy | undefined,
): CompiledResponderOptions['errorPolicy'] {
  if (policy === undefined) {
    return undefined;
  }
  if (policy.mode !== 'sanitized') {
    throw new RequestReplyPolicyError(subject, 'responder error policy mode must be sanitized');
  }
  const allowedCodes = compileAllowedCodes(subject, policy.allowedCodes);
  if (!allowedCodes.has(policy.fallbackCode)) {
    throw new RequestReplyPolicyError(subject, 'fallbackCode must be present in allowedCodes');
  }
  return { allowedCodes, fallbackCode: policy.fallbackCode };
}

function compileResponderOptions(
  subject: string,
  options: RequestReplyResponderOptions | undefined,
): CompiledResponderOptions {
  return {
    replyInboxPrefix: compileReplyInboxPolicy(subject, options?.replyInboxPolicy),
    errorPolicy: compileResponderErrorPolicy(subject, options?.errorPolicy),
  };
}

function isExactScopedReplySubject(replySubject: string, prefix: string): boolean {
  const expectedStart = `${prefix}.`;
  if (!replySubject.startsWith(expectedStart)) {
    return false;
  }
  return isConcreteInboxToken(replySubject.slice(expectedStart.length));
}

function decodeSanitizedErrorEnvelope(
  value: unknown,
  policy: CompiledRemoteErrorPolicy,
): RequestReplyErrorEnvelope {
  if (!isUnknownRecord(value)) {
    throw new Error('response error envelope failed validation');
  }

  const keys = Object.keys(value);
  const marker = value['__error'];
  const code = value['code'];
  const message = value['message'];
  if (
    keys.length !== 3 ||
    !keys.includes('__error') ||
    !keys.includes('code') ||
    !keys.includes('message') ||
    marker !== true ||
    typeof code !== 'string' ||
    !validateErrorCode(code) ||
    !policy.allowedCodes.has(code) ||
    typeof message !== 'string' ||
    message.length === 0 ||
    utf8ByteLength(message) > MAX_REMOTE_ERROR_MESSAGE_BYTES
  ) {
    throw new Error('response error envelope failed validation');
  }

  return {
    __error: true,
    code,
    message,
  };
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
    const remoteErrorPolicy = compileRemoteErrorPolicy(subject, options.remoteErrorPolicy);
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
      throw new RequestReplyEncodeError(subject, e instanceof Error ? e : new Error(String(e)));
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
      throw new RequestReplyTransportError(subject, e instanceof Error ? e : new Error(String(e)));
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
        remoteErrorPolicy === undefined
          ? e instanceof Error
            ? e
            : new Error(String(e))
          : new Error('response was not valid JSON'),
      );
    }

    // Structured remote-error envelope — responder surfaced an
    // application-level failure. Raise typed so the caller can
    // branch on code without parsing log strings.
    if (remoteErrorPolicy !== undefined && containsErrorEnvelopeMarker(parsed)) {
      let envelope: RequestReplyErrorEnvelope;
      try {
        envelope = decodeSanitizedErrorEnvelope(parsed, remoteErrorPolicy);
      } catch {
        throw new RequestReplyDecodeError(
          subject,
          new Error('response error envelope failed validation'),
        );
      }
      throw new RequestReplyRemoteError(subject, envelope.code, envelope.message, true);
    }

    if (isErrorEnvelope(parsed)) {
      throw new RequestReplyRemoteError(subject, parsed.code, parsed.message);
    }

    return parsed as Res;
  }

  respond<Req, Res>(
    subject: string,
    handler: RequestReplyHandler<Req, Res>,
    options?: RequestReplyResponderOptions,
  ): Promise<RequestReplyResponderHandle> {
    return Promise.resolve().then(() => {
      const compiledOptions = compileResponderOptions(subject, options);
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
      void this.consumeRequests(subject, subscription, handler, compiledOptions);

      return {
        subject,
        drain: async () => {
          await subscription.drain();
        },
      };
    });
  }

  private async consumeRequests<Req, Res>(
    subject: string,
    subscription: Subscription,
    handler: RequestReplyHandler<Req, Res>,
    options: CompiledResponderOptions,
  ): Promise<void> {
    for await (const msg of subscription) {
      try {
        await this.handleOneRequest(subject, msg, handler, options);
      } catch (e) {
        if (options.errorPolicy === undefined) {
          this.logger.error(
            `request-reply handler uncaught: subject=${subject}`,
            e instanceof Error ? e.stack : String(e),
          );
        } else {
          this.logger.error(
            `request-reply handler uncaught: subject=${subject}; details suppressed by sanitized error policy`,
          );
        }
      }
    }
  }

  private async handleOneRequest<Req, Res>(
    subject: string,
    msg: Msg,
    handler: RequestReplyHandler<Req, Res>,
    options: CompiledResponderOptions,
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

    // The reply subject is publisher-controlled transport metadata. A scoped
    // responder checks it before touching request bytes or authoritative state.
    if (
      options.replyInboxPrefix !== undefined &&
      !isExactScopedReplySubject(msg.reply, options.replyInboxPrefix)
    ) {
      this.logger.warn(
        `request-reply: rejected reply inbox outside configured scope on ${subject}`,
      );
      return;
    }

    // DECODE the incoming request body.
    // v3: msg.string() replaces StringCodec.decode(msg.data) — same UTF-8 bytes.
    let request: Req;
    try {
      request = JSON.parse(msg.string()) as Req;
    } catch (e) {
      this.writeCaughtErrorEnvelope(msg, 'INVALID_REQUEST', e, options);
      return;
    }

    // This is a raw publisher-supplied message header. NATS Msg does not
    // expose the peer certificate CN, so the value is never authorization
    // input and is exposed only under an explicitly untrusted field name.
    const headerIdentity = msg.headers?.get('authenticated-identity');
    const context: RequestReplyContext = {
      subject,
      replySubject: msg.reply,
      untrustedAuthenticatedIdentityHeader:
        headerIdentity && headerIdentity.length > 0 ? headerIdentity : undefined,
    };

    // INVOKE the handler. Any throw becomes a remote-error envelope
    // so the client raises a typed `RequestReplyRemoteError`
    // instead of hanging until its timeout.
    let response: Res;
    try {
      response = await handler(request, context);
    } catch (e) {
      if (options.errorPolicy !== undefined) {
        const code =
          e instanceof RequestReplyHandlerError ? e.code : options.errorPolicy.fallbackCode;
        this.writePolicyErrorEnvelope(msg, code, SANITIZED_ERROR_MESSAGE, options);
      } else {
        const message = e instanceof Error ? e.message : String(e);
        const code = e instanceof Error && e.name !== 'Error' ? e.name : 'HANDLER_ERROR';
        this.writePolicyErrorEnvelope(msg, code, message, options);
      }
      return;
    }

    // ENCODE the response. If this throws the responder has a bug,
    // but the caller would hang — surface as a remote-error so the
    // caller receives SOMETHING.
    try {
      const json = JSON.stringify(response);
      if (json === undefined) {
        this.writePolicyErrorEnvelope(
          msg,
          'ENCODE_ERROR',
          'response serialises to undefined',
          options,
        );
        return;
      }
      // v3: respond() accepts the string directly (UTF-8 encoded by the lib) —
      // no StringCodec.encode(). Byte-identical wire to the v2 producer.
      msg.respond(json);
    } catch (e) {
      this.writeCaughtErrorEnvelope(msg, 'ENCODE_ERROR', e, options);
    }
  }

  private writeCaughtErrorEnvelope(
    msg: Msg,
    requestedCode: string,
    caught: unknown,
    options: CompiledResponderOptions,
  ): void {
    if (options.errorPolicy !== undefined) {
      this.writePolicyErrorEnvelope(msg, requestedCode, SANITIZED_ERROR_MESSAGE, options);
      return;
    }

    this.writePolicyErrorEnvelope(
      msg,
      requestedCode,
      caught instanceof Error ? caught.message : String(caught),
      options,
    );
  }

  private writePolicyErrorEnvelope(
    msg: Msg,
    requestedCode: string,
    legacyMessage: string,
    options: CompiledResponderOptions,
  ): void {
    const policy = options.errorPolicy;
    if (policy === undefined) {
      this.writeErrorEnvelope(msg, requestedCode, legacyMessage, false);
      return;
    }

    const code = policy.allowedCodes.has(requestedCode) ? requestedCode : policy.fallbackCode;
    this.writeErrorEnvelope(msg, code, SANITIZED_ERROR_MESSAGE, true);
  }

  private writeErrorEnvelope(
    msg: Msg,
    code: string,
    message: string,
    suppressFailureDetails: boolean,
  ): void {
    const envelope: RequestReplyErrorEnvelope = {
      __error: true,
      code,
      message,
    };
    try {
      // v3: respond() accepts the string directly — no StringCodec.encode().
      msg.respond(JSON.stringify(envelope));
    } catch (e) {
      if (suppressFailureDetails) {
        this.logger.error(
          'request-reply: failed to write sanitized error envelope; details suppressed',
        );
      } else {
        this.logger.error(
          `request-reply: failed to write error envelope`,
          e instanceof Error ? e.stack : String(e),
        );
      }
    }
  }
}
