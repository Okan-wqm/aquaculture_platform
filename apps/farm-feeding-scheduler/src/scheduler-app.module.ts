import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { FeedingSchedulerApplicationModule } from './scheduler-application-authority';
import { FeedingSchedulerDatabaseModule } from './scheduler-database.module';
import { FeedingSchedulerRuntimeModule } from './scheduler-runtime.module';

/** Worker root with operational HTTP only; no GraphQL, CQRS domain or repository modules. */
@FeedingSchedulerApplicationModule('app-root', [])
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    FeedingSchedulerDatabaseModule,
    FeedingSchedulerRuntimeModule,
  ],
})
export class FarmFeedingSchedulerAppModule {}
