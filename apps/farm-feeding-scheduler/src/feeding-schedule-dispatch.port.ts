import type { FeedingScheduledDispatchEnvelopeV1 } from '@aquaculture/feeding-contracts';

export const FEEDING_SCHEDULE_DISPATCH_PORT = Symbol('FEEDING_SCHEDULE_DISPATCH_PORT');

export type FeedingScheduleDispatchResult =
  | {
      readonly disposition: 'enqueued' | 'idempotent' | 'business_slot_preserved' | 'quarantined';
      readonly coordinate: {
        readonly kind: 'dispatch';
        readonly dispatchId: string;
      };
    }
  | {
      readonly disposition: 'already_completed' | 'already_running';
      readonly coordinate: {
        readonly kind: 'operation';
        readonly operationId: string;
      };
    };

export interface FeedingScheduleDispatchPort {
  enqueue(envelope: FeedingScheduledDispatchEnvelopeV1): Promise<FeedingScheduleDispatchResult>;
}
