/**
 * DLQ envelope contract (plan Task 1 Step 1.6).
 *
 * When a JetStream message exhausts its bounded redelivery budget, the
 * event-bus moves it to the AQUACULTURE_DLQ stream as this envelope BEFORE
 * acking the original — PubAck on the DLQ copy is the release condition, so
 * a failure in the dead-letter hop itself NAKs (never ack-and-lose).
 *
 * Subject layout: `dlq.<tenantId>.<eventType>` (tenant-scoped, matching the
 * platform subject grammar). An event whose tenant cannot be determined
 * lands in `dlq.quarantine.<eventType>` instead — it is never dropped.
 */
export interface DlqEnvelope {
  tenantId?: string;
  originalStream: string;
  originalSubject: string;
  originalSequence?: number;
  sourceEventId?: string;
  payloadBase64: string;
  failureClass: string;
  errorDigest: string;
  deliveryCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
}

/** Bounded error fingerprint — enough to diagnose, never the full payload. */
function digest(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

export function dlqSubjectFor(tenantId: string | undefined, eventType: string): string {
  const safeType = eventType.replace(/[^a-zA-Z0-9_-]/g, '') || 'Unknown';
  return tenantId ? `dlq.${tenantId}.${safeType}` : `dlq.quarantine.${safeType}`;
}

export function buildDlqEnvelope(input: {
  tenantId?: string;
  eventType?: string;
  eventId?: string;
  originalStream: string;
  originalSubject: string;
  originalSequence?: number;
  payload: string;
  failureClass: string;
  error: unknown;
  deliveryCount: number;
}): { subject: string; envelope: DlqEnvelope } {
  const now = new Date().toISOString();
  return {
    subject: dlqSubjectFor(input.tenantId, input.eventType ?? 'Unknown'),
    envelope: {
      tenantId: input.tenantId,
      originalStream: input.originalStream,
      originalSubject: input.originalSubject,
      originalSequence: input.originalSequence,
      sourceEventId: input.eventId,
      payloadBase64: Buffer.from(input.payload, 'utf8').toString('base64'),
      failureClass: input.failureClass,
      errorDigest: digest(input.error),
      deliveryCount: input.deliveryCount,
      firstFailedAt: now,
      lastFailedAt: now,
    },
  };
}
