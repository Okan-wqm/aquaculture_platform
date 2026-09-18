import {
  ScheduledJob,
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';

import { AnalyticsService } from './analytics.service';

@Injectable()
export class AnalyticsSnapshotScheduler {
  private readonly logger = new Logger(AnalyticsSnapshotScheduler.name);

  constructor(
    private readonly analyticsService: AnalyticsService,
    @Inject(ScheduledJobRunner) readonly scheduledJobs: ScheduledJobExecutor,
  ) {}

  @ScheduledJob({ name: 'analytics.daily-snapshot', cron: CronExpression.EVERY_DAY_AT_1AM })
  async createDailySnapshot(): Promise<void> {
    try {
      await this.analyticsService.createDailySnapshot();
    } catch (error) {
      this.logger.error(
        `Daily analytics snapshot scheduler failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
