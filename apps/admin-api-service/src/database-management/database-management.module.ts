/**
 * Database Management Module
 *
 * Multi-tenant database schema, migration, backup ve monitoring yönetimi.
 */

import { SchemaManagerService } from '@aquaculture/backend-common/database';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit/audit.module';
import { BackupController } from './controllers/backup.controller';
import { DatabaseExplorerController } from './controllers/explorer.controller';
import { MigrationController } from './controllers/migration.controller';
import { MonitoringController } from './controllers/monitoring.controller';
import { SchemaController } from './controllers/schema.controller';
import {
  TenantSchema,
  SchemaMigration,
  SchemaBackup,
  RetiredSchemaBackup,
  SchemaRestore,
  DatabaseMetric,
  SlowQueryLog,
} from './entities/database-management.entity';
import { BackupRestoreService } from './services/backup-restore.service';
import { DatabaseMonitoringService } from './services/database-monitoring.service';
import { MigrationManagementService } from './services/migration-management.service';
import { SchemaManagementService } from './services/schema-management.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TenantSchema,
      SchemaMigration,
      SchemaBackup,
      RetiredSchemaBackup,
      SchemaRestore,
      DatabaseMetric,
      SlowQueryLog,
    ]),
    ScheduleModule,
    // AuditModule: enables AuditLogService injection in schema, migration, and
    // backup services. Without this, destructive schema operations, migrations,
    // and restores produce zero entries in the central audit log.
    AuditLogModule,
  ],
  controllers: [
    SchemaController,
    MigrationController,
    BackupController,
    MonitoringController,
    DatabaseExplorerController,
  ],
  providers: [
    SchemaManagerService,
    SchemaManagementService,
    MigrationManagementService,
    BackupRestoreService,
    DatabaseMonitoringService,
  ],
  exports: [
    SchemaManagementService,
    MigrationManagementService,
    BackupRestoreService,
    DatabaseMonitoringService,
  ],
})
export class DatabaseManagementModule {}
