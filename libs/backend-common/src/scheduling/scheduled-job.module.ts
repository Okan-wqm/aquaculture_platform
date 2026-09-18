/**
 * ScheduledJobModule — registers the `ScheduledJobRunner` every
 * `@ScheduledJob()` tick routes through (ADMIN-HIGH-013).
 *
 * One line in the host service's AppModule:
 *
 *   ScheduledJobModule.forRoot({ serviceName: 'admin-api-service' })
 *
 * Global, because the runner is injected into whichever feature module hosts
 * the scheduled method. The runner depends on the TypeORM root `DataSource`
 * (the advisory lock) and on `CronHeartbeatService` from the global
 * `ServiceMetricsModule` (the heartbeat): a service that schedules work
 * without exposing a heartbeat does not boot, which is the point.
 */
import { DynamicModule, Global, Module } from '@nestjs/common';

import {
  SCHEDULED_JOB_OPTIONS,
  ScheduledJobRunner,
  type ScheduledJobModuleOptions,
} from './scheduled-job-runner.service';

@Global()
@Module({})
export class ScheduledJobModule {
  static forRoot(options: ScheduledJobModuleOptions): DynamicModule {
    return {
      module: ScheduledJobModule,
      global: true,
      providers: [{ provide: SCHEDULED_JOB_OPTIONS, useValue: options }, ScheduledJobRunner],
      exports: [ScheduledJobRunner],
    };
  }
}
