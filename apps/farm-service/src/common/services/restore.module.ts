/**
 * RestoreModule
 *
 * Provides the RestoreService as a re-usable cross-cutting
 * dependency. Each domain module that exposes a soft-delete-restore
 * mutation imports this module. AuditLogService is sourced from the
 * @Global DatabaseModule so no additional wiring is needed.
 */
import { Module } from '@nestjs/common';
import { RestoreService } from './restore.service';

@Module({
  providers: [RestoreService],
  exports: [RestoreService],
})
export class RestoreModule {}
