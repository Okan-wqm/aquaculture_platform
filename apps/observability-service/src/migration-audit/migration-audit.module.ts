import { Module } from '@nestjs/common';
import { CqrsModule } from '@platform/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MigrationEventEntity } from '../database/entities/migration-event.entity';
import { SchemaObjectHistoryEntity } from '../database/entities/schema-object-history.entity';
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
  ],
  exports: [MigrationEventRepository, CqrsMigrationEventSink],
})
export class MigrationAuditModule {}
