/**
 * FeedingTable Filter DTO
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
  FeedingTableStatus,
  CalculationMethod,
} from '../entities/feeding-table.entity';

/**
 * Feeding table filter input
 */
@InputType()
export class FeedingTableFilterInput {
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
  feedId?: string;

  @Field(() => [FeedingTableStatus], { nullable: true })
  @IsOptional()
  @IsEnum(FeedingTableStatus, { each: true })
  status?: FeedingTableStatus[];

  @Field(() => [CalculationMethod], { nullable: true })
  @IsOptional()
  @IsEnum(CalculationMethod, { each: true })
  calculationMethod?: CalculationMethod[];

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  startDateFrom?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  startDateTo?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  endDateFrom?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  endDateTo?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  minTargetFCR?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  maxTargetFCR?: number;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  calculatedBy?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  searchTerm?: string;
}

/**
 * Feeding table sort field enum
 */
export enum FeedingTableSortField {
  CREATED_AT = 'createdAt',
  START_DATE = 'startDate',
  END_DATE = 'endDate',
  VERSION = 'version',
  TARGET_FCR = 'targetFCR',
  STATUS = 'status',
  BATCH_ID = 'batchId',
}
