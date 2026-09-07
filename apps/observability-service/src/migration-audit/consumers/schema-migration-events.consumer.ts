import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CommandBus } from '@platform/cqrs';
import { NatsEventBus, HandlerOutcome, outcomeForError } from '@platform/event-bus';
import { SCHEMA_MIGRATION_SUBJECT_PREFIX } from '@platform/event-contracts';
import type {
  SchemaMigrationAppliedEvent,
  SchemaMigrationEvent,
  SchemaMigrationFailedEvent,
  SchemaMigrationSkippedEvent,
  SchemaMigrationStartedEvent,
} from '@platform/event-contracts';

import { RecordMigrationEventCommand } from '../commands/record-migration-event.command';

// ORPHAN-MEDIUM-326: derived from the SAME constant the publisher
// (NatsMigrationEventSink) uses — publisher and consumer cannot drift.
const SUBSCRIBE_SUBJECT = `${SCHEMA_MIGRATION_SUBJECT_PREFIX}.>`;
const GROUP_ID = 'observability-schema-migration';

/**
 * SchemaMigrationEventsConsumer — Phase 6 Step 6 NATS subscriber.
 * ============================================================================
 *
 * Subscribes to `events.platform.schema-migration.>` on NATS. Every published
 * SchemaMigrationEvent (started / applied / failed / skipped) translates
 * into a RecordMigrationEventCommand dispatched via the CQRS bus.
 *
 * # Why consumer-side translation?
 *
 * The wire contract carries sanitized fields (sqlState + template +
 * constraintName + relation for failed events — no raw errors).
 * The consumer passes them into RecordMigrationEventCommand.errorDetail
 * (pre-sanitized path, handler persists verbatim). This prevents a
 * double-sanitization round-trip on the hot path.
 *
 * # tenantId → tenantSchema mapping
 *
 * Wire eventId.tenantId is EITHER the GLOBAL_TENANT_UUID (platform
 * event) OR a cleartext tenant_<uuid16> (fan-out event). The
 * consumer forwards tenantSchema verbatim when it looks like a
 * tenant schema; otherwise omits it (platform-level event). The
 * handler HMACs tenant_<uuid16> before persist per ADR-022.
 *
 * # Failure semantics
 *
 * Consumer catches ALL exceptions from CommandBus.execute to avoid
 * NATS redelivery storms on transient handler failures. Errors are
 * logged; the message is ack'd so the subscription doesn't stall.
 * Durable subscription with groupId='observability-schema-migration'
 * ensures at-least-once delivery across observability restarts.
 */
@Injectable()
export class SchemaMigrationEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchemaMigrationEventsConsumer.name);

  constructor(
    private readonly eventBus: NatsEventBus,
    private readonly commandBus: CommandBus,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.eventBus.subscribeTo(
        SUBSCRIBE_SUBJECT,
        {
          handle: async (event): Promise<HandlerOutcome> =>
            this.handle(event as SchemaMigrationEvent),
          getEventType: () => `${SCHEMA_MIGRATION_SUBJECT_PREFIX}.>`,
        },
        {
          durable: true,
          groupId: GROUP_ID,
          startFrom: 'latest',
        },
      );
      this.logger.log(`Subscribed to ${SUBSCRIBE_SUBJECT} (groupId=${GROUP_ID})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to subscribe to ${SUBSCRIBE_SUBJECT}: ${msg}. ` +
          'Schema-migration audit consumption will be unavailable until NATS reconnects.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.eventBus.unsubscribeFrom(SUBSCRIBE_SUBJECT);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Unsubscribe from ${SUBSCRIBE_SUBJECT} failed: ${msg}`);
    }
  }

  private async handle(event: SchemaMigrationEvent): Promise<HandlerOutcome> {
    try {
      const cmd = this.toCommand(event);
      await this.commandBus.execute(cmd);
      return HandlerOutcome.ack();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to persist ${event.eventType} for ` +
          `${event.serviceName}/${event.migrationName}: ${msg}`,
      );
      // PLAT-HIGH-902: an audit row that failed to persist is retried within
      // the delivery budget (a DB blip) or dead-lettered (a malformed event) —
      // never silently acknowledged.
      return outcomeForError(`${event.eventType} audit persist`, err);
    }
  }

  private toCommand(event: SchemaMigrationEvent): RecordMigrationEventCommand {
    const common = {
      serviceName: event.serviceName,
      migrationName: event.migrationName,
      occurredAt: new Date(event.timestamp),
      environment: event.environment,
      ...(this.isTenantSchema(event.tenantId) ? { tenantSchema: event.tenantId } : {}),
    };

    switch (event.eventType) {
      case 'SchemaMigrationStarted': {
        const _typed: SchemaMigrationStartedEvent = event;
        return new RecordMigrationEventCommand({
          ...common,
          eventType: 'start',
        });
      }
      case 'SchemaMigrationApplied': {
        const ev: SchemaMigrationAppliedEvent = event;
        return new RecordMigrationEventCommand({
          ...common,
          eventType: 'applied',
          durationMs: ev.durationMs,
        });
      }
      case 'SchemaMigrationFailed': {
        const ev: SchemaMigrationFailedEvent = event;
        return new RecordMigrationEventCommand({
          ...common,
          eventType: 'failed',
          durationMs: ev.durationMs,
          errorDetail: {
            sqlState: ev.sqlState,
            template: ev.errorTemplate,
            constraintName: ev.constraintName,
            relation: ev.relation,
          },
        });
      }
      case 'SchemaMigrationSkipped': {
        const _typed: SchemaMigrationSkippedEvent = event;
        return new RecordMigrationEventCommand({
          ...common,
          eventType: 'skipped',
        });
      }
    }
  }

  private isTenantSchema(id: string | undefined): id is string {
    if (!id) return false;
    return /^tenant_[a-f0-9]{16}$/.test(id);
  }
}
