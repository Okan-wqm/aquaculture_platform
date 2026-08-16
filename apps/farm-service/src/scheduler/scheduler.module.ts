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

// Modules
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { FileCleanupModule } from '../common/file-cleanup/file-cleanup.module';

// Services
import { CronJobsService } from './cron-jobs.service';

@Module({
  imports: [
    // NestJS Schedule module — forRoot() is in AppModule, plain import here
    ScheduleModule,
    // Import MaintenanceModule to access MaintenanceScheduleService and SparePartService
    MaintenanceModule,
    // Phase 6.2.3 — MinIO orphan cleanup cron
    FileCleanupModule,
  ],
  providers: [CronJobsService],
  exports: [CronJobsService],
})
export class SchedulerModule {}
