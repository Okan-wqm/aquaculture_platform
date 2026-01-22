/**
 * GraphQL Response Types for Batch Feed Assignment
 */
import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';

/**
 * Single feed assignment entry with weight range
 */
@ObjectType()
export class FeedAssignmentEntryResponse {
  @Field(() => ID, { description: 'Feed ID' })
  feedId: string;

  @Field({ description: 'Feed code' })
  feedCode: string;

  @Field({ description: 'Feed name' })
  feedName: string;

  @Field(() => Float, { description: 'Minimum fish weight in grams' })
  minWeightG: number;

  @Field(() => Float, { description: 'Maximum fish weight in grams' })
  maxWeightG: number;

  @Field(() => Int, { description: 'Priority for overlapping ranges' })
  priority: number;
}

/**
 * Batch feed assignment response
 */
@ObjectType()
export class BatchFeedAssignmentResponse {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  tenantId: string;

  @Field(() => ID)
  batchId: string;

  @Field(() => [FeedAssignmentEntryResponse], { description: 'List of feed assignments with weight ranges' })
  feedAssignments: FeedAssignmentEntryResponse[];

  @Field({ description: 'Active status' })
  isActive: boolean;

  @Field({ nullable: true, description: 'Notes' })
  notes?: string;

  @Field({ description: 'Created at timestamp' })
  createdAt: Date;

  @Field({ description: 'Updated at timestamp' })
  updatedAt: Date;

  @Field(() => ID, { nullable: true, description: 'Created by user ID' })
  createdBy?: string;

  @Field(() => ID, { nullable: true, description: 'Updated by user ID' })
  updatedBy?: string;
}
