/**
 * GraphQL Input Types for Batch Feed Assignment
 */
import { InputType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  IsString,
  IsNumber,
  IsUUID,
  IsOptional,
  IsNotEmpty,
  IsBoolean,
  IsArray,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Single feed assignment entry with weight range
 */
@InputType()
export class FeedAssignmentEntryInput {
  @Field(() => ID, { description: 'Feed ID' })
  @IsUUID()
  feedId!: string;

  @Field({ description: 'Feed code (for display)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  feedCode!: string;

  @Field({ description: 'Feed name (for display)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  feedName!: string;

  @Field(() => Float, { description: 'Minimum fish weight in grams' })
  @IsNumber()
  @Min(0)
  minWeightG!: number;

  @Field(() => Float, { description: 'Maximum fish weight in grams' })
  @IsNumber()
  @Min(0)
  maxWeightG!: number;

  @Field(() => Int, { description: 'Priority for overlapping ranges (lower = higher priority)', defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  priority?: number;
}

/**
 * Input for assigning feeds to a batch
 */
@InputType()
export class AssignFeedsToBatchInput {
  @Field(() => ID, { description: 'Batch ID to assign feeds to' })
  @IsUUID()
  batchId!: string;

  @Field(() => [FeedAssignmentEntryInput], { description: 'List of feed assignments with weight ranges' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeedAssignmentEntryInput)
  feedAssignments!: FeedAssignmentEntryInput[];

  @Field({ nullable: true, description: 'Optional notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/**
 * Input for updating feed assignments
 */
@InputType()
export class UpdateBatchFeedAssignmentInput {
  @Field(() => ID, { description: 'Feed assignment ID to update' })
  @IsUUID()
  id!: string;

  @Field(() => [FeedAssignmentEntryInput], { nullable: true, description: 'New list of feed assignments' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeedAssignmentEntryInput)
  feedAssignments?: FeedAssignmentEntryInput[];

  @Field({ nullable: true, description: 'Notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @Field({ nullable: true, description: 'Active status' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
