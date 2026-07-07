/**
 * Update FeedingTable DTO
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
  IsBoolean,
  IsArray,
  Min,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  FeedingTableStatus,
} from '../entities/feeding-table.entity';
import {
  FeedingTableParametersInput,
  FeedingTableScheduleEntryInput,
  FeedingTableSummaryInput,
} from './create-feeding-table.input';

/**
 * Update feeding table input
 */
@InputType()
export class UpdateFeedingTableInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  feedId?: string;

  @Field(() => FeedingTableParametersInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FeedingTableParametersInput)
  parameters?: FeedingTableParametersInput;

  @Field(() => [FeedingTableScheduleEntryInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeedingTableScheduleEntryInput)
  schedule?: FeedingTableScheduleEntryInput[];

  @Field(() => FeedingTableSummaryInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FeedingTableSummaryInput)
  summary?: FeedingTableSummaryInput;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(5)
  targetFCR?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(5)
  actualFCR?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @Field(() => FeedingTableStatus, { nullable: true })
  @IsOptional()
  @IsEnum(FeedingTableStatus)
  status?: FeedingTableStatus;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Activate feeding table input
 */
@InputType()
export class ActivateFeedingTableInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  activationNotes?: string;
}

/**
 * Supersede feeding table input
 */
@InputType()
export class SupersedeFeedingTableInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field()
  @IsString()
  @MaxLength(500)
  recalculationReason!: string;
}

/**
 * Recalculate feeding table input
 */
@InputType()
export class RecalculateFeedingTableInput {
  @Field(() => ID)
  @IsUUID()
  batchId!: string;

  @Field()
  @IsString()
  @MaxLength(500)
  recalculationReason!: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  currentAvgWeight?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  currentQuantity?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(5)
  newTargetFCR?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  newTargetWeight?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  newEndDate?: string;

  @Field(() => ID)
  @IsUUID()
  calculatedBy!: string;
}

/**
 * Update schedule entry input (for individual day updates)
 */
@InputType()
export class UpdateScheduleEntryInput {
  @Field(() => ID)
  @IsUUID()
  feedingTableId!: string;

  @Field(() => Int)
  @IsNumber()
  @Min(1)
  day!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  feedAmount?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  feedingFrequency?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
