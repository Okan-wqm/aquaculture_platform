import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@platform/cqrs';

import type { MigrationEventSink, MigrationSinkEvent } from '@aquaculture/backend-common/database';

import { RecordMigrationEventCommand } from '../commands/record-migration-event.command';

/**
 * CqrsMigrationEventSink — production implementation of the
 * MigrationEventSink hook exposed by backend-common. Translates each
 * MigrationSinkEvent into a RecordMigrationEventCommand dispatched
 * on the CQRS bus, which the RecordMigrationEventHandler persists
 * into observability.migration_events.
 *
 * # Fire-and-forget semantics
 *
 * Sink contract: emit() MUST NOT throw or propagate rejections to
 * the runner. This class fully honours that — CommandBus.execute()
 * is awaited inside a guarded try/catch, and any failure is logged
 * via NestJS Logger without re-throwing. A broken observability
 * pipeline NEVER rolls back a deploy.
 *
 * # Scope
 *
 * Observability-service wires this sink into its own
 * MigrationRunnerService (observability schema migrations only).
 * Other services would need an event-bridge (NATS → observability
 * consumer) to avoid importing from this app. That's a Phase 6
 * follow-up, not this commit's scope.
 */
@Injectable()
export class CqrsMigrationEventSink implements MigrationEventSink {
  private readonly logger = new Logger(CqrsMigrationEventSink.name);

  constructor(private readonly commandBus: CommandBus) {}

  async emit(event: MigrationSinkEvent): Promise<void> {
    try {
      const cmd = new RecordMigrationEventCommand({
        serviceName: event.serviceName,
        migrationName: event.migrationName,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        ...(event.tenantSchema !== undefined
          ? { tenantSchema: event.tenantSchema }
          : {}),
        ...(event.durationMs !== undefined
          ? { durationMs: event.durationMs }
          : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      });
      await this.commandBus.execute(cmd);
    } catch (err) {
      // Sink failure MUST NOT propagate. Log + swallow.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `emit failed for ${event.serviceName}/${event.migrationName} ` +
          `[${event.eventType}]: ${msg}`,
      );
    }
  }
}
