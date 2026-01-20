/**
 * UpdateFeedingRecordCommand
 *
 * Mevcut yemleme kaydını güncellemek için command.
 *
 * @module Feeding/Commands
 */
import { ITenantCommand } from '@platform/cqrs';
import { FeedingMethod, FeedingEnvironment, FishBehavior } from '../entities/feeding-record.entity';

/**
 * Yemleme kaydı güncelleme payload
 */
export interface UpdateFeedingRecordPayload {
  actualAmount?: number;
  wasteAmount?: number;
  environment?: FeedingEnvironment;
  fishBehavior?: FishBehavior;
  feedingMethod?: FeedingMethod;
  feedingDurationMinutes?: number;
  feedCost?: number;
  notes?: string;
  skipReason?: string;
}

export class UpdateFeedingRecordCommand implements ITenantCommand {
  readonly commandName = 'UpdateFeedingRecordCommand';

  constructor(
    public readonly tenantId: string,
    public readonly feedingRecordId: string,
    public readonly payload: UpdateFeedingRecordPayload,
    public readonly userId: string,
  ) {}
}
