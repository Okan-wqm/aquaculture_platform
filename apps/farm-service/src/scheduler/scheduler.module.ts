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

// Entities
import { WorkOrder } from '../maintenance/entities/work-order.entity';
import { MaintenanceSchedule } from '../maintenance/entities/maintenance-schedule.entity';
import { SparePart } from '../maintenance/entities/spare-part.entity';

// Services
import { CronJobsService } from './cron-jobs.service';
import { FeedingSchedulerService } from './feeding-scheduler.service';
import { MaintenanceScheduleService } from '../maintenance/services/maintenance-schedule.service';
import { SparePartService } from '../maintenance/services/spare-part.service';

@Module({
  imports: [
    // NestJS Schedule module for cron jobs
    ScheduleModule.forRoot(),
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
    // TypeORM repositories
    TypeOrmModule.forFeature([
      WorkOrder,
      MaintenanceSchedule,
      SparePart,
    ]),
  ],
  providers: [
    CronJobsService,
    FeedingSchedulerService,
    MaintenanceScheduleService,
    SparePartService,
  ],
  exports: [
    CronJobsService,
    FeedingSchedulerService,
  ],
})
export class SchedulerModule {}
