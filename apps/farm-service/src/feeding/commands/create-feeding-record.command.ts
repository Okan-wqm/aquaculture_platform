/**
 * CreateFeedingRecordCommand
 *
 * Yeni yemleme kaydı oluşturmak için command.
 *
 * @module Feeding/Commands
 */
import { ITenantCommand } from '@platform/cqrs';
import { FeedingMethod, FeedingEnvironment, FishBehavior } from '../entities/feeding-record.entity';

/**
 * Yemleme kaydı oluşturma payload
 */
export interface CreateFeedingRecordPayload {
  batchId: string;
  tankId?: string;
  pondId?: string;
  batchLocationId?: string;

  feedingDate: Date;
  feedingTime: string;
  feedingSequence?: number;
  totalMealsToday?: number;

  feedId: string;
  feedBatchNumber?: string;

  plannedAmount: number;
  actualAmount: number;
  wasteAmount?: number;

  environment?: FeedingEnvironment;
  fishBehavior?: FishBehavior;

  feedingMethod?: FeedingMethod;
  equipmentId?: string;
  feedingDurationMinutes?: number;

  feedCost?: number;
  currency?: string;

  fedBy: string;
  notes?: string;
  skipReason?: string;
}

export class CreateFeedingRecordCommand implements ITenantCommand {
  readonly commandName = 'CreateFeedingRecordCommand';

  constructor(
    public readonly tenantId: string,
    public readonly payload: CreateFeedingRecordPayload,
    public readonly userId: string,
  ) {}
}
