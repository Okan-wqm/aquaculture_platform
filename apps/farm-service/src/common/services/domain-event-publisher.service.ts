/**
 * DomainEventPublisher
 *
 * Enterprise-grade domain event publishing with consistent error handling.
 * All CQRS command handlers MUST use this service instead of raw EVENT_BUS
 * injection to guarantee uniform observability and graceful degradation.
 *
 * Design decisions:
 * - Event publish failures are non-fatal — the domain operation has already
 *   committed. Silently swallowing errors (empty catch) is NOT acceptable;
 *   every failure is logged with full context so on-call can detect missing
 *   events before downstream consumers notice data inconsistency.
 * - @Optional() allows unit tests and dev environments without NATS to run
 *   without wiring up an event bus.
 * - Structured log fields (eventType, tenantId, aggregateId) are designed
 *   for JSON log ingestion (Loki/OpenSearch) and Grafana alerting.
 *
 * @module Common/Services
 */
import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { NatsEventBus, IEvent } from '@platform/event-bus';

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
  private readonly logger = new Logger(DomainEventPublisher.name);

  constructor(
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  /**
   * Publish a domain event after a successful transaction commit.
   *
   * Never throws — event bus failures are logged at ERROR level and
   * swallowed so the caller's HTTP/GraphQL response is not affected.
   */
  async publish(
    event: IEvent & Record<string, unknown>,
    context: DomainEventContext,
  ): Promise<void> {
    if (!this.eventBus) return;

    try {
      await this.eventBus.publish(event);
    } catch (error) {
      // Non-fatal: domain operation succeeded but downstream consumers
      // will miss this event. Alert on this log in production monitoring.
      this.logger.error(
        `[${context.handler}] Failed to publish ${String(event['eventType'])} — ` +
        `aggregate ${context.aggregateId} in tenant ${context.tenantId}: ` +
        `${(error as Error).message}`,
        {
          handler: context.handler,
          eventType: event['eventType'],
          tenantId: context.tenantId,
          aggregateId: context.aggregateId,
          error: (error as Error).message,
          stack: (error as Error).stack,
        },
      );
    }
  }
}
