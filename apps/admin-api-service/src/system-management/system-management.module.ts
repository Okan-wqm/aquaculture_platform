import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import {
  GlobalSettingsController,
  PerformanceController,
  ErrorTrackingController,
  JobQueueController,
} from './controllers';
import {
  FeatureToggle,
  MaintenanceMode,
  SystemVersion,
  GlobalConfig,
  PerformanceMetric,
  PerformanceSnapshot,
  ErrorOccurrence,
  ErrorGroup,
  ErrorAlertRule,
  BackgroundJob,
  JobExecutionLog,
  JobQueue,
} from './entities';

// Services
import {
  GlobalSettingsService,
  PerformanceMonitoringService,
  ErrorTrackingService,
  JobQueueService,
} from './services';

// Controllers

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      // Global Settings
      FeatureToggle,
      MaintenanceMode,
      SystemVersion,
      GlobalConfig,
      // Performance
      PerformanceMetric,
      PerformanceSnapshot,
      // Error Tracking
      ErrorOccurrence,
      ErrorGroup,
      ErrorAlertRule,
      // Job Queue
      BackgroundJob,
      JobExecutionLog,
      JobQueue,
    ]),
  ],
  controllers: [
    GlobalSettingsController,
    PerformanceController,
    ErrorTrackingController,
    JobQueueController,
  ],
  providers: [
    GlobalSettingsService,
    PerformanceMonitoringService,
    ErrorTrackingService,
    JobQueueService,
  ],
  exports: [
    GlobalSettingsService,
    PerformanceMonitoringService,
    ErrorTrackingService,
    JobQueueService,
  ],
})
export class SystemManagementModule {}
