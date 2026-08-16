import { Module } from '@nestjs/common';

import { FeedingOperationControlPlaneModule } from '../feeding-operation-control-plane.module';
import { FeedingScheduleDispatchConsumerService } from './feeding-schedule-dispatch-consumer.service';
import { FeedingScheduleDispatchRepository } from './feeding-schedule-dispatch.repository';

/** Bounded farm-role executor for already-admitted durable scheduler envelopes. */
@Module({
  imports: [FeedingOperationControlPlaneModule],
  providers: [FeedingScheduleDispatchRepository, FeedingScheduleDispatchConsumerService],
})
export class FeedingScheduleDispatchConsumerModule {}
