import type { DeadLetterEnvelope, DeadLetterSink } from '@aquaculture/backend-common/events';

export interface AckableMessage {
  nak(millis?: number): void;
  term(): void;
}

export interface DispositionLogger {
  error(message: string, context?: unknown): void;
}

export const DEFAULT_CONSUMER_MAX_DELIVER = 3;

export function redeliveryBackoffMs(deliveryCount: number): number {
  const safeCount = Number.isSafeInteger(deliveryCount) && deliveryCount >= 0 ? deliveryCount : 0;
  return Math.min(1000 * Math.pow(2, safeCount), 30_000);
}

export type MessageDisposition = 'retry' | 'dead-lettered' | 'retry-no-sink' | 'retry-sink-failed';

export interface SettleFailedMessageParams {
  readonly msg: AckableMessage;
  readonly error: string;
  readonly envelope: DeadLetterEnvelope;
  readonly maxDeliver: number | undefined;
  readonly sink: DeadLetterSink | undefined;
  readonly logger: DispositionLogger;
}

/**
 * The single retry/retirement state transition for inbound messages.
 * A successful durable shelf write is the only condition that permits the
 * irreversible JetStream `term()` action.
 */
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
        `(${envelope.deliveryCount}/${String(maxDeliver)}) without a durable dead-letter sink; ` +
        'register DeadLetterModule before consuming one-shot events',
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
      `Dead-letter write failed for ${envelope.eventType} on ${envelope.subject}; ` +
        'the message was not terminated',
      sinkError,
    );
    msg.nak(redeliveryBackoffMs(envelope.deliveryCount));
    return 'retry-sink-failed';
  }
}
