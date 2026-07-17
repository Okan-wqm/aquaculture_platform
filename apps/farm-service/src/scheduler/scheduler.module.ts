/**
 * Scheduler Module
 *
 * NestJS module for scheduled tasks (cron jobs).
 * Handles maintenance schedules, feeding plans, alerts, and reports.
 *
 * @module Scheduler
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

// Modules
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { FileCleanupModule } from '../common/file-cleanup/file-cleanup.module';

// Feeding Entities
import { FeedingRecord } from '../feeding/entities/feeding-record.entity';
import { FeedingTable } from '../feeding/entities/feeding-table.entity';
import { StorageInventory } from '../storage/entities/storage-inventory.entity';

// Related Entities
import { Batch } from '../batch/entities/batch.entity';
import { Feed } from '../feed/entities/feed.entity';

// Services
import { CronJobsService } from './cron-jobs.service';
import { FeedingSchedulerService } from './feeding-scheduler.service';

@Module({
  imports: [
    // NestJS Schedule module — forRoot() is in AppModule, plain import here
    ScheduleModule,
    // Import MaintenanceModule to access MaintenanceScheduleService and SparePartService
    MaintenanceModule,
    // Phase 6.2.3 — MinIO orphan cleanup cron
    FileCleanupModule,
    // TypeORM repositories
    TypeOrmModule.forFeature([
      // Feeding entities
      FeedingRecord,
      FeedingTable,
      Feed,
      StorageInventory,
      // Related entities
      Batch,
    ]),
  ],
  providers: [
    CronJobsService,
    FeedingSchedulerService,
  ],
  exports: [
    CronJobsService,
    FeedingSchedulerService,
  ],
})
export class SchedulerModule {}
