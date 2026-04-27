import { Module } from '@nestjs/common';
import { CqrsModule } from '@platform/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MigrationEventEntity } from '../database/entities/migration-event.entity';
import { EraseObservabilityTenantDataHandler } from './handlers/erase-observability-tenant-data.handler';
import { ExportObservabilityTenantDataHandler } from './handlers/export-observability-tenant-data.handler';

/**
 * GdprModule — observability-service consumer of the platform GDPR
 * cascade (Art 17 erasure + Art 15/20 access/portability).
 *
 * Registers two CommandHandlers:
 *   - EraseObservabilityTenantDataHandler — deletes tenant-scoped
 *     migration_events rows identified by HMAC hash.
 *   - ExportObservabilityTenantDataHandler — exports tenant-scoped
 *     audit records for DSAR.
 *
 * The platform orchestrator (apps/admin-api-service or the compliance
 * service, per plan v3 Phase 9) dispatches these commands via the
 * CQRS bus. Observability is the 11th service in the erasure cascade
 * roster (see plan v3 §R19).
 */
@Module({
  imports: [CqrsModule, TypeOrmModule.forFeature([MigrationEventEntity])],
  providers: [
    EraseObservabilityTenantDataHandler,
    ExportObservabilityTenantDataHandler,
  ],
})
export class GdprModule {}
