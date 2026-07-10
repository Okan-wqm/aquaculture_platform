/**
 * Create FeedingTable DTO
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
  IsBoolean,
  IsArray,
  Min,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';
import {
  FeedingTableStatus,
  CalculationMethod,
} from '../entities/feeding-table.entity';

/**
 * Base data input for feeding table calculation
 */
@InputType()
export class FeedingTableBaseDataInput {
  @Field()
  @IsNotEmpty()
  @IsDateString()
  startDate!: string;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  endDate!: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0.1)
  startWeight!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0.1)
  targetWeight!: number;

  @Field(() => Int)
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  currentQuantity!: number;

  @Field(() => Float, { defaultValue: 5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  estimatedMortalityPercent?: number;
}

/**
 * Environmental factors input
 */
@InputType()
export class EnvironmentalFactorsInput {
  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(40)
  avgWaterTemp!: number;

  @Field(() => Float, { defaultValue: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(2)
  tempAdjustmentFactor?: number;
}

/**
 * Feeding table parameters input
 */
@InputType()
export class FeedingTableParametersInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedId!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  feedName!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  feedCode!: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0.1)
  @Max(5)
  targetFCR!: number;

  @Field(() => FeedingTableBaseDataInput)
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => FeedingTableBaseDataInput)
  baseData!: FeedingTableBaseDataInput;

  @Field(() => EnvironmentalFactorsInput)
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => EnvironmentalFactorsInput)
  environmentalFactors!: EnvironmentalFactorsInput;

  @Field(() => CalculationMethod, { defaultValue: CalculationMethod.FCR_BASED })
  @IsOptional()
  @IsEnum(CalculationMethod)
  calculationMethod?: CalculationMethod;
}

/**
 * Schedule entry input for manual feeding tables
 * NOTE: Renamed from FeedingScheduleEntryInput to avoid GraphQL Federation conflict
 */
@InputType('FeedingTableScheduleEntryInput')
export class FeedingTableScheduleEntryInput {
  @Field(() => Int)
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  day!: number;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  date!: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  estimatedQuantity!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  estimatedAvgWeight!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  estimatedBiomass!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  feedAmount!: number;

  @Field(() => Int, { defaultValue: 2 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  feedingFrequency?: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  perFeedingAmount!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(20)
  feedingRatePercent!: number;

  @Field(() => Float, { defaultValue: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cumulativeFeed?: number;

  @Field(() => Float, { defaultValue: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cumulativeGrowth?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  dailyFCR?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cumulativeFCR?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * Feeding table summary input
 */
@InputType()
export class FeedingTableSummaryInput {
  @Field(() => Int)
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  totalDays!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  totalFeedRequired!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  totalGrowthExpected!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  avgDailyGrowth!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  avgDailyFeed!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  estimatedFinalFCR!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedCost?: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  estimatedFinalWeight!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  estimatedFinalBiomass!: number;
}

/**
 * Create feeding table input
 */
@InputType()
export class CreateFeedingTableInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  batchId!: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedId!: string;

  @Field(() => FeedingTableParametersInput)
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => FeedingTableParametersInput)
  parameters!: FeedingTableParametersInput;

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

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0.1)
  @Max(5)
  targetFCR!: number;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  startDate!: string;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  endDate!: string;

  @Field(() => FeedingTableStatus, { defaultValue: FeedingTableStatus.DRAFT })
  @IsOptional()
  @IsEnum(FeedingTableStatus)
  status?: FeedingTableStatus;

  @Field(() => Boolean, { defaultValue: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  calculatedBy!: string;
}

/**
 * Generate feeding table input (auto-calculate)
 */
@InputType()
export class GenerateFeedingTableInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  batchId!: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedId!: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0.1)
  @Max(5)
  targetFCR!: number;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  startDate!: string;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  endDate!: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0.1)
  startWeight!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0.1)
  targetWeight!: number;

  @Field(() => Int)
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  currentQuantity!: number;

  @Field(() => Float, { defaultValue: 5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  estimatedMortalityPercent?: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(40)
  avgWaterTemp!: number;

  @Field(() => CalculationMethod, { defaultValue: CalculationMethod.FCR_BASED })
  @IsOptional()
  @IsEnum(CalculationMethod)
  calculationMethod?: CalculationMethod;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  calculatedBy!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
