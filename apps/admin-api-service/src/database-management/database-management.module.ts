/**
 * Database Management Module
 *
 * Multi-tenant database schema, migration ve monitoring yönetimi.
 */

import { SchemaManagerService } from '@aquaculture/backend-common/database';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit/audit.module';
import { DatabaseExplorerController } from './controllers/explorer.controller';
import { MigrationController } from './controllers/migration.controller';
import { MonitoringController } from './controllers/monitoring.controller';
import { SchemaController } from './controllers/schema.controller';
import {
  TenantSchema,
  SchemaMigration,
  DatabaseMetric,
  SlowQueryLog,
} from './entities/database-management.entity';
import { DatabaseMonitoringService } from './services/database-monitoring.service';
import { MigrationManagementService } from './services/migration-management.service';
import { SchemaManagementService } from './services/schema-management.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TenantSchema, SchemaMigration, DatabaseMetric, SlowQueryLog]),
    ScheduleModule,
    // AuditModule enables mandatory audit persistence for schema and migration
    // operations. Backup and recovery are deliberately outside this runtime.
    AuditLogModule,
  ],
  controllers: [
    SchemaController,
    MigrationController,
    MonitoringController,
    DatabaseExplorerController,
  ],
  providers: [
    SchemaManagerService,
    SchemaManagementService,
    MigrationManagementService,
    DatabaseMonitoringService,
  ],
  exports: [SchemaManagementService, MigrationManagementService, DatabaseMonitoringService],
})
export class DatabaseManagementModule {}
