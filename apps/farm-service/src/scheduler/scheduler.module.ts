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
import { EventEmitterModule } from '@nestjs/event-emitter';

// Modules
import { MaintenanceModule } from '../maintenance/maintenance.module';

// Feeding Entities
import { FeedingRecord } from '../feeding/entities/feeding-record.entity';
import { FeedingTable } from '../feeding/entities/feeding-table.entity';
import { FeedInventory } from '../feeding/entities/feed-inventory.entity';

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
    // Event Emitter for async event handling
    EventEmitterModule.forRoot({
      // Use wildcards for event patterns
      wildcard: true,
      // Delimiter for namespaced events
      delimiter: '.',
      // Don't throw on error
      ignoreErrors: false,
      // Max listeners per event
      maxListeners: 10,
    }),
    // Import MaintenanceModule to access MaintenanceScheduleService and SparePartService
    MaintenanceModule,
    // TypeORM repositories
    TypeOrmModule.forFeature([
      // Feeding entities
      FeedingRecord,
      FeedingTable,
      FeedInventory,
      // Related entities
      Batch,
      Feed,
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
