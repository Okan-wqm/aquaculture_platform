/**
 * Durable inbound-delivery shelf contract.
 *
 * Outbound durability is owned by the transactional outbox. This contract is
 * the matching inbound boundary: a JetStream message may be terminated only
 * after a service-owned durable sink confirms that it recorded the payload.
 */
export interface DeadLetterEnvelope {
  readonly subject: string;
  readonly eventType: string;
  readonly eventId?: string;
  readonly tenantId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly error: string;
  readonly deliveryCount: number;
}

export interface DeadLetterSink {
  /** Must reject when durability cannot be confirmed. */
  record(entry: DeadLetterEnvelope): Promise<void>;
}

export const DEAD_LETTER_SINK = 'DEAD_LETTER_SINK';
export const DEAD_LETTER_SINK_OPTIONS = 'DEAD_LETTER_SINK_OPTIONS';

export interface DeadLetterSinkOptions {
  /** Service-owned source schema; never derived from a message. */
  readonly schema: string;
  /** Stable consumer/service identity persisted with the failure. */
  readonly source: string;
}
