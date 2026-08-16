import { Module } from '@nestjs/common';

import { FeedingWindowReadinessService } from './feeding-window-readiness.service';
import { FeedingWindowEventHandler } from './feeding-window.handler';

@Module({
  providers: [FeedingWindowReadinessService, FeedingWindowEventHandler],
  exports: [FeedingWindowReadinessService],
})
export class FeedingWindowModule {}
