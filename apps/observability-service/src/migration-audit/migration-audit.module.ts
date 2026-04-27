import { Module } from '@nestjs/common';
import { CqrsModule } from '@platform/cqrs';
import { EventBusModule } from '@platform/event-bus';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MigrationBackfillProgressEntity } from '../database/entities/migration-backfill-progress.entity';
import { MigrationEventEntity } from '../database/entities/migration-event.entity';
import { SchemaObjectHistoryEntity } from '../database/entities/schema-object-history.entity';
import { SchemaMigrationEventsConsumer } from './consumers/schema-migration-events.consumer';
import { RecordMigrationEventHandler } from './handlers/record-migration-event.handler';
import { MigrationEventRepository } from './repositories/migration-event.repository';
import { CqrsMigrationEventSink } from './sinks/cqrs-migration-event-sink';

/**
 * MigrationAuditModule — wires the CQRS command / handler / repository
 * for observability.migration_events (Phase 0 Step 3) + the
 * CqrsMigrationEventSink adapter (Phase 6 Step 3) that translates
 * MigrationRunnerService lifecycle events into RecordMigrationEventCommand
 * dispatches.
 *
 * # Why EventBusModule.forRoot() is imported here
 *
 * SchemaMigrationEventsConsumer (Phase 6 Step 6) depends on NatsEventBus
 * via constructor injection. Nest's DI resolves NatsEventBus from the
 * first module in the import graph that provides it — in the
 * observability-service, that's EventBusModule.forRoot(). Without this
 * import, container boot fails with:
 *
 *   Nest can't resolve dependencies of the SchemaMigrationEventsConsumer
 *   (?, CommandBus). Please make sure that the argument NatsEventBus at
 *   index [0] is available in the MigrationAuditModule context.
 *
 * → restart loop → "Schema drift scan clean" signal never emits →
 *   boot-signal assertion times out → deploy rolls back.
 *
 * Architectural invariant: every module that registers a NatsEventBus-
 * consuming provider MUST import EventBusModule.forRoot() in its own
 * `imports` list. The SecurityEventsModule in the same service follows
 * the exact same pattern; this module now mirrors that contract.
 *
 * Retention enforcement for migration_events + schema_object_history +
 * emergency_overrides moved OUT of this module. The per-table
 * MigrationEventsRetentionService was retired in favour of the generic
 * RetentionEnforcementService (backend-common) driven by the
 * RetentionPolicyRegistry. See RetentionBootstrapModule.
 *
 * SchemaObjectHistoryEntity is registered for future handlers (the
 * boot-time reconciler that emits DDL-level rows lands in a Phase 6
 * follow-up).
 */
@Module({
  imports: [
    CqrsModule,
    // Provides NatsEventBus → SchemaMigrationEventsConsumer +
    // CqrsMigrationEventSink (via CommandBus alongside). Matches the
    // pattern SecurityEventsModule uses in the same service.
    EventBusModule.forRoot(),
    TypeOrmModule.forFeature([
      MigrationEventEntity,
      SchemaObjectHistoryEntity,
      MigrationBackfillProgressEntity,
    ]),
  ],
  providers: [
    MigrationEventRepository,
    RecordMigrationEventHandler,
    CqrsMigrationEventSink,
    SchemaMigrationEventsConsumer,
  ],
  exports: [MigrationEventRepository, CqrsMigrationEventSink],
})
export class MigrationAuditModule {}
