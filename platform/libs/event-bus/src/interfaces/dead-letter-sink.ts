import { Logger } from '@nestjs/common';

import type { IEvent } from './event-bus.interface';

/**
 * Where the bus records a message it will never deliver again
 * (PLAT-HIGH-902).
 *
 * A terminated message — a handler said `terminate`, or its retry budget is
 * spent — is `msg.term()`ed on JetStream and disappears from the stream's
 * consumer. Without a sink that is silent data loss; with one, every such
 * message leaves a durable, replayable trace the operator can act on.
 *
 * The bus injects the sink through `EVENT_DEAD_LETTER_SINK`. A service that
 * owns a durable store binds its own (notification-service writes a
 * NotificationLog row); everything else gets `LoggingDeadLetterSink`, which
 * emits a structured error line — visible, never silent.
 */
export interface DeadLetterRecord {
  readonly subject: string;
  readonly event: IEvent;
  readonly reason: string;
  /** `retry-exhausted` when the budget ran out; `terminated` when a handler decided. */
  readonly disposition: 'terminated' | 'retry-exhausted';
  readonly deliveryCount: number;
  readonly maxDeliver: number;
  readonly cause?: unknown;
  readonly terminatedAt: string;
}

export interface IDeadLetterSink {
  record(record: DeadLetterRecord): Promise<void>;
}

export const EVENT_DEAD_LETTER_SINK = 'EVENT_DEAD_LETTER_SINK';

function describeCause(cause: unknown): string | undefined {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'string') {
    return cause;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return '[unserializable cause]';
  }
}

/** Default sink: a structured error line per dead-lettered message. */
export class LoggingDeadLetterSink implements IDeadLetterSink {
  private readonly logger = new Logger(LoggingDeadLetterSink.name);

  record(record: DeadLetterRecord): Promise<void> {
    this.logger.error(
      JSON.stringify({
        event: 'event_bus_dead_letter',
        subject: record.subject,
        eventType: record.event.eventType,
        eventId: record.event.eventId,
        tenantId: record.event.tenantId,
        disposition: record.disposition,
        reason: record.reason,
        deliveryCount: record.deliveryCount,
        maxDeliver: record.maxDeliver,
        cause: describeCause(record.cause),
        terminatedAt: record.terminatedAt,
      }),
    );
    return Promise.resolve();
  }
}
