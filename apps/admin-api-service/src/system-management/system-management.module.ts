import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

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
  PerformanceMetric,
  PerformanceSnapshot,
  ErrorOccurrence,
  ErrorGroup,
  ErrorAlertRule,
  BackgroundJob,
  JobExecutionLog,
  JobQueue,
} from './entities';
import { ErrorCaptureProjectionHandler } from './handlers/error-capture-projection.handler';
import {
  GlobalSettingsService,
  PerformanceMonitoringService,
  ErrorTrackingService,
  JobQueueService,
} from './services';

@Module({
  imports: [
    ScheduleModule,
    TypeOrmModule.forFeature([
      // Global Settings
      FeatureToggle,
      MaintenanceMode,
      SystemVersion,
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
    // ADMIN-HIGH-014: the sink for `events.*.ServiceErrorCaptured`. A PROVIDER,
    // not a controller — EventHandlerRegistryModule discovers @SubscribeTo over
    // DiscoveryService.getProviders().
    ErrorCaptureProjectionHandler,
  ],
  exports: [
    GlobalSettingsService,
    PerformanceMonitoringService,
    ErrorTrackingService,
    JobQueueService,
  ],
})
export class SystemManagementModule {}
