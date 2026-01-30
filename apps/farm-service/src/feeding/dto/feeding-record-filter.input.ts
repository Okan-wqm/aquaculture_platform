/**
 * FeedingRecord Filter DTO
 * @module Feeding/DTO
 */
import { InputType, Field, Float, ID } from '@nestjs/graphql';
import {
  IsOptional,
  IsEnum,
  IsUUID,
  IsDateString,
  IsBoolean,
  IsString,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import {
  FeedingMethod,
  FishAppetite,
} from '../entities/feeding-record.entity';

/**
 * Feeding record filter input
 */
@InputType()
export class FeedingRecordFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field(() => [ID], { nullable: true })
  @IsOptional()
  @IsUUID('4', { each: true })
  batchIds?: string[];

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
  feedId?: string;

  @Field(() => [FeedingMethod], { nullable: true })
  @IsOptional()
  @IsEnum(FeedingMethod, { each: true })
  feedingMethod?: FeedingMethod[];

  @Field(() => [FishAppetite], { nullable: true })
  @IsOptional()
  @IsEnum(FishAppetite, { each: true })
  appetite?: FishAppetite[];

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  feedingDateFrom?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  feedingDateTo?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  feedingDate?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  fedBy?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  verifiedBy?: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  hasVariance?: boolean;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  minVariancePercent?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxVariancePercent?: number;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  hasPoorAppetite?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  searchTerm?: string;
}

/**
 * Feeding record sort field enum
 */
export enum FeedingRecordSortField {
  FEEDING_DATE = 'feedingDate',
  FEEDING_TIME = 'feedingTime',
  CREATED_AT = 'createdAt',
  ACTUAL_AMOUNT = 'actualAmount',
  VARIANCE_PERCENT = 'variancePercent',
  BATCH_ID = 'batchId',
}
