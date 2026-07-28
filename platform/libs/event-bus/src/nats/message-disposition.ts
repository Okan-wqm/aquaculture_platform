/**
 * Failed-message disposition (W7 — FARM-MEDIUM-260).
 *
 * Extracted from `NatsEventBus.processConsumerMessage` because it is the only
 * genuinely non-obvious decision on the inbound path — "retry again" vs "give
 * up permanently" — and getting the ORDER wrong silently loses events. As a
 * standalone function it is directly testable against a plain object, with no
 * broker, no Nest container, and no reaching into the bus's privates.
 *
 * The rule, in the order that matters:
 *
 *   1. Retries left → NAK with exponential backoff.
 *   2. Retries exhausted → write the dead-letter shelf FIRST, and only a
 *      SUCCESSFUL write earns `term()`.
 *   3. Shelf write failed, or no shelf registered → NAK, never `term()`.
 *
 * ## Why `term()` is reserved for a successful shelf write
 *
 * Be precise about what NAK buys on the final attempt: once `deliveryCount`
 * has reached `max_deliver`, JetStream will not redeliver whether we NAK or
 * `term()`. NAK is NOT a save. What differs is reversibility and evidence:
 *
 *   - `term()` is irreversible. A terminated message can never be redelivered,
 *     not by raising `max_deliver`, not by recreating the consumer. It is the
 *     right call exactly once — when the payload is already durable on the
 *     shelf and continuing to occupy redelivery slots buys nothing.
 *   - NAK leaves the message in the stream's normal accounting, so the
 *     consumer's `num_redelivered` / `num_ack_pending` keep rising and the
 *     operator alerting in `docs/runbooks/feeding-event-stream-scale.md` fires.
 *     Terminating a message we failed to record would erase both the payload
 *     AND the signal that anything went wrong.
 *
 * So the invariant is not "NAK saves it" — it is "we never take the
 * irreversible action on the strength of a write we could not confirm".
 */
import type { DeadLetterEnvelope, DeadLetterSink } from '@aquaculture/backend-common/events';

/**
 * The ack surface this module needs. Narrower than JetStream's `JsMsg` on
 * purpose: the disposition decision has no business reading the payload, and
 * the narrow shape is what lets a test pass a plain object.
 */
export interface AckableMessage {
  nak(millis?: number): void;
  term(): void;
}

/** Minimal logging surface (Nest's `Logger` satisfies it structurally). */
export interface DispositionLogger {
  error(message: string, context?: unknown): void;
}

/** Backoff doubles per attempt, capped at 30 s. */
export function redeliveryBackoffMs(deliveryCount: number): number {
  return Math.min(1000 * Math.pow(2, deliveryCount), 30000);
}

export interface SettleFailedMessageParams {
  msg: AckableMessage;
  /** Terminal error from the last delivery attempt (already stringified). */
  error: string;
  /** Everything the shelf needs; `deliveryCount` doubles as the retry counter. */
  envelope: DeadLetterEnvelope;
  /**
   * `max_deliver` configured for this subject's consumer. `undefined` means the
   * bus never recorded one (a subject it does not own) — treated as "retries
   * remain", because guessing that this was the last attempt could terminate a
   * message that JetStream would happily have redelivered.
   */
  maxDeliver: number | undefined;
  sink: DeadLetterSink | undefined;
  logger: DispositionLogger;
}

/** What actually happened — returned so callers/tests can assert the branch. */
export type MessageDisposition = 'retry' | 'dead-lettered' | 'retry-no-sink' | 'retry-sink-failed';

export async function settleFailedMessage(
  params: SettleFailedMessageParams,
): Promise<MessageDisposition> {
  const { msg, error, envelope, maxDeliver, sink, logger } = params;
  const exhausted = maxDeliver !== undefined && envelope.deliveryCount >= maxDeliver;

  if (!exhausted) {
    msg.nak(redeliveryBackoffMs(envelope.deliveryCount));
    return 'retry';
  }

  if (!sink) {
    logger.error(
      `Delivery attempts exhausted for ${envelope.eventType} on ${envelope.subject} ` +
        `(${envelope.deliveryCount}/${String(maxDeliver)}) and NO dead-letter sink is ` +
        'registered — the broker WILL drop this message and it is not recoverable. ' +
        'Register DeadLetterModule in this service.',
    );
    msg.nak(redeliveryBackoffMs(envelope.deliveryCount));
    return 'retry-no-sink';
  }

  try {
    await sink.record({ ...envelope, error });
    msg.term();
    return 'dead-lettered';
  } catch (sinkError) {
    logger.error(
      `Dead-letter write FAILED for ${envelope.eventType} on ${envelope.subject}; ` +
        'keeping the message in JetStream rather than terminating it',
      sinkError,
    );
    msg.nak(redeliveryBackoffMs(envelope.deliveryCount));
    return 'retry-sink-failed';
  }
}
