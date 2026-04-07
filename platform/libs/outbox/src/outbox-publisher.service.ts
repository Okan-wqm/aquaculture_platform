import { Injectable, Inject, Logger, Type } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type { BaseEvent } from '@platform/event-contracts';
import { OutboxEntityBase } from './outbox-entity.base';
import { OUTBOX_ENTITY_CLASS } from './constants';

/**
 * OutboxPublisher
 *
 * The transactional outbox publisher API. Command handlers call
 * `enqueue(event, manager)` from inside an active transaction so the
 * outbox INSERT participates in the same DB transaction as the domain
 * write. Either both commit or neither — at-least-once delivery.
 *
 * IMPORTANT: This service NEVER touches NATS. Worker (OutboxWorkerService)
 * polls the table and handles the actual publish. Decoupling the write
 * path from the network ensures the user-facing request never blocks on
 * NATS availability.
 *
 * Hard-fail boundary: the constructor injection has NO `@Optional()`.
 * If the consuming service has not registered an outbox entity via
 * `OutboxModule.forFeature(...)`, NestJS will throw at startup — not at
 * the moment a user records mortality.
 *
 * @see Phase 2 of farm domain real-time visibility plan.
 */
@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    @Inject(OUTBOX_ENTITY_CLASS)
    private readonly entityClass: Type<OutboxEntityBase>,
  ) {}

  /**
   * Enqueue a domain event for at-least-once delivery via NATS.
   *
   * MUST be called inside an active transaction. Pass the same
   * `EntityManager` (`queryRunner.manager`) the handler is using for
   * domain writes — the outbox INSERT joins that transaction.
   *
   * Validates that `eventType` and `tenantId` are present. Multi-tenant
   * isolation depends on `tenantId` being set at the BaseEvent level so
   * downstream consumers (e.g. WebSocket gateway) can route events to
   * the correct tenant room.
   *
   * @throws Error if eventType or tenantId is missing
   */
  async enqueue(event: BaseEvent, manager: EntityManager): Promise<void> {
    if (!event.eventType) {
      throw new Error(
        'OutboxPublisher.enqueue: event.eventType is required (got empty string)',
      );
    }
    if (!event.tenantId) {
      throw new Error(
        `OutboxPublisher.enqueue: event.tenantId is required (event: ${event.eventType})`,
      );
    }

    // Spread into a fresh object so TypeORM does not pollute the caller's
    // event reference with row metadata. The cast is structurally safe
    // because BaseEvent has only string keys with serializable values.
    const payload: Record<string, unknown> = { ...event };

    await manager.save(this.entityClass, {
      eventType: event.eventType,
      payload,
      retryCount: 0,
      publishedAt: null,
      lastError: null,
    });

    this.logger.debug(
      `Enqueued ${event.eventType} for tenant ${event.tenantId} (eventId: ${event.eventId})`,
    );
  }
}
