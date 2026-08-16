import { ServiceMetricsModule } from '@aquaculture/backend-common/metrics';
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { FEEDING_CLOCK_PORT, FEEDING_CLOCK_PROVIDER } from './feeding-clock.port';
import { FEEDING_OPERATION_TARGET_COMPILER_PROVIDER } from './feeding-operation-target-compiler.service';
import { FEEDING_SCHEDULE_DISPATCH_PROVIDER } from './feeding-schedule-dispatch.repository';
import { FeedingScheduleIngressService } from './feeding-schedule-ingress.service';
import { FeedingSchedulerHealthController } from './feeding-scheduler-health.controller';
import { FeedingSchedulerTelemetryService } from './feeding-scheduler-telemetry.service';
import { FeedingSchedulerApplicationModule } from './scheduler-application-authority';
import { FeedingSchedulerRuntimeAuthority } from './scheduler-runtime.authority';

@FeedingSchedulerApplicationModule('scheduler-runtime', [
  FEEDING_OPERATION_TARGET_COMPILER_PROVIDER.provide,
  FEEDING_SCHEDULE_DISPATCH_PROVIDER.provide,
  FEEDING_CLOCK_PORT,
  FeedingScheduleIngressService,
  FeedingSchedulerTelemetryService,
  FeedingSchedulerRuntimeAuthority,
])
@Module({
  imports: [DiscoveryModule, ServiceMetricsModule],
  controllers: [FeedingSchedulerHealthController],
  providers: [
    FEEDING_OPERATION_TARGET_COMPILER_PROVIDER,
    FEEDING_SCHEDULE_DISPATCH_PROVIDER,
    FEEDING_CLOCK_PROVIDER,
    FeedingScheduleIngressService,
    FeedingSchedulerTelemetryService,
    FeedingSchedulerRuntimeAuthority,
  ],
})
export class FeedingSchedulerRuntimeModule {}
