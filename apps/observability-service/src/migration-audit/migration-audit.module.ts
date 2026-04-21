import { Module } from '@nestjs/common';
import { CqrsModule } from '@platform/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MigrationEventEntity } from '../database/entities/migration-event.entity';
import { SchemaObjectHistoryEntity } from '../database/entities/schema-object-history.entity';
import { RecordMigrationEventHandler } from './handlers/record-migration-event.handler';
import { MigrationEventRepository } from './repositories/migration-event.repository';

/**
 * MigrationAuditModule — wires the CQRS command / handler / repository
 * for observability.migration_events (Phase 0 Step 3).
 *
 * SchemaObjectHistoryEntity is registered for future Phase 0+ handlers
 * (the boot-time reconciler that emits DDL-level rows lands in Phase 6).
 */
@Module({
  imports: [
    CqrsModule,
    TypeOrmModule.forFeature([MigrationEventEntity, SchemaObjectHistoryEntity]),
  ],
  providers: [MigrationEventRepository, RecordMigrationEventHandler],
  exports: [MigrationEventRepository],
})
export class MigrationAuditModule {}
