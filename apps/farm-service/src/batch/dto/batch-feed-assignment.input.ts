/**
 * GraphQL Input Types for Batch Feed Assignment
 */
import { InputType, Field, ID, Float, Int } from '@nestjs/graphql';

/**
 * Single feed assignment entry with weight range
 */
@InputType()
export class FeedAssignmentEntryInput {
  @Field(() => ID, { description: 'Feed ID' })
  feedId: string;

  @Field({ description: 'Feed code (for display)' })
  feedCode: string;

  @Field({ description: 'Feed name (for display)' })
  feedName: string;

  @Field(() => Float, { description: 'Minimum fish weight in grams' })
  minWeightG: number;

  @Field(() => Float, { description: 'Maximum fish weight in grams' })
  maxWeightG: number;

  @Field(() => Int, { description: 'Priority for overlapping ranges (lower = higher priority)', defaultValue: 1 })
  priority?: number;
}

/**
 * Input for assigning feeds to a batch
 */
@InputType()
export class AssignFeedsToBatchInput {
  @Field(() => ID, { description: 'Batch ID to assign feeds to' })
  batchId: string;

  @Field(() => [FeedAssignmentEntryInput], { description: 'List of feed assignments with weight ranges' })
  feedAssignments: FeedAssignmentEntryInput[];

  @Field({ nullable: true, description: 'Optional notes' })
  notes?: string;
}

/**
 * Input for updating feed assignments
 */
@InputType()
export class UpdateBatchFeedAssignmentInput {
  @Field(() => ID, { description: 'Feed assignment ID to update' })
  id: string;

  @Field(() => [FeedAssignmentEntryInput], { nullable: true, description: 'New list of feed assignments' })
  feedAssignments?: FeedAssignmentEntryInput[];

  @Field({ nullable: true, description: 'Notes' })
  notes?: string;

  @Field({ nullable: true, description: 'Active status' })
  isActive?: boolean;
}
