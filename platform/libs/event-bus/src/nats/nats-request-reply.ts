// NATS v3 (@nats-io/* 3.x). The v2 monolithic `nats` package split into
// nats-core (connection + Msg/Subscription primitives + typed error classes).
// StringCodec was REMOVED — pass a string directly to request()/respond()
// (the lib UTF-8-encodes it, byte-identical wire to the v2 producer) and read
// the reply via msg.string(). ErrorCode/NatsError were REMOVED in favour of
// discrete error classes — a request timeout is now `TimeoutError`.
import { TimeoutError } from '@nats-io/nats-core';
import type { Msg, Subscription } from '@nats-io/nats-core';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import {
  IRequestReply,
  RequestReplyContext,
  RequestReplyHandler,
  RequestReplyOptions,
  RequestReplyResponderHandle,
  RequestReplyResponderOptions,
} from '../interfaces/event-bus.interface';

import { NatsEventBus } from './nats-event-bus';
import type { CoreNatsConnectionSnapshot } from './nats-event-bus';

const RESPONDER_RECOVERY_DEGRADED_ATTEMPT = 10;
const RESPONDER_RECOVERY_LOG_INTERVAL = 10;
const RESPONDER_RECOVERY_BASE_DELAY_MS = 100;
const RESPONDER_RECOVERY_MAX_DELAY_MS = 5_000;
const RESPONDER_STABILITY_WINDOW_MS = 30_000;

interface ActiveResponder {
  readonly subscription: Subscription;
  readonly connectionGeneration: number;
  readonly activationId: number;
}

interface ManagedResponderRegistration {
  readonly key: string;
  readonly subject: string;
  readonly queue: string | undefined;
  active: ActiveResponder | null;
  activationId: number;
  activationPromise: Promise<void> | null;
  recoveryAttempts: number;
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  stabilityTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  drainPromise: Promise<void> | null;
  activate(): Promise<void>;
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
export class NatsRequestReply implements IRequestReply, OnModuleDestroy {
  private readonly logger = new Logger(NatsRequestReply.name);
  private readonly responders = new Map<string, ManagedResponderRegistration>();
  private readonly removeConnectionLifecycleListener: () => void;
  private lastConnectionSnapshot: CoreNatsConnectionSnapshot;

