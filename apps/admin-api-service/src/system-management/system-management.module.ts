import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
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
import {
  GlobalSettingsController,
  PerformanceController,
  ErrorTrackingController,
  JobQueueController,
} from './controllers';

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
