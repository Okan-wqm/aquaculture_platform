/**
 * Update FeedingRecord DTO
 * @module Feeding/DTO
 */
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsEnum,
  IsNumber,
  IsUUID,
  IsDateString,
  Min,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  FeedingMethod,
} from '../entities/feeding-record.entity';
import {
  FeedingEnvironmentInput,
  FishBehaviorInput,
} from './create-feeding-record.input';

/**
 * Update feeding record input
 */
@InputType()
export class UpdateFeedingRecordInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  batchLocationId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  feedingDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  feedingTime?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  feedingSequence?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  totalMealsToday?: number;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  feedId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  feedBatchNumber?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  plannedAmount?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  actualAmount?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  wasteAmount?: number;

  @Field(() => FeedingEnvironmentInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FeedingEnvironmentInput)
  environment?: FeedingEnvironmentInput;

  @Field(() => FishBehaviorInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FishBehaviorInput)
  fishBehavior?: FishBehaviorInput;

  @Field(() => FeedingMethod, { nullable: true })
  @IsOptional()
  @IsEnum(FeedingMethod)
  feedingMethod?: FeedingMethod;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentId?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  feedingDurationMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  feedCost?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  verifiedBy?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  verifiedAt?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  skipReason?: string;
}

/**
 * Verify feeding record input
 */
@InputType()
export class VerifyFeedingRecordInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  verificationNotes?: string;
}
