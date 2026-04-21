import { Module } from '@nestjs/common';
import { CqrsModule } from '@platform/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

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
    TypeOrmModule.forFeature([MigrationEventEntity, SchemaObjectHistoryEntity]),
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
