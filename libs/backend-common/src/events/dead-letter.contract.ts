/**
 * Dead-letter contract — the inbound half of event durability (W7,
 * FARM-MEDIUM-260).
 *
 * The platform already guarantees the OUTBOUND leg: a domain change and its
 * event land in one transaction (`outbox_events`), and the outbox worker
 * republishes until JetStream acks. The INBOUND leg had no such shelf. When a
 * consumer's handler kept throwing, `NatsEventBus` NAK'd with backoff until
 * the consumer's `max_deliver` ran out — and then the message was simply gone.
 * For a *reproducible* signal (a forecast a cron re-emits tomorrow) that is
 * acceptable. For a *one-shot state transition* — "this meal was missed",
 * "this unit was underfed", "here is today's summary" — it is permanent,
 * silent data loss, and it is exactly why alert-engine's feeding consumers
 * were written to swallow their own errors: without a shelf, a rethrow only
 * traded silent loss for a redelivery storm.
 *
 * This contract is the shelf. It deliberately lives in backend-common rather
 * than in `@platform/event-bus`, because the event bus already depends on
 * backend-common (`/nats`, `/constants`) — putting the token there instead
 * would invert that edge and create a package cycle.
 *
 * Writing to the shelf is a HARD requirement before a message may be
 * terminated: the bus only calls `msg.term()` after `record()` resolves. A
 * sink that throws gets a NAK instead — not because that saves the message
 * (past `max_deliver` JetStream drops it either way) but because `term()` is
 * irreversible and must never be taken on the strength of a write nobody
 * confirmed. See `platform/libs/event-bus/src/nats/message-disposition.ts`.
 */

/** Everything an operator needs to understand and replay a dropped message. */
export interface DeadLetterEnvelope {
  /** NATS subject the message was delivered on (`events.<tenant>.<type>`). */
  subject: string;
  /** Event type as decoded, or `'unparseable'` when the payload never decoded. */
  eventType: string;
  /** Event UUID when present — the replay handle. */
  eventId?: string;
  /** Tenant UUID when present; cross-tenant/system events carry none. */
  tenantId?: string;
  /** Decoded event, or `{ raw: '<string>' }` when decoding itself failed. */
  payload: Record<string, unknown>;
  /** Terminal error message from the last delivery attempt. */
  error: string;
  /** JetStream delivery attempts made before the message was given up on. */
  deliveryCount: number;
}

/**
 * Persists a permanently-undeliverable message. Implementations MUST be
 * durable (a DB row, not a log line) and MUST throw on failure so the caller
 * can keep the message in the broker instead of terminating it.
 */
export interface DeadLetterSink {
  record(entry: DeadLetterEnvelope): Promise<void>;
}

/** Nest DI token for {@link DeadLetterSink}. */
export const DEAD_LETTER_SINK = 'DEAD_LETTER_SINK';

/** Nest DI token for {@link DeadLetterSinkOptions}. */
export const DEAD_LETTER_SINK_OPTIONS = 'DEAD_LETTER_SINK_OPTIONS';

export interface DeadLetterSinkOptions {
  /**
   * Source schema owning this service's `event_dlq` table (`farm`, `alert`,
   * `notification`, …). Never a tenant schema — the shelf is cross-tenant so
   * an operator sees every tenant's failures in one query.
   */
  schema: string;
  /**
   * Consumer identity written to `event_dlq.source` — which service exhausted
   * its retries. Answers "who dropped it" without parsing the subject.
   */
  source: string;
}
