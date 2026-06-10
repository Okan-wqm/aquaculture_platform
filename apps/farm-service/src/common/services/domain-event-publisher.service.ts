/**
 * DomainEventPublisher
 *
 * Deprecated compatibility surface.
 *
 * Farm business events must be enqueued through the transactional outbox in
 * the same tenant transaction as the write. This service remains only to keep
 * old imports compiling while fail-fast preventing raw event bus publication.
 *
 * @module Common/Services
 */
import { Injectable } from '@nestjs/common';
import { IEvent } from '@platform/event-bus';

export interface DomainEventContext {
  /** Name of the calling handler — for log correlation */
  handler: string;
  /** Tenant that owns the aggregate */
  tenantId: string;
  /** Primary aggregate ID (batchId, deviceId, etc.) */
  aggregateId: string;
}

@Injectable()
export class DomainEventPublisher {
  publish(
    event: IEvent & Record<string, unknown>,
    context: DomainEventContext,
  ): Promise<void> {
    throw new Error(
      `[${context.handler}] Direct domain event publish is disabled for ${String(
        event['eventType'],
      )}; use the transactional farm outbox for tenant ${context.tenantId}`,
    );
  }
}
