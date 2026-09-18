/**
 * Database Management Module
 *
 * Multi-tenant database schema, migration ve monitoring yönetimi. Backups are
 * WAL-G's (ADR-0009); this module only captures the recovery point a schema
 * drop must carry.
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
import { WalgRecoveryPointService } from './services/recovery-point.service';
import { DatabaseMonitoringService } from './services/database-monitoring.service';
import { MigrationManagementService } from './services/migration-management.service';
import { SchemaManagementService } from './services/schema-management.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TenantSchema, SchemaMigration, DatabaseMetric, SlowQueryLog]),
    ScheduleModule,
    // AuditModule: enables AuditLogService injection in schema and migration
    // services. Without this, destructive schema operations and migrations
    // produce zero entries in the central audit log.
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
    WalgRecoveryPointService,
    DatabaseMonitoringService,
  ],
  exports: [
    SchemaManagementService,
    MigrationManagementService,
    WalgRecoveryPointService,
    DatabaseMonitoringService,
  ],
})
export class DatabaseManagementModule {}
