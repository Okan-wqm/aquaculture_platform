import { Module } from '@nestjs/common';
import { CqrsModule } from '@platform/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MigrationEventEntity } from '../database/entities/migration-event.entity';
import { ExportObservabilityTenantDataHandler } from './handlers/export-observability-tenant-data.handler';

/**
 * GdprModule — observability-service DSAR access/portability surface.
 *
 * Registers one CommandHandler:
 *   - ExportObservabilityTenantDataHandler — exports tenant-scoped
 *     audit records for DSAR.
 *
 * Tenant erasure is owned by the canonical TenantErasureRequested roster
 * in @platform/event-contracts. Observability is intentionally not a target
 * service there; keeping a second CQRS erasure entrypoint would create an
 * untracked cascade outside the orchestrator proof ledger.
 */
@Module({
  imports: [CqrsModule, TypeOrmModule.forFeature([MigrationEventEntity])],
  providers: [ExportObservabilityTenantDataHandler],
})
export class GdprModule {}
