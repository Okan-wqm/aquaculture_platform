/**
 * Database Management Module
 *
 * Multi-tenant database schema, migration, backup ve monitoring yönetimi.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
import {
  TenantSchema,
  SchemaMigration,
  SchemaBackup,
  SchemaRestore,
  DatabaseMetric,
  SlowQueryLog,
} from './entities/database-management.entity';

// Services
import { SchemaManagementService } from './services/schema-management.service';
import { MigrationManagementService } from './services/migration-management.service';
import { BackupRestoreService } from './services/backup-restore.service';
import { DatabaseMonitoringService } from './services/database-monitoring.service';

// Controllers
import { SchemaController } from './controllers/schema.controller';
import { MigrationController } from './controllers/migration.controller';
import { BackupController } from './controllers/backup.controller';
import { MonitoringController } from './controllers/monitoring.controller';
import { DatabaseExplorerController } from './controllers/explorer.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TenantSchema,
      SchemaMigration,
      SchemaBackup,
      SchemaRestore,
      DatabaseMetric,
      SlowQueryLog,
    ]),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    SchemaController,
    MigrationController,
    BackupController,
    MonitoringController,
    DatabaseExplorerController,
  ],
  providers: [
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
