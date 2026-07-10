/**
 * Create FeedingRecord DTO
 * @module Feeding/DTO
 */
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsUUID,
  IsDateString,
  IsObject,
  Min,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';
import {
  FeedingMethod,
  FishAppetite,
} from '../entities/feeding-record.entity';

/**
 * Feeding environment input
 */
@InputType()
export class FeedingEnvironmentInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(-5)
  @Max(45)
  waterTemp?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  dissolvedOxygen?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  weather?: 'sunny' | 'cloudy' | 'rainy' | 'stormy';

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  windLevel?: 'calm' | 'light' | 'moderate' | 'strong';

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  visibility?: 'clear' | 'turbid' | 'very_turbid';
}

/**
 * Fish behavior input
 */
@InputType()
export class FishBehaviorInput {
  @Field(() => FishAppetite)
  @IsNotEmpty()
  @IsEnum(FishAppetite)
  appetite!: FishAppetite;

  @Field(() => Int)
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  @Max(10)
  feedingIntensity!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  surfaceActivity?: 'normal' | 'high' | 'low' | 'none';

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  schoolingBehavior?: 'normal' | 'scattered' | 'tight';

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  abnormalBehavior?: string;
}

/**
 * Create feeding record input
 */
@InputType()
export class CreateFeedingRecordInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  batchId!: string;

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

  @Field()
  @IsNotEmpty()
  @IsDateString()
  feedingDate!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(10)
  feedingTime!: string;

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  feedingSequence?: number;

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  totalMealsToday?: number;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  feedBatchNumber?: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  plannedAmount!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  actualAmount!: number;

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

  @Field(() => FeedingMethod, { defaultValue: FeedingMethod.MANUAL })
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

  @Field({ nullable: true, defaultValue: 'TRY' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  fedBy!: string;

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