  constructor(private readonly eventBus: NatsEventBus) {
    this.lastConnectionSnapshot = this.eventBus.getCoreConnectionSnapshot();
    this.removeConnectionLifecycleListener = this.eventBus.onCoreConnectionLifecycle((snapshot) => {
      this.handleConnectionLifecycle(snapshot);
    });
  }

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
      throw new RequestReplyDecodeError(subject, e instanceof Error ? e : new Error(String(e)));
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
    options?: RequestReplyResponderOptions,
  ): Promise<RequestReplyResponderHandle> {
    const registrationKey = this.buildRegistrationKey(subject, options?.queue);
    if (this.responders.has(registrationKey)) {
      throw new RequestReplyTransportError(
        subject,
        new Error(
          'A responder for this subject and queue group is already registered in this process',
        ),
      );
    }

    const registration: ManagedResponderRegistration = {
      key: registrationKey,
      subject,
      queue: options?.queue,
      active: null,
      activationId: 0,
      activationPromise: null,
      recoveryAttempts: 0,
      recoveryTimer: null,
      stabilityTimer: null,
      stopped: false,
      drainPromise: null,
      activate: async () => {
        await this.activateResponder(registration, handler);
      },
    };

    this.responders.set(registrationKey, registration);
    this.eventBus.setCoreResponderAvailability(registrationKey, false);
    try {
      await registration.activate();
    } catch (error) {
      this.responders.delete(registrationKey);
      this.eventBus.setCoreResponderAvailability(registrationKey, true);
      throw error;
    }

    return {
      subject,
      drain: async () => {
        await this.drainResponder(registration);
      },
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.removeConnectionLifecycleListener();
    const results = await Promise.allSettled(
      [...this.responders.values()].map(async (registration) => {
        await this.drainResponder(registration);
      }),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) =>
        result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
      );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more Core NATS responders failed to drain');
    }
  }

  private buildRegistrationKey(subject: string, queue: string | undefined): string {
    return JSON.stringify([subject, queue ?? null]);
  }

  private handleConnectionLifecycle(snapshot: CoreNatsConnectionSnapshot): void {
    const connectionBecameAvailable =
      snapshot.state === 'connected' &&
      (this.lastConnectionSnapshot.state !== 'connected' ||
        this.lastConnectionSnapshot.generation !== snapshot.generation);
    this.lastConnectionSnapshot = snapshot;

    if (!connectionBecameAvailable) {
      return;
    }

    for (const registration of this.responders.values()) {
      if (
        (registration.active !== null &&
          registration.active.connectionGeneration === snapshot.generation) ||
        registration.stopped
      ) {
        continue;
      }
      registration.recoveryAttempts = 0;
      this.clearRecoveryTimer(registration);
      void registration.activate().catch((error: unknown) => {
        this.handleActivationFailure(registration, error);
      });
    }
  }

  private async activateResponder<Req, Res>(
    registration: ManagedResponderRegistration,
    handler: RequestReplyHandler<Req, Res>,
  ): Promise<void> {
    if (registration.stopped) {
      return;
    }
    if (registration.activationPromise !== null) {
      await registration.activationPromise;
      return;
    }

    const operation = this.createResponderSubscription(registration, handler);
    registration.activationPromise = operation;
    try {
      await operation;
    } finally {
      if (registration.activationPromise === operation) {
        registration.activationPromise = null;
      }
    }
  }

  private async createResponderSubscription<Req, Res>(
    registration: ManagedResponderRegistration,
    handler: RequestReplyHandler<Req, Res>,
  ): Promise<void> {
    // Publish the single-flight activation Promise before touching the
    // connection so concurrent lifecycle notifications cannot subscribe twice.
    await Promise.resolve();
    const snapshot = this.eventBus.getCoreConnectionSnapshot();
    if (snapshot.connection === null || snapshot.state !== 'connected') {
      throw new RequestReplyTransportError(
        registration.subject,
        new Error('NATS connection is not established'),
      );
    }
    if (
      registration.active !== null &&
      registration.active.connectionGeneration === snapshot.generation
    ) {
      return;
    }

    const previous = registration.active;
    if (previous !== null) {
      try {
        previous.subscription.unsubscribe();
      } catch (error) {
        throw new RequestReplyTransportError(
          registration.subject,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      registration.active = null;
    }

    let subscription: Subscription;
    try {
      subscription = snapshot.connection.subscribe(
        registration.subject,
        registration.queue === undefined ? undefined : { queue: registration.queue },
      );
    } catch (error) {
      throw new RequestReplyTransportError(
        registration.subject,
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    if (registration.stopped) {
      subscription.unsubscribe();
      return;
    }

    registration.activationId += 1;
    const active: ActiveResponder = {
      subscription,
      connectionGeneration: snapshot.generation,
      activationId: registration.activationId,
    };
    registration.active = active;
    this.clearRecoveryTimer(registration);
    this.scheduleStabilityReset(registration, active);
    this.eventBus.setCoreResponderAvailability(registration.key, true);
    this.logger.log(
      JSON.stringify({
        event: 'request_reply_responder_online',
        queueGrouped: registration.queue !== undefined,
        connectionGeneration: snapshot.generation,
      }),
    );

    void this.superviseResponder(registration, active, handler).catch((error: unknown) => {
      this.logger.error(
        JSON.stringify({
          event: 'request_reply_responder_supervisor_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      this.handleResponderTermination(registration, active, error);
    });
  }

  private async superviseResponder<Req, Res>(
    registration: ManagedResponderRegistration,
    active: ActiveResponder,
    handler: RequestReplyHandler<Req, Res>,
  ): Promise<void> {
    let terminalError: unknown;
    try {
      await this.consumeRequests(registration.subject, active.subscription, handler);
    } catch (error) {
      terminalError = error;
    }
    this.handleResponderTermination(registration, active, terminalError);
  }

  private handleResponderTermination(
    registration: ManagedResponderRegistration,
    active: ActiveResponder,
    terminalError: unknown,
  ): void {
    if (
      registration.stopped ||
      registration.active === null ||
      registration.active.activationId !== active.activationId
    ) {
      return;
    }

    registration.active = null;
    this.clearStabilityTimer(registration);
    this.eventBus.setCoreResponderAvailability(registration.key, false);
    this.logger.error(
      JSON.stringify({
        event: 'request_reply_responder_terminated',
        termination: terminalError === undefined ? 'iterator_completed' : 'iterator_error',
        errorType: terminalError instanceof Error ? terminalError.name : 'UnknownError',
      }),
    );
    this.scheduleResponderRecovery(registration);
    try {
      active.subscription.unsubscribe();
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'request_reply_responder_unsubscribe_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }
  }

  private handleActivationFailure(
    registration: ManagedResponderRegistration,
    error: unknown,
  ): void {
    if (registration.stopped) {
      return;
    }
    this.eventBus.setCoreResponderAvailability(registration.key, false);
    this.logger.error(
      JSON.stringify({
        event: 'request_reply_responder_activation_failed',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    this.scheduleResponderRecovery(registration);
  }

  private scheduleResponderRecovery(registration: ManagedResponderRegistration): void {
    if (registration.stopped || registration.recoveryTimer !== null) {
      return;
    }
    registration.recoveryAttempts += 1;
    if (
      registration.recoveryAttempts >= RESPONDER_RECOVERY_DEGRADED_ATTEMPT &&
      registration.recoveryAttempts % RESPONDER_RECOVERY_LOG_INTERVAL === 0
    ) {
      this.logger.error(
        JSON.stringify({
          event: 'request_reply_responder_recovery_degraded',
          attempts: registration.recoveryAttempts,
        }),
      );
    }
    const delayMs = Math.min(
      RESPONDER_RECOVERY_BASE_DELAY_MS *
        2 ** Math.min(16, Math.max(0, registration.recoveryAttempts - 1)),
      RESPONDER_RECOVERY_MAX_DELAY_MS,
    );
    registration.recoveryTimer = setTimeout(() => {
      registration.recoveryTimer = null;
      void registration.activate().catch((error: unknown) => {
        this.handleActivationFailure(registration, error);
      });
    }, delayMs);
    registration.recoveryTimer.unref();
  }

  private clearRecoveryTimer(registration: ManagedResponderRegistration): void {
    if (registration.recoveryTimer !== null) {
      clearTimeout(registration.recoveryTimer);
      registration.recoveryTimer = null;
    }
  }

  private scheduleStabilityReset(
    registration: ManagedResponderRegistration,
    active: ActiveResponder,
  ): void {
    this.clearStabilityTimer(registration);
    registration.stabilityTimer = setTimeout(() => {
      registration.stabilityTimer = null;
      if (
        !registration.stopped &&
        registration.active !== null &&
        registration.active.activationId === active.activationId
      ) {
        registration.recoveryAttempts = 0;
      }
    }, RESPONDER_STABILITY_WINDOW_MS);
    registration.stabilityTimer.unref();
  }

  private clearStabilityTimer(registration: ManagedResponderRegistration): void {
    if (registration.stabilityTimer !== null) {
      clearTimeout(registration.stabilityTimer);
      registration.stabilityTimer = null;
    }
  }

  private async drainResponder(registration: ManagedResponderRegistration): Promise<void> {
    if (registration.drainPromise !== null) {
      await registration.drainPromise;
      return;
    }

    const operation = this.performResponderDrain(registration);
    registration.drainPromise = operation;
    await operation;
  }

  private async performResponderDrain(registration: ManagedResponderRegistration): Promise<void> {
    registration.stopped = true;
    this.clearRecoveryTimer(registration);
    this.clearStabilityTimer(registration);

    if (registration.activationPromise !== null) {
      try {
        await registration.activationPromise;
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: 'request_reply_responder_drain_activation_failed',
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
      }
    }

    const active = registration.active;
    registration.active = null;
    if (active === null) {
      this.responders.delete(registration.key);
      this.eventBus.setCoreResponderAvailability(registration.key, true);
      return;
    }

    const failures: Error[] = [];
    let stopped = false;
    try {
      await active.subscription.drain();
      stopped = true;
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      try {
        active.subscription.unsubscribe();
        stopped = true;
      } catch (unsubscribeError) {
        failures.push(
          unsubscribeError instanceof Error
            ? unsubscribeError
            : new Error(String(unsubscribeError)),
        );
      }
    }

    if (stopped) {
      this.responders.delete(registration.key);
      this.eventBus.setCoreResponderAvailability(registration.key, true);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Core NATS responder drain required forced unsubscribe');
    }
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
          JSON.stringify({
            event: 'request_reply_handler_uncaught',
            errorType: e instanceof Error ? e.name : 'UnknownError',
          }),
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
      this.logger.warn(JSON.stringify({ event: 'request_reply_message_without_reply_dropped' }));
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

    // Caller identity is broker-enforced by account/certificate ACLs. Never
    // derive it from application-controlled message headers.
    const context: RequestReplyContext = {
      subject,
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
      this.writeErrorEnvelope(msg, 'ENCODE_ERROR', e instanceof Error ? e.message : String(e));
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
        JSON.stringify({
          event: 'request_reply_error_envelope_write_failed',
          errorType: e instanceof Error ? e.name : 'UnknownError',
        }),
      );
    }
  }
}
